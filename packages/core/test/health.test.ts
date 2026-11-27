import { describe, expect, it } from "vitest";
import { evaluateHealth } from "../src/guardrails/health.js";
import type { CohortStats, FlagMetricsSnapshot } from "../src/metrics/metrics.js";
import { defaultPolicy } from "../src/policy/load.js";

const guardrails = defaultPolicy().guardrails; // minSamples 50, max 5%, 2x errors, 1.5x latency

function cohort(requests: number, errorRate: number, p95 = 100): CohortStats {
  const errors = Math.round(requests * errorRate);
  return { requests, errors, errorRate, p50LatencyMs: p95 / 2, p95LatencyMs: p95 };
}

function snapshot(treatment: CohortStats, control: CohortStats): FlagMetricsSnapshot {
  return { flag: "f", windowMs: 120_000, generatedAt: "", treatment, control };
}

describe("evaluateHealth", () => {
  it("waits for enough traffic on the new code", () => {
    const verdict = evaluateHealth(snapshot(cohort(10, 0.5), cohort(500, 0)), guardrails);
    expect(verdict.status).toBe("insufficient_data");
    expect(verdict.summary).toMatch(/10\/50/);
  });

  it("passes when new code matches old code", () => {
    const verdict = evaluateHealth(
      snapshot(cohort(100, 0.01, 90), cohort(300, 0.01, 100)),
      guardrails,
    );
    expect(verdict.status).toBe("healthy");
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  it("flags an error-rate regression against the control cohort", () => {
    const verdict = evaluateHealth(snapshot(cohort(100, 0.04), cohort(300, 0.01)), guardrails);
    expect(verdict.status).toBe("unhealthy");
    expect(verdict.summary).toMatch(/4\.0% errors on new code vs 1\.0% on old code/);
  });

  it("flags the absolute error ceiling even without enough control traffic", () => {
    const verdict = evaluateHealth(snapshot(cohort(100, 0.2), cohort(5, 0)), guardrails);
    expect(verdict.status).toBe("unhealthy");
    expect(verdict.checks.map((c) => c.name)).toEqual(["error_rate_ceiling"]);
  });

  it("flags a p95 latency regression", () => {
    const verdict = evaluateHealth(snapshot(cohort(100, 0, 400), cohort(300, 0, 100)), guardrails);
    expect(verdict.status).toBe("unhealthy");
    expect(verdict.summary).toMatch(/p95 400ms on new code vs 100ms/);
  });

  it("ignores ratio blips below the noise floor", () => {
    // 0.4% vs 0.1% is 4x, but only 0.3 percentage points apart
    expect(
      evaluateHealth(snapshot(cohort(1000, 0.004), cohort(1000, 0.001)), guardrails).status,
    ).toBe("healthy");
    // 80ms vs 40ms is 2x, but a 40ms difference is not worth killing for (delta < 50ms)
    expect(
      evaluateHealth(snapshot(cohort(100, 0, 80), cohort(100, 0, 40)), guardrails).status,
    ).toBe("healthy");
  });

  it("does not blame the flag when both cohorts are failing equally", () => {
    const verdict = evaluateHealth(snapshot(cohort(100, 0.2), cohort(300, 0.18)), guardrails);
    expect(verdict.status).toBe("platform_degraded");
    expect(verdict.summary).toMatch(/not caused by this flag/);
  });

  it("still blames the flag when it is much worse than an already-degraded platform", () => {
    const verdict = evaluateHealth(snapshot(cohort(100, 0.5), cohort(300, 0.1)), guardrails);
    expect(verdict.status).toBe("unhealthy");
  });
});
