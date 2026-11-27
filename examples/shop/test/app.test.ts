import { SlidingWindowMetrics } from "@flagguard/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { bucketOf, OfflineFlagProvider } from "../src/flags.js";

const FLAG = "fg_new_checkout";
const cart = [{ productId: "rubber-duck", quantity: 1 }];

function setup(options: { percentage?: number; adminToken?: string; random?: () => number } = {}) {
  const provider = new OfflineFlagProvider(options.percentage ?? 0);
  const metrics = new SlidingWindowMetrics();
  const app = createApp({
    flagName: FLAG,
    provider,
    metrics,
    adminToken: options.adminToken,
    checkoutDeps: { sleep: () => Promise.resolve(), random: options.random ?? (() => 0.5) },
  });
  const json = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, provider, metrics, json };
}

describe("checkout routing", () => {
  it("serves the legacy checkout when the flag is off and records the control cohort", async () => {
    const { json, metrics } = setup({ percentage: 0 });

    const res = await json("POST", "/api/checkout", { userId: "u1", items: cart });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checkout: "legacy", totalCents: 1200 });
    expect(metrics.snapshot(FLAG)).toMatchObject({
      control: { requests: 1, errors: 0 },
      treatment: { requests: 0 },
    });
  });

  it("serves the new checkout (with bundle discount) when the flag is on", async () => {
    const { json, metrics } = setup({ percentage: 100 });

    const res = await json("POST", "/api/checkout", {
      userId: "u1",
      items: [{ productId: "rubber-duck", quantity: 3 }],
    });
    expect(await res.json()).toMatchObject({ checkout: "new", totalCents: 3240 });
    expect(metrics.snapshot(FLAG).treatment.requests).toBe(1);
  });

  it("splits users consistently by percentage", async () => {
    const { json } = setup({ percentage: 30 });
    const users = Array.from({ length: 400 }, (_, i) => `user-${i}`);

    const served = await Promise.all(
      users.map(async (userId) => {
        const res = await json("POST", "/api/checkout", { userId, items: cart });
        return ((await res.json()) as { checkout: string }).checkout;
      }),
    );
    const share = served.filter((c) => c === "new").length / users.length;
    expect(share).toBeGreaterThan(0.22);
    expect(share).toBeLessThan(0.38);

    // Same user, same answer.
    for (const userId of users.slice(0, 20)) {
      expect(bucketOf(FLAG, userId) < 30).toBe(served[users.indexOf(userId)] === "new");
    }
  });

  it("rejects invalid carts without polluting health metrics", async () => {
    const { json, metrics } = setup();

    expect((await json("POST", "/api/checkout", { userId: "u1", items: [] })).status).toBe(400);
    expect(
      (
        await json("POST", "/api/checkout", {
          userId: "u1",
          items: [{ productId: "nope", quantity: 1 }],
        })
      ).status,
    ).toBe(400);
    expect((await json("POST", "/api/checkout", "not json")).status).toBe(400);
    expect(metrics.snapshot(FLAG).control.requests).toBe(0);
  });
});

describe("chaos and metrics", () => {
  it("injects failures into the new checkout only and exposes them per cohort", async () => {
    const { json } = setup({ percentage: 50, random: () => 0.1 });
    await json("PUT", "/admin/chaos", { errorRate: 0.5 });

    const newUser = Array.from({ length: 50 }, (_, i) => `u${i}`).find(
      (u) => bucketOf(FLAG, u) < 50,
    )!;
    const oldUser = Array.from({ length: 50 }, (_, i) => `u${i}`).find(
      (u) => bucketOf(FLAG, u) >= 50,
    )!;

    const failed = await json("POST", "/api/checkout", { userId: newUser, items: cart });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ checkout: "new" });
    expect((await json("POST", "/api/checkout", { userId: oldUser, items: cart })).status).toBe(
      200,
    );

    const snapshot = (await (await json("GET", `/flagguard/metrics/${FLAG}`)).json()) as {
      treatment: { errors: number; errorRate: number };
      control: { errors: number };
    };
    expect(snapshot.treatment).toMatchObject({ errors: 1, errorRate: 1 });
    expect(snapshot.control.errors).toBe(0);

    await json("DELETE", "/admin/chaos");
    expect((await json("POST", "/api/checkout", { userId: newUser, items: cart })).status).toBe(
      200,
    );
  });

  it("reports status including provider mode and chaos", async () => {
    const { json } = setup({ percentage: 5 });
    expect(await (await json("GET", "/api/status")).json()).toEqual({
      flag: FLAG,
      provider: "offline",
      offlinePercentage: 5,
      chaos: { errorRate: 0, extraLatencyMs: 0 },
    });
  });
});

describe("admin API", () => {
  it("changes the offline rollout percentage", async () => {
    const { json, provider } = setup();
    const res = await json("PUT", "/admin/offline-rollout", { percentage: 25 });
    expect(res.status).toBe(200);
    expect(provider.getPercentage(FLAG)).toBe(25);
    expect((await json("PUT", "/admin/offline-rollout", { percentage: 101 })).status).toBe(400);
  });

  it("requires the bearer token when one is configured", async () => {
    const { json } = setup({ adminToken: "s3cret" });
    expect((await json("DELETE", "/admin/chaos")).status).toBe(401);
    expect(
      (await json("DELETE", "/admin/chaos", undefined, { Authorization: "Bearer nope" })).status,
    ).toBe(401);
    expect(
      (await json("DELETE", "/admin/chaos", undefined, { Authorization: "Bearer s3cret" })).status,
    ).toBe(200);
  });
});
