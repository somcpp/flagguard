/**
 * Per-cohort health metrics for a flagged change.
 *
 * - **control**: users evaluated with the flag *off* (old code path)
 * - **treatment**: users evaluated with the flag *on* (new code path)
 *
 * Comparing the two cohorts over the same time window separates "the new code
 * is broken" from "everything is slow right now", which is what lets the
 * agent pull the kill switch without false alarms.
 */

export type Cohort = "control" | "treatment";

export interface RequestSample {
  cohort: Cohort;
  ok: boolean;
  latencyMs: number;
  /** Epoch milliseconds. Defaults to "now" when recorded. */
  timestamp?: number;
}

export interface CohortStats {
  requests: number;
  errors: number;
  /** errors / requests, or 0 when there were no requests. */
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

/** The wire format served by apps at `GET /flagguard/metrics/:flag`. */
export interface FlagMetricsSnapshot {
  flag: string;
  windowMs: number;
  /** ISO timestamp. */
  generatedAt: string;
  control: CohortStats;
  treatment: CohortStats;
}

const EMPTY_STATS: CohortStats = {
  requests: 0,
  errors: 0,
  errorRate: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
};

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}

export function summarize(
  samples: readonly Pick<RequestSample, "ok" | "latencyMs">[],
): CohortStats {
  if (samples.length === 0) return { ...EMPTY_STATS };
  const errors = samples.filter((s) => !s.ok).length;
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  return {
    requests: samples.length,
    errors,
    errorRate: errors / samples.length,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
  };
}

interface StoredSample {
  cohort: Cohort;
  ok: boolean;
  latencyMs: number;
  timestamp: number;
}

export interface SlidingWindowMetricsOptions {
  /** Only samples newer than this are reported. Default: 2 minutes. */
  windowMs?: number;
  /** Hard cap per flag to bound memory under heavy traffic. Default: 50,000. */
  maxSamplesPerFlag?: number;
  now?: () => number;
}

/**
 * In-memory, per-flag sliding window of request outcomes. Cheap enough to sit
 * in a request path: O(1) record, pruning amortised, O(n log n) snapshot.
 */
export class SlidingWindowMetrics {
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly now: () => number;
  private readonly samples = new Map<string, StoredSample[]>();

  constructor(options: SlidingWindowMetricsOptions = {}) {
    this.windowMs = options.windowMs ?? 120_000;
    this.maxSamples = options.maxSamplesPerFlag ?? 50_000;
    this.now = options.now ?? Date.now;
  }

  record(flag: string, sample: RequestSample): void {
    let list = this.samples.get(flag);
    if (!list) {
      list = [];
      this.samples.set(flag, list);
    }
    list.push({
      cohort: sample.cohort,
      ok: sample.ok,
      latencyMs: sample.latencyMs,
      timestamp: sample.timestamp ?? this.now(),
    });
    if (list.length > this.maxSamples) list.splice(0, list.length - this.maxSamples);
  }

  snapshot(flag: string): FlagMetricsSnapshot {
    const list = this.prune(flag);
    return {
      flag,
      windowMs: this.windowMs,
      generatedAt: new Date(this.now()).toISOString(),
      control: summarize(list.filter((s) => s.cohort === "control")),
      treatment: summarize(list.filter((s) => s.cohort === "treatment")),
    };
  }

  flags(): string[] {
    return [...this.samples.keys()];
  }

  reset(flag?: string): void {
    if (flag === undefined) this.samples.clear();
    else this.samples.delete(flag);
  }

  private prune(flag: string): StoredSample[] {
    const list = this.samples.get(flag);
    if (!list) return [];
    const cutoff = this.now() - this.windowMs;
    const firstFresh = list.findIndex((s) => s.timestamp >= cutoff);
    if (firstFresh === -1) list.length = 0;
    else if (firstFresh > 0) list.splice(0, firstFresh);
    return list;
  }
}
