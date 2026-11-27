import { z } from "zod";
import { FlagGuardError } from "../errors.js";
import type { FetchLike } from "../flagsmith/http.js";
import type { FlagMetricsSnapshot } from "./metrics.js";

/** Where the watcher reads per-cohort health from. */
export interface MetricsSource {
  snapshot(flag: string): Promise<FlagMetricsSnapshot>;
}

const CohortStatsSchema = z.object({
  requests: z.number().int().min(0),
  errors: z.number().int().min(0),
  errorRate: z.number().min(0).max(1),
  p50LatencyMs: z.number().min(0),
  p95LatencyMs: z.number().min(0),
});

export const FlagMetricsSnapshotSchema = z.object({
  flag: z.string(),
  windowMs: z.number().positive(),
  generatedAt: z.string(),
  control: CohortStatsSchema,
  treatment: CohortStatsSchema,
});

export class MetricsUnavailableError extends FlagGuardError {
  constructor(message: string, options?: ErrorOptions) {
    super("METRICS_UNAVAILABLE", message, options);
  }
}

/**
 * Reads the FlagGuard metrics contract (`GET <baseUrl>/flagguard/metrics/:flag`)
 * from a running app and validates it, so a misbehaving endpoint can never be
 * mistaken for a healthy one.
 */
export class HttpMetricsSource implements MetricsSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: { fetch?: FetchLike; timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async snapshot(flag: string): Promise<FlagMetricsSnapshot> {
    const url = `${this.baseUrl}/flagguard/metrics/${encodeURIComponent(flag)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      throw new MetricsUnavailableError(`Could not reach metrics at ${url}`, { cause });
    }
    if (!response.ok) {
      throw new MetricsUnavailableError(`Metrics endpoint ${url} returned ${response.status}`);
    }
    const parsed = FlagMetricsSnapshotSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new MetricsUnavailableError(`Metrics endpoint ${url} returned an invalid payload`);
    }
    return parsed.data;
  }
}
