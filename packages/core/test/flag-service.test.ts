import { beforeEach, describe, expect, it } from "vitest";
import { FlagsmithClient } from "../src/flagsmith/client.js";
import {
  FlagService,
  percentageSplitRules,
  readPercentage,
  rolloutSegmentName,
} from "../src/flagsmith/flag-service.js";
import { HttpClient } from "../src/flagsmith/http.js";
import { FakeFlagsmith } from "../src/testing/fake-flagsmith.js";

describe("FlagService", () => {
  let fake: FakeFlagsmith;
  let client: FlagsmithClient;
  let flags: FlagService;

  beforeEach(() => {
    fake = new FakeFlagsmith();
    client = new FlagsmithClient(
      new HttpClient({ baseUrl: "https://fake.flagsmith", apiKey: "k", fetch: fake.fetch }),
    );
    flags = new FlagService(client, fake.projectId);
  });

  it("creates a disabled feature once and reuses it afterwards", async () => {
    const first = await flags.ensureFeature("fg_new_checkout", "New checkout flow");
    const second = await flags.ensureFeature("fg_new_checkout", "New checkout flow");

    expect(first.created).toBe(true);
    expect(first.feature.default_enabled).toBe(false);
    expect(second).toEqual({ feature: first.feature, created: false });
    expect(fake.features).toHaveLength(1);
  });

  it("does not confuse substring matches with the requested feature", async () => {
    await flags.ensureFeature("fg_checkout_v2", "v2");
    const { created } = await flags.ensureFeature("fg_checkout", "v1");
    expect(created).toBe(true);
  });

  it("rolls out gradually through a feature-specific percentage segment", async () => {
    const prod = fake.environment("Production");
    const { feature } = await flags.ensureFeature("fg_new_checkout", "x");

    const at5 = await flags.setRolloutPercentage(prod, feature.id, 5);
    expect(at5).toMatchObject({ percentage: 5, enabledForAll: false });
    expect(fake.segments).toHaveLength(1);
    expect(fake.segments[0]).toMatchObject({
      name: "flagguard-rollout-production",
      feature: feature.id,
    });

    const at25 = await flags.setRolloutPercentage(prod, feature.id, 25);
    expect(at25.percentage).toBe(25);
    expect(fake.segments).toHaveLength(1); // segment is updated, not duplicated

    const at100 = await flags.setRolloutPercentage(prod, feature.id, 100);
    expect(at100).toMatchObject({ percentage: 100, enabledForAll: true });

    expect(await flags.getRolloutState(prod, feature.id)).toEqual(at100);
  });

  it("keeps segment overrides it does not own", async () => {
    const prod = fake.environment("Production");
    const { feature } = await flags.ensureFeature("fg_new_checkout", "x");
    fake.state(prod.api_key, feature.id).segment_overrides.push({
      segment: { id: 1 },
      priority: 0,
      enabled: true,
      value: null,
    });

    await flags.setRolloutPercentage(prod, feature.id, 5);

    const overrides = fake.state(prod.api_key, feature.id).segment_overrides;
    expect(overrides).toHaveLength(2);
    expect(overrides[0]).toMatchObject({ segment: { id: 1 }, priority: 0, enabled: true });
    expect(overrides[1]).toMatchObject({ priority: 1, enabled: true });
  });

  it("kill switch turns everything off, including overrides, and is idempotent", async () => {
    const prod = fake.environment("Production");
    const { feature } = await flags.ensureFeature("fg_new_checkout", "x");
    await flags.setRolloutPercentage(prod, feature.id, 25);

    const killed = await flags.kill(prod, feature.id);
    expect(killed).toMatchObject({ percentage: 0, enabledForAll: false });
    expect(fake.state(prod.api_key, feature.id).segment_overrides.every((o) => !o.enabled)).toBe(
      true,
    );

    await expect(flags.kill(prod, feature.id)).resolves.toMatchObject({ percentage: 0 });
  });

  it("isolates rollouts per environment", async () => {
    const { feature } = await flags.ensureFeature("fg_new_checkout", "x");
    await flags.setEnabledForAll(fake.environment("Development"), feature.id, true);
    await flags.setRolloutPercentage(fake.environment("Production"), feature.id, 5);

    expect(
      (await flags.getRolloutState(fake.environment("Development"), feature.id)).percentage,
    ).toBe(100);
    expect((await flags.getRolloutState(fake.environment("Staging"), feature.id)).percentage).toBe(
      0,
    );
    expect(
      (await flags.getRolloutState(fake.environment("Production"), feature.id)).percentage,
    ).toBe(5);
  });

  it("rejects invalid percentages before touching Flagsmith", async () => {
    const prod = fake.environment("Production");
    const before = fake.requests.length;
    await expect(flags.setRolloutPercentage(prod, 1, 101)).rejects.toThrow(RangeError);
    await expect(flags.setRolloutPercentage(prod, 1, 2.5)).rejects.toThrow(RangeError);
    expect(fake.requests).toHaveLength(before);
  });
});

describe("segment helpers", () => {
  it("round-trips the percentage through segment rules", () => {
    expect(readPercentage({ rules: percentageSplitRules(37) })).toBe(37);
    expect(readPercentage({ rules: [] })).toBeNull();
  });

  it("derives a stable, slugged segment name per environment", () => {
    expect(rolloutSegmentName({ name: "Production EU (west)" })).toBe(
      "flagguard-rollout-production-eu-west",
    );
  });
});

describe("FlagsmithClient", () => {
  it("raises a helpful error for unknown environments", async () => {
    const fake = new FakeFlagsmith({ environments: ["Development"] });
    const client = new FlagsmithClient(
      new HttpClient({ baseUrl: "https://fake.flagsmith", apiKey: "k", fetch: fake.fetch }),
    );
    await expect(client.requireEnvironment(fake.projectId, "Prod")).rejects.toThrow(
      /Available: Development/,
    );
  });

  it("follows pagination links", async () => {
    const pages = [
      {
        count: 2,
        next: "https://fake.flagsmith/api/v1/environments/?page=2",
        previous: null,
        results: [{ id: 1 }],
      },
      { count: 2, next: null, previous: null, results: [{ id: 2 }] },
    ];
    let call = 0;
    const client = new FlagsmithClient(
      new HttpClient({
        baseUrl: "https://fake.flagsmith",
        apiKey: "k",
        fetch: () => Promise.resolve(new Response(JSON.stringify(pages[call++]))),
      }),
    );
    expect(await client.listEnvironments(1)).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
