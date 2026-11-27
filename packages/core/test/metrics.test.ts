import { describe, expect, it } from "vitest";
import { percentile, SlidingWindowMetrics, summarize } from "../src/metrics/metrics.js";

describe("percentile", () => {
  it("uses nearest-rank on sorted input", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("summarize", () => {
  it("computes error rate and latency percentiles", () => {
    const stats = summarize([
      { ok: true, latencyMs: 10 },
      { ok: false, latencyMs: 30 },
      { ok: true, latencyMs: 20 },
      { ok: true, latencyMs: 40 },
    ]);
    expect(stats).toEqual({
      requests: 4,
      errors: 1,
      errorRate: 0.25,
      p50LatencyMs: 20,
      p95LatencyMs: 40,
    });
  });

  it("returns zeros for an empty cohort", () => {
    expect(summarize([])).toMatchObject({ requests: 0, errorRate: 0, p95LatencyMs: 0 });
  });
});

describe("SlidingWindowMetrics", () => {
  it("separates cohorts and flags", () => {
    const metrics = new SlidingWindowMetrics({ now: () => 1_000 });
    metrics.record("a", { cohort: "control", ok: true, latencyMs: 5 });
    metrics.record("a", { cohort: "treatment", ok: false, latencyMs: 50 });
    metrics.record("b", { cohort: "treatment", ok: true, latencyMs: 1 });

    const a = metrics.snapshot("a");
    expect(a.control).toMatchObject({ requests: 1, errors: 0 });
    expect(a.treatment).toMatchObject({ requests: 1, errors: 1, errorRate: 1 });
    expect(metrics.flags().sort()).toEqual(["a", "b"]);
  });

  it("forgets samples older than the window", () => {
    let now = 0;
    const metrics = new SlidingWindowMetrics({ windowMs: 1_000, now: () => now });
    metrics.record("a", { cohort: "treatment", ok: false, latencyMs: 1 });
    now = 500;
    metrics.record("a", { cohort: "treatment", ok: true, latencyMs: 1 });

    expect(metrics.snapshot("a").treatment.requests).toBe(2);
    now = 1_200;
    expect(metrics.snapshot("a").treatment).toMatchObject({ requests: 1, errors: 0 });
    now = 5_000;
    expect(metrics.snapshot("a").treatment.requests).toBe(0);
  });

  it("caps memory per flag", () => {
    const metrics = new SlidingWindowMetrics({ maxSamplesPerFlag: 10, now: () => 0 });
    for (let i = 0; i < 25; i++) metrics.record("a", { cohort: "control", ok: true, latencyMs: i });
    const { control } = metrics.snapshot("a");
    expect(control.requests).toBe(10);
    expect(control.p50LatencyMs).toBeGreaterThanOrEqual(15); // oldest samples were dropped
  });

  it("resets one flag or everything", () => {
    const metrics = new SlidingWindowMetrics();
    metrics.record("a", { cohort: "control", ok: true, latencyMs: 1 });
    metrics.record("b", { cohort: "control", ok: true, latencyMs: 1 });
    metrics.reset("a");
    expect(metrics.flags()).toEqual(["b"]);
    metrics.reset();
    expect(metrics.flags()).toEqual([]);
  });
});
