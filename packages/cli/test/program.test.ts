import {
  type FlagMetricsSnapshot,
  MemoryAuditLog,
  MemoryFlagBackend,
  MemoryStateStore,
  type MetricsSource,
  parsePolicy,
  RolloutEngine,
  silentLogger,
} from "@flagguard/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "../src/context.js";
import { createProgram, EXIT } from "../src/program.js";

const FLAG = "fg_new_checkout";

class SwitchableMetrics implements MetricsSource {
  broken = false;
  snapshot(flag: string): Promise<FlagMetricsSnapshot> {
    const errorRate = this.broken ? 0.4 : 0;
    return Promise.resolve({
      flag,
      windowMs: 120_000,
      generatedAt: "",
      treatment: {
        requests: 200,
        errors: errorRate * 200,
        errorRate,
        p50LatencyMs: 40,
        p95LatencyMs: 60,
      },
      control: { requests: 600, errors: 0, errorRate: 0, p50LatencyMs: 80, p95LatencyMs: 100 },
    });
  }
}

describe("flagguard CLI", () => {
  let out: string[];
  let err: string[];
  let backend: MemoryFlagBackend;
  let metrics: SwitchableMetrics;
  let ctx: Context;

  const cli = async (...args: string[]): Promise<number> => {
    process.exitCode = 0;
    const program = createProgram({ out: (s) => out.push(s), err: (s) => err.push(s) }, () =>
      Promise.resolve(ctx),
    ).exitOverride();
    await program.parseAsync(["node", "flagguard", ...args]);
    return process.exitCode;
  };
  const text = (): string => out.join("\n");

  beforeEach(() => {
    out = [];
    err = [];
    backend = new MemoryFlagBackend();
    metrics = new SwitchableMetrics();
    const policy = parsePolicy({ version: 1, rollout: { minStageMinutes: 0 } });
    const audit = new MemoryAuditLog();
    ctx = {
      cwd: ".",
      envFile: null,
      loaded: { policy, path: null },
      backend,
      audit,
      metricsUrl: "http://shop.test",
      stateDir: ".flagguard",
      logger: silentLogger,
      engine: new RolloutEngine({ policy, backend, audit, metrics, state: new MemoryStateStore() }),
    };
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it("runs the full human-in-the-loop flow", async () => {
    expect(await cli("flag", "create", FLAG, "-d", "New checkout")).toBe(EXIT.ok);
    expect(await backend.getPercentage("Development", FLAG)).toBe(100);

    await cli("propose", FLAG);
    expect(text()).toMatch(/pending approval/);
    expect(text()).toMatch(/flagguard approve fg_new_checkout --env Production/);

    out = [];
    await cli("approvals");
    expect(text()).toMatch(/Start rollout of fg_new_checkout in Production at 5%/);

    await cli("approve", FLAG, "--as", "alice");
    expect(await backend.getPercentage("Production", FLAG)).toBe(5);

    out = [];
    await cli("status", FLAG);
    expect(text()).toMatch(/Production.*5%.*in progress/);

    out = [];
    await cli("audit", FLAG);
    expect(text()).toMatch(/alice/);
    expect(text()).toMatch(/start_rollout/);
  });

  it("watch --once pulls the kill switch on a regression", async () => {
    await cli("flag", "create", FLAG);
    await cli("advance", FLAG, "--as", "alice");
    metrics.broken = true;

    out = [];
    expect(await cli("watch", FLAG, "--once")).toBe(EXIT.ok);
    expect(text()).toMatch(/KILL SWITCH PULLED/);
    expect(await backend.getPercentage("Production", FLAG)).toBe(0);
  });

  it("watch --propose asks for the next stage while healthy", async () => {
    await cli("flag", "create", FLAG);
    await cli("advance", FLAG, "--as", "alice");
    out = [];
    await cli("watch", FLAG, "--once", "--propose");
    expect(text()).toMatch(/healthy/);
    expect(text()).toMatch(/Advance fg_new_checkout in Production from 5% to 25%/);
  });

  it("exits with the blocked code when a gate refuses", async () => {
    await cli("flag", "create", FLAG);
    await cli("advance", FLAG, "--as", "alice");
    metrics.broken = true;
    expect(await cli("advance", FLAG, "--as", "alice", "--force")).toBe(EXIT.blocked);
    expect(text()).toMatch(/unhealthy/);
  });

  it("emits JSON with --json", async () => {
    await cli("flag", "create", FLAG);
    out = [];
    await cli("--json", "status", FLAG);
    const records = JSON.parse(text()) as { environment: string; percentage: number }[];
    expect(records.map((r) => [r.environment, r.percentage])).toEqual([
      ["Development", 100],
      ["Staging", 100],
      ["Production", 0],
    ]);
  });

  it("reports errors without a stack trace", async () => {
    expect(await cli("advance", FLAG, "--env", "Mars")).toBe(EXIT.usage);
    expect(err.join("\n")).toMatch(/Environment "Mars" is not in flagguard.yml/);
  });
});
