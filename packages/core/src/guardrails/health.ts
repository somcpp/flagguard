import type { CohortStats, FlagMetricsSnapshot } from "../metrics/metrics.js";
import type { Policy } from "../policy/schema.js";

export type Guardrails = Policy["guardrails"];

/**
 * - `healthy`: enough data, new code is within every guardrail
 * - `unhealthy`: the new code is worse than the old code; the flag is the cause
 * - `platform_degraded`: both cohorts are bad; a flag can't fix it, so don't kill
 * - `insufficient_data`: not enough traffic on the new code to judge yet
 */
export type HealthStatus = "healthy" | "unhealthy" | "platform_degraded" | "insufficient_data";

export interface GuardrailCheck {
  name: "error_rate_ceiling" | "error_rate_vs_control" | "latency_vs_control";
  passed: boolean;
  /** Human-readable explanation, e.g. "15.7% errors on new code vs 0.0% on old code (max 2x)". */
  detail: string;
}

export interface HealthVerdict {
  status: HealthStatus;
  /** One-line summary suitable for audit logs and PR comments. */
  summary: string;
  checks: GuardrailCheck[];
  treatment: CohortStats;
  control: CohortStats;
}

/** Differences smaller than these are noise, whatever the ratio says. */
const MIN_ERROR_RATE_DELTA = 0.01; // 1 percentage point
const MIN_LATENCY_DELTA_MS = 50;

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
const ms = (value: number): string => `${Math.round(value)}ms`;

/**
 * Decide whether a flagged change is safe, by comparing users on the new code
 * (treatment) with users on the old code (control) over the same window.
 *
 * Pure function: no I/O, fully deterministic, so the most consequential
 * decision the agent makes (pulling the kill switch) is exhaustively testable.
 */
export function evaluateHealth(
  snapshot: FlagMetricsSnapshot,
  guardrails: Guardrails,
): HealthVerdict {
  const { treatment, control } = snapshot;
  const base = { treatment, control };

  if (treatment.requests < guardrails.minSamples) {
    return {
      ...base,
      status: "insufficient_data",
      summary: `Waiting for data: ${treatment.requests}/${guardrails.minSamples} requests on the new code`,
      checks: [],
    };
  }

  const controlUsable = control.requests >= guardrails.minSamples;
  const checks: GuardrailCheck[] = [];

  const overCeiling = treatment.errorRate > guardrails.maxErrorRate;
  checks.push({
    name: "error_rate_ceiling",
    passed: !overCeiling,
    detail: `${pct(treatment.errorRate)} errors on new code (ceiling ${pct(guardrails.maxErrorRate)})`,
  });

  if (controlUsable) {
    const errorLimit = control.errorRate * guardrails.maxErrorRateRatio;
    const errorRegression =
      treatment.errorRate > errorLimit &&
      treatment.errorRate - control.errorRate >= MIN_ERROR_RATE_DELTA;
    checks.push({
      name: "error_rate_vs_control",
      passed: !errorRegression,
      detail: `${pct(treatment.errorRate)} errors on new code vs ${pct(control.errorRate)} on old code (max ${guardrails.maxErrorRateRatio}x)`,
    });

    const latencyLimit = control.p95LatencyMs * guardrails.maxLatencyRatio;
    const latencyRegression =
      treatment.p95LatencyMs > latencyLimit &&
      treatment.p95LatencyMs - control.p95LatencyMs >= MIN_LATENCY_DELTA_MS;
    checks.push({
      name: "latency_vs_control",
      passed: !latencyRegression,
      detail: `p95 ${ms(treatment.p95LatencyMs)} on new code vs ${ms(control.p95LatencyMs)} on old code (max ${guardrails.maxLatencyRatio}x)`,
    });
  }

  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0) {
    return { ...base, status: "healthy", summary: "New code is within all guardrails", checks };
  }

  // Only the absolute ceiling failed and the old code is just as bad: platform issue.
  const onlyCeiling = failed.every((c) => c.name === "error_rate_ceiling");
  if (onlyCeiling && controlUsable && control.errorRate > guardrails.maxErrorRate) {
    return {
      ...base,
      status: "platform_degraded",
      summary: `Both cohorts are failing (${pct(treatment.errorRate)} new vs ${pct(control.errorRate)} old); not caused by this flag`,
      checks,
    };
  }

  return {
    ...base,
    status: "unhealthy",
    summary: failed.map((c) => c.detail).join("; "),
    checks,
  };
}
