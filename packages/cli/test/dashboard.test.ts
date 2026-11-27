import {
  MemoryAuditLog,
  MemoryFlagBackend,
  MemoryStateStore,
  parsePolicy,
  RolloutEngine,
  silentLogger,
} from "@flagguard/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "../src/context.js";
import { startDashboard } from "../src/dashboard/server.js";

const FLAG = "fg_new_checkout";

describe("dashboard server", () => {
  let url: string;
  let close: () => Promise<void>;
  let backend: MemoryFlagBackend;

  beforeEach(async () => {
    backend = new MemoryFlagBackend();
    const policy = parsePolicy({ version: 1, rollout: { minStageMinutes: 0 } });
    const audit = new MemoryAuditLog();
    const engine = new RolloutEngine({ policy, backend, audit, state: new MemoryStateStore() });
    await engine.createFlag(FLAG, "New checkout");
    const ctx: Context = {
      cwd: ".",
      envFile: null,
      loaded: { policy, path: null },
      backend,
      engine,
      audit,
      metricsUrl: undefined,
      stateDir: ".flagguard",
      logger: silentLogger,
    };
    const dashboard = await startDashboard(ctx, { port: 0, logger: silentLogger });
    url = dashboard.url;
    close = dashboard.close;
  });

  afterEach(async () => {
    await close();
  });

  const post = (body: unknown, headers: Record<string, string> = { "X-FlagGuard-Request": "1" }) =>
    fetch(`${url}/api/flags/${FLAG}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("serves the UI with a restrictive content security policy", async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>FlagGuard</title>");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("lists flags with their state in every environment", async () => {
    const state = (await (await fetch(`${url}/api/state`)).json()) as {
      watching: boolean;
      flags: { flag: string; records: { environment: string; percentage: number }[] }[];
      policy: { stages: number[] };
    };
    expect(state.watching).toBe(false);
    expect(state.policy.stages).toEqual([5, 25, 50, 100]);
    expect(state.flags.map((f) => f.flag)).toEqual([FLAG]);
    expect(state.flags[0]?.records.map((r) => [r.environment, r.percentage])).toEqual([
      ["Development", 100],
      ["Staging", 100],
      ["Production", 0],
    ]);
  });

  it("returns flag detail with the activity log, newest first", async () => {
    const detail = (await (await fetch(`${url}/api/flags/${FLAG}`)).json()) as {
      events: { action: string }[];
      series: unknown[];
      verdict: unknown;
    };
    expect(detail.events[0]?.action).toBe("create_flag"); // logged last by createFlag
    expect(detail.events.at(-1)?.action).toBe("enable_in_non_production");
    expect(detail.series).toEqual([]);
    expect(detail.verdict).toBeNull();
  });

  it("rejects state changes without the anti-CSRF header", async () => {
    const res = await post({ action: "kill" }, {});
    expect(res.status).toBe(403);
    expect(await backend.getPercentage("Development", FLAG)).toBe(100);
  });

  it("runs the propose → approve flow and records the human approver", async () => {
    const proposed = (await (await post({ action: "propose" })).json()) as { outcome: string };
    expect(proposed.outcome).toBe("pending_approval");

    const approved = (await (await post({ action: "approve", actor: "alice" })).json()) as {
      outcome: string;
    };
    expect(approved.outcome).toBe("applied");
    expect(await backend.getPercentage("Production", FLAG)).toBe(5);

    const detail = (await (await fetch(`${url}/api/flags/${FLAG}`)).json()) as {
      events: { action: string; actor: string }[];
    };
    expect(detail.events.some((e) => e.action === "approve" && e.actor === "human:alice")).toBe(
      true,
    );
  });

  it("validates action payloads", async () => {
    expect((await post({ action: "deploy-everything" })).status).toBe(400);
    expect((await post({ action: "kill", actor: "x".repeat(100) })).status).toBe(400);
  });

  it("returns 404 for unknown routes", async () => {
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
  });
});

describe("dashboard concurrency", () => {
  it("applies a double-clicked approval only once", async () => {
    const backend = new MemoryFlagBackend();
    const policy = parsePolicy({ version: 1, rollout: { minStageMinutes: 0 } });
    const audit = new MemoryAuditLog();
    const engine = new RolloutEngine({ policy, backend, audit, state: new MemoryStateStore() });
    await engine.createFlag(FLAG, "x");
    await engine.advance(FLAG, "Production", "agent");
    const ctx: Context = {
      cwd: ".",
      envFile: null,
      loaded: { policy, path: null },
      backend,
      engine,
      audit,
      metricsUrl: undefined,
      stateDir: ".flagguard",
      logger: silentLogger,
    };
    const dashboard = await startDashboard(ctx, { port: 0, logger: silentLogger });
    try {
      const approve = () =>
        fetch(`${dashboard.url}/api/flags/${FLAG}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-FlagGuard-Request": "1" },
          body: JSON.stringify({ action: "approve", actor: "alice" }),
        }).then((r) => r.json() as Promise<{ outcome: string }>);

      const outcomes = (await Promise.all([approve(), approve(), approve()])).map((r) => r.outcome);
      expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
      expect(await backend.getPercentage("Production", FLAG)).toBe(5);
      const applied = (await audit.list()).filter(
        (e) => e.action === "start_rollout" && e.outcome === "applied",
      );
      expect(applied).toHaveLength(1);
    } finally {
      await dashboard.close();
    }
  });
});
