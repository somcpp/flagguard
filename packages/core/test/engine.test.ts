import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FileAuditLog, human, MemoryAuditLog } from "../src/audit/audit-log.js";
import { FlagsmithClient } from "../src/flagsmith/client.js";
import { FlagService } from "../src/flagsmith/flag-service.js";
import { HttpClient } from "../src/flagsmith/http.js";
import type { CohortStats, FlagMetricsSnapshot } from "../src/metrics/metrics.js";
import type { MetricsSource } from "../src/metrics/source.js";
import { parsePolicy } from "../src/policy/load.js";
import type { PolicyInput } from "../src/policy/schema.js";
import { FlagsmithBackend, MemoryFlagBackend } from "../src/rollout/backend.js";
import { RolloutEngine } from "../src/rollout/engine.js";
import { FileStateStore, MemoryStateStore } from "../src/rollout/state.js";
import { FakeFlagsmith } from "../src/testing/fake-flagsmith.js";

const FLAG = "fg_new_checkout";
const PROD = "Production";
const alice = human("alice");

class FakeMetrics implements MetricsSource {
  treatment: CohortStats = {
    requests: 200,
    errors: 0,
    errorRate: 0,
    p50LatencyMs: 40,
    p95LatencyMs: 60,
  };
  control: CohortStats = {
    requests: 600,
    errors: 0,
    errorRate: 0,
    p50LatencyMs: 80,
    p95LatencyMs: 100,
  };

  breakNewCode(): void {
    this.treatment = { ...this.treatment, errors: 60, errorRate: 0.3 };
  }

  snapshot(flag: string): Promise<FlagMetricsSnapshot> {
    return Promise.resolve({
      flag,
      windowMs: 120_000,
      generatedAt: "",
      treatment: this.treatment,
      control: this.control,
    });
  }
}

function setup(policyInput: Partial<PolicyInput> = {}) {
  let now = new Date("2026-11-28T10:00:00Z");
  const backend = new MemoryFlagBackend();
  const audit = new MemoryAuditLog();
  const metrics = new FakeMetrics();
  const engine = new RolloutEngine({
    policy: parsePolicy({ version: 1, rollout: { minStageMinutes: 10 }, ...policyInput }),
    backend,
    state: new MemoryStateStore(),
    audit,
    metrics,
    clock: () => now,
  });
  const advanceClock = (minutes: number) => {
    now = new Date(now.getTime() + minutes * 60_000);
  };
  return { engine, backend, audit, metrics, advanceClock };
}

describe("RolloutEngine: creating flags", () => {
  it("creates the flag, enables it outside production, and leaves production off", async () => {
    const { engine, backend } = setup();
    const results = await engine.createFlag(FLAG, "New checkout");

    expect(results.map((r) => [r.record.environment, r.outcome])).toEqual([
      ["Development", "applied"],
      ["Staging", "applied"],
      [PROD, "noop"],
    ]);
    expect(await backend.getPercentage(PROD, FLAG)).toBe(0);
    expect(await backend.getPercentage("Development", FLAG)).toBe(100);
  });

  it("is idempotent", async () => {
    const { engine, backend } = setup();
    await engine.createFlag(FLAG, "x");
    const calls = backend.calls.length;
    const again = await engine.createFlag(FLAG, "x");
    expect(again.every((r) => r.outcome === "noop")).toBe(true);
    expect(backend.calls.length).toBe(calls + 1); // only the ensure call
  });
});

describe("RolloutEngine: the agent asks, a human approves", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await ctx.engine.createFlag(FLAG, "x");
  });

  it("agent-proposed production stages wait for approval and change nothing", async () => {
    const result = await ctx.engine.advance(FLAG, PROD, "agent");

    expect(result.outcome).toBe("pending_approval");
    expect(result.approval).toMatchObject({ action: "start_rollout", targetPercentage: 5 });
    expect(await ctx.backend.getPercentage(PROD, FLAG)).toBe(0);
    expect((await ctx.engine.pendingApprovals()).map((r) => r.flag)).toEqual([FLAG]);
  });

  it("proposing again returns the same pending approval", async () => {
    const first = await ctx.engine.advance(FLAG, PROD, "agent");
    const second = await ctx.engine.advance(FLAG, PROD, "agent");
    expect(second.approval?.id).toBe(first.approval?.id);
  });

  it("approval applies the stage and records who approved it", async () => {
    await ctx.engine.advance(FLAG, PROD, "agent");
    const result = await ctx.engine.approve(FLAG, PROD, alice);

    expect(result).toMatchObject({
      outcome: "applied",
      record: { percentage: 5, status: "in_progress" },
    });
    expect(await ctx.backend.getPercentage(PROD, FLAG)).toBe(5);
    const events = await ctx.audit.list({ flag: FLAG, environment: PROD });
    expect(events.map((e) => [e.action, e.actor, e.outcome])).toEqual([
      ["create_flag", "agent", "applied"],
      ["start_rollout", "agent", "pending_approval"],
      ["approve", "human:alice", "applied"],
      ["start_rollout", "human:alice", "applied"],
    ]);
  });

  it("rejection clears the request without touching the flag", async () => {
    await ctx.engine.advance(FLAG, PROD, "agent");
    const result = await ctx.engine.reject(FLAG, PROD, alice, "not during the sale");
    expect(result.message).toMatch(/not during the sale/);
    expect((await ctx.engine.pendingApprovals()).length).toBe(0);
    expect(await ctx.backend.getPercentage(PROD, FLAG)).toBe(0);
  });

  it("a human running advance directly counts as the approval", async () => {
    const result = await ctx.engine.advance(FLAG, PROD, alice);
    expect(result.outcome).toBe("applied");
    expect(await ctx.backend.getPercentage(PROD, FLAG)).toBe(5);
  });

  it("walks every stage to 100% and then reports completion", async () => {
    for (const expected of [5, 25, 50, 100]) {
      await ctx.engine.advance(FLAG, PROD, "agent");
      const result = await ctx.engine.approve(FLAG, PROD, alice);
      expect(result.record.percentage).toBe(expected);
      ctx.advanceClock(10);
    }
    const done = await ctx.engine.advance(FLAG, PROD, "agent");
    expect(done.outcome).toBe("noop");
    expect((await ctx.engine.status(FLAG)).find((r) => r.environment === PROD)?.status).toBe(
      "completed",
    );
  });
});

describe("RolloutEngine: gates", () => {
  it("enforces the minimum stage duration unless forced", async () => {
    const { engine, advanceClock } = setup();
    await engine.createFlag(FLAG, "x");
    await engine.advance(FLAG, PROD, alice);

    const early = await engine.advance(FLAG, PROD, alice);
    expect(early).toMatchObject({ outcome: "blocked" });
    expect(early.message).toMatch(/must run 10 min .* \(10 min left\)/);

    advanceClock(4);
    expect((await engine.advance(FLAG, PROD, alice)).message).toMatch(/6 min left/);
    expect((await engine.advance(FLAG, PROD, alice, { force: true })).outcome).toBe("applied");
  });

  it("refuses to advance an unhealthy rollout, even when forced", async () => {
    const { engine, metrics, advanceClock } = setup();
    await engine.createFlag(FLAG, "x");
    await engine.advance(FLAG, PROD, alice);
    advanceClock(15);
    metrics.breakNewCode();

    const result = await engine.advance(FLAG, PROD, alice, { force: true });
    expect(result.outcome).toBe("blocked");
    expect(result.message).toMatch(/unhealthy/);
  });

  it("re-checks health at approval time", async () => {
    const { engine, metrics, backend, advanceClock } = setup();
    await engine.createFlag(FLAG, "x");
    await engine.advance(FLAG, PROD, alice);
    advanceClock(15);
    await engine.advance(FLAG, PROD, "agent"); // healthy now: proposes 25%
    metrics.breakNewCode(); // ...then it breaks before anyone approves

    const result = await engine.approve(FLAG, PROD, alice);
    expect(result.outcome).toBe("blocked");
    expect(await backend.getPercentage(PROD, FLAG)).toBe(5);
    expect(result.record.pendingApproval).toBeNull();
  });
});

describe("RolloutEngine: watcher and kill switch", () => {
  it("kills an unhealthy rollout on its own and explains why", async () => {
    const { engine, metrics, backend, audit } = setup();
    await engine.createFlag(FLAG, "x");
    await engine.advance(FLAG, PROD, alice);

    expect((await engine.checkHealth(FLAG, PROD)).action).toBe("none");
    metrics.breakNewCode();
    const result = await engine.checkHealth(FLAG, PROD);

    expect(result.action).toBe("killed");
    expect(result.record.status).toBe("killed");
    expect(await backend.getPercentage(PROD, FLAG)).toBe(0);
    const kill = (await audit.list()).find((e) => e.action === "kill_flag");
    expect(kill).toMatchObject({ actor: "agent", outcome: "applied" });
    expect(kill?.reason).toMatch(/30\.0% errors on new code vs 0\.0% on old code/);
  });

  it("only logs health when the status changes", async () => {
    const { engine, audit } = setup();
    await engine.createFlag(FLAG, "x");
    await engine.advance(FLAG, PROD, alice);
    await engine.checkHealth(FLAG, PROD);
    await engine.checkHealth(FLAG, PROD);
    await engine.checkHealth(FLAG, PROD);
    expect((await audit.list()).filter((e) => e.action === "health_check")).toHaveLength(1);
  });

  it("does nothing when the flag serves nobody", async () => {
    const { engine, metrics } = setup();
    await engine.createFlag(FLAG, "x");
    metrics.breakNewCode();
    expect((await engine.checkHealth(FLAG, PROD)).action).toBe("none");
  });

  it("asks for approval instead when the policy requires it for kills", async () => {
    const { engine, metrics, backend } = setup({
      autonomy: { actions: { kill_flag: "approval" } },
    });
    await engine.createFlag(FLAG, "x");
    await engine.advance(FLAG, PROD, alice);
    metrics.breakNewCode();

    expect((await engine.checkHealth(FLAG, PROD)).action).toBe("kill_requested");
    expect((await engine.checkHealth(FLAG, PROD)).action).toBe("kill_requested");
    expect(await backend.getPercentage(PROD, FLAG)).toBe(5);
    await engine.approve(FLAG, PROD, alice);
    expect(await backend.getPercentage(PROD, FLAG)).toBe(0);
  });

  it("a human can always pull the kill switch", async () => {
    const { engine, backend } = setup({ autonomy: { actions: { kill_flag: "approval" } } });
    await engine.createFlag(FLAG, "x");
    await engine.advance(FLAG, PROD, alice);
    const result = await engine.kill(FLAG, PROD, alice, "customer reports");
    expect(result.outcome).toBe("applied");
    expect(await backend.getPercentage(PROD, FLAG)).toBe(0);
  });
});

describe("RolloutEngine: drift and environments", () => {
  it("trusts Flagsmith when the percentage was changed outside FlagGuard", async () => {
    const { engine, backend } = setup();
    await engine.createFlag(FLAG, "x");
    await backend.setPercentage(PROD, FLAG, 50);
    const prod = (await engine.status(FLAG)).find((r) => r.environment === PROD);
    expect(prod).toMatchObject({ percentage: 50, status: "in_progress" });
  });

  it("rejects environments that are not in the policy", async () => {
    const { engine } = setup();
    await expect(engine.advance(FLAG, "Prod-EU", alice)).rejects.toThrow(/not in flagguard.yml/);
  });

  it("defaults to the first production environment", () => {
    expect(setup().engine.defaultEnvironment()).toBe(PROD);
  });
});

describe("RolloutEngine + Flagsmith + file stores (integration)", () => {
  it("runs a full rollout and kill against the Flagsmith API shape, persisting to disk", async () => {
    const fake = new FakeFlagsmith();
    const client = new FlagsmithClient(
      new HttpClient({ baseUrl: "https://fake.flagsmith", apiKey: "k", fetch: fake.fetch }),
    );
    const dir = await mkdtemp(path.join(tmpdir(), "flagguard-engine-"));
    const metrics = new FakeMetrics();
    const deps = {
      policy: parsePolicy({ version: 1, rollout: { minStageMinutes: 0 } }),
      backend: new FlagsmithBackend(
        client,
        new FlagService(client, fake.projectId),
        fake.projectId,
      ),
      state: new FileStateStore(path.join(dir, "state.json")),
      audit: new FileAuditLog(path.join(dir, "audit.jsonl")),
      metrics,
    };

    await new RolloutEngine(deps).createFlag(FLAG, "New checkout");
    await new RolloutEngine(deps).advance(FLAG, PROD, "agent");
    // A separate process (new engine, same files) approves:
    await new RolloutEngine(deps).approve(FLAG, PROD, alice);

    const feature = fake.features.find((f) => f.name === FLAG)!;
    const prodKey = fake.environment(PROD).api_key;
    expect(fake.state(prodKey, feature.id).segment_overrides[0]?.enabled).toBe(true);

    metrics.breakNewCode();
    const watched = await new RolloutEngine(deps).checkHealth(FLAG, PROD);
    expect(watched.action).toBe("killed");
    expect(fake.state(prodKey, feature.id).environment_default.enabled).toBe(false);
    expect(fake.state(prodKey, feature.id).segment_overrides.every((o) => !o.enabled)).toBe(true);

    const events = await deps.audit.list({ flag: FLAG });
    expect(events.at(-1)).toMatchObject({
      action: "kill_flag",
      actor: "agent",
      outcome: "applied",
    });
  });
});
