import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import {
  type AuditEvent,
  evaluateHealth,
  type FlagMetricsSnapshot,
  human,
  HttpMetricsSource,
  type Logger,
  type RolloutRecord,
} from "@flagguard/core";
import { z } from "zod";
import type { Context } from "../context.js";

export interface DashboardOptions {
  port: number;
  host?: string;
  /** Run the agent loop (health checks + automatic kill switch) inside the dashboard. */
  watch?: boolean;
  /** Seconds between metric samples / watcher ticks. */
  intervalSeconds?: number;
  /** Seconds between refreshes of live state from Flagsmith (Admin API is rate limited). */
  refreshSeconds?: number;
  /** Flags to show even before FlagGuard has touched them. */
  flags?: string[];
  logger: Logger;
}

export interface SeriesPoint {
  t: number;
  treatment: { requests: number; errorRate: number; p95LatencyMs: number };
  control: { requests: number; errorRate: number; p95LatencyMs: number };
}

const MAX_POINTS = 360; // 30 min at 5 s

interface Cache {
  records: RolloutRecord[];
  refreshedAt: number;
}

/**
 * Local web dashboard: what the agent did and why, what is waiting for a human,
 * and how the new code is doing against the old code. Binds to localhost only;
 * state-changing requests need a custom header, which browsers will not send
 * cross-site without a CORS preflight (that this server never grants).
 */
export async function startDashboard(
  ctx: Context,
  options: DashboardOptions,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const html = await readFile(new URL("../../assets/dashboard.html", import.meta.url), "utf8");
  const interval = Math.max(1, options.intervalSeconds ?? 5) * 1000;
  const refreshEvery = Math.max(5, options.refreshSeconds ?? 15) * 1000;
  const series = new Map<string, SeriesPoint[]>();
  const pinned = new Set(options.flags ?? []);
  const cache: Cache = { records: [], refreshedAt: 0 };
  const { engine, audit, logger } = { ...ctx, logger: options.logger };
  const metrics = ctx.metricsUrl ? new HttpMetricsSource(ctx.metricsUrl) : null;

  async function knownFlags(): Promise<string[]> {
    const fromAudit = (await audit.list({ limit: 500 })).map((e) => e.flag);
    return [...new Set([...pinned, ...cache.records.map((r) => r.flag), ...fromAudit])].sort();
  }

  /** Live percentages come from the flag backend; everything else from local state. */
  /**
   * Every read-modify-write of rollout state (human actions, the watcher's kill
   * switch, and the background refresh that reconciles with Flagsmith) runs one at
   * a time: a double-clicked Approve can't apply twice, and a refresh can't write a
   * stale record over a kill that landed while it was reading.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function refresh(force = false): Promise<void> {
    if (!force && Date.now() - cache.refreshedAt < refreshEvery) return;
    const flags = await knownFlags();
    const records: RolloutRecord[] = [];
    for (const flag of flags) {
      try {
        records.push(...(await exclusive(() => engine.status(flag))));
      } catch (error) {
        logger.warn("could not refresh flag", { flag, error: (error as Error).message });
      }
    }
    cache.records = records;
    cache.refreshedAt = Date.now();
  }

  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await refresh();
      if (!metrics) return;
      const production = engine.defaultEnvironment();
      for (const flag of await knownFlags()) {
        let snapshot: FlagMetricsSnapshot;
        try {
          snapshot = await metrics.snapshot(flag);
        } catch {
          continue;
        }
        const points = series.get(flag) ?? [];
        points.push({
          t: Date.now(),
          treatment: pick(snapshot.treatment),
          control: pick(snapshot.control),
        });
        if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
        series.set(flag, points);

        const record = cache.records.find((r) => r.flag === flag && r.environment === production);
        if (options.watch && record && record.percentage > 0) {
          const result = await exclusive(() => engine.checkHealth(flag, production));
          if (result.action !== "none") await refresh(true);
        }
      }
    } catch (error) {
      logger.warn("dashboard tick failed", { error: (error as Error).message });
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => void tick(), interval);
  await refresh(true);
  void tick();

  const ActionBody = z.object({
    action: z.enum(["approve", "reject", "advance", "propose", "kill"]),
    environment: z.string().min(1).optional(),
    actor: z.string().trim().min(1).max(60).optional(),
    reason: z.string().max(300).optional(),
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      await refresh();
      const flags = await knownFlags();
      const events = await audit.list({ limit: 1000 });
      return json(res, 200, {
        backend: ctx.backend.kind,
        metrics: ctx.metricsUrl ?? null,
        watching: Boolean(options.watch && metrics),
        intervalSeconds: interval / 1000,
        refreshedAt: cache.refreshedAt,
        policy: {
          environments: ctx.loaded.policy.environments,
          stages: ctx.loaded.policy.rollout.stages,
          minStageMinutes: ctx.loaded.policy.rollout.minStageMinutes,
          guardrails: ctx.loaded.policy.guardrails,
        },
        flags: flags.map((flag) => ({
          flag,
          records: cache.records.filter((r) => r.flag === flag),
          lastEvent: lastFor(events, flag),
          pending: cache.records.filter((r) => r.flag === flag && r.pendingApproval).length,
        })),
      });
    }

    const flagMatch = /^\/api\/flags\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname);
    if (req.method === "GET" && flagMatch?.[1]) {
      const flag = flagMatch[1];
      const points = series.get(flag) ?? [];
      const latest = points.at(-1);
      const verdict = latest
        ? evaluateHealth(
            {
              flag,
              windowMs: 0,
              generatedAt: new Date(latest.t).toISOString(),
              treatment: { ...latest.treatment, errors: 0, p50LatencyMs: 0 },
              control: { ...latest.control, errors: 0, p50LatencyMs: 0 },
            },
            ctx.loaded.policy.guardrails,
          )
        : null;
      return json(res, 200, {
        flag,
        records: cache.records.filter((r) => r.flag === flag),
        series: points,
        verdict,
        events: (await audit.list({ flag, limit: 200 })).reverse(),
      });
    }

    const actionMatch = /^\/api\/flags\/([a-zA-Z0-9_.-]+)\/actions$/.exec(url.pathname);
    if (req.method === "POST" && actionMatch?.[1]) {
      if (req.headers["x-flagguard-request"] !== "1")
        return json(res, 403, { error: "missing X-FlagGuard-Request header" });
      const parsed = ActionBody.safeParse(await readJson(req));
      if (!parsed.success) return json(res, 400, { error: z.prettifyError(parsed.error) });
      const flag = actionMatch[1];
      const { action, reason } = parsed.data;
      const environment = parsed.data.environment ?? engine.defaultEnvironment();
      const actor = human(parsed.data.actor ?? "dashboard");
      try {
        const result = await exclusive(() =>
          action === "approve"
            ? engine.approve(flag, environment, actor)
            : action === "reject"
              ? engine.reject(flag, environment, actor, reason)
              : action === "advance"
                ? engine.advance(flag, environment, actor)
                : action === "propose"
                  ? engine.advance(flag, environment, "agent")
                  : engine.kill(flag, environment, actor, reason ?? "Kill switch from dashboard"),
        );
        await refresh(true);
        return json(res, 200, { outcome: result.outcome, message: result.message });
      } catch (error) {
        return json(res, 500, { error: (error as Error).message });
      }
    }

    return json(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error("dashboard request failed", { error: (error as Error).message });
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  return {
    server,
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        server.close(() => {
          resolve();
        });
      }),
  };
}

function pick(stats: {
  requests: number;
  errorRate: number;
  p95LatencyMs: number;
}): SeriesPoint["treatment"] {
  return { requests: stats.requests, errorRate: stats.errorRate, p95LatencyMs: stats.p95LatencyMs };
}

function lastFor(events: AuditEvent[], flag: string): AuditEvent | null {
  for (let i = events.length - 1; i >= 0; i--)
    if (events[i]?.flag === flag) return events[i] ?? null;
  return null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Writes the response; returns true so handlers can `return send(...)`. */
function send(res: ServerResponse, status: number, body: string, type: string): true {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  res.end(body);
  return true;
}

function json(res: ServerResponse, status: number, data: unknown): true {
  return send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}
