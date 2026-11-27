import path from "node:path";
import {
  type AuditLog,
  createFlagsmith,
  FileAuditLog,
  FileStateStore,
  type FlagBackend,
  FlagsmithBackend,
  HttpMetricsSource,
  loadDotEnv,
  loadEnv,
  loadPolicy,
  type LoadedPolicy,
  type Logger,
  RolloutEngine,
} from "@flagguard/core";
import pc from "picocolors";
import { OfflineShopBackend } from "./offline-backend.js";

export interface GlobalOptions {
  policy?: string;
  offline?: string;
  metrics?: string;
  stateDir?: string;
  json?: boolean;
  verbose?: boolean;
}

const LEVELS = ["debug", "info", "warn", "error"] as const;
const LEVEL_STYLE = { debug: pc.dim, info: pc.cyan, warn: pc.yellow, error: pc.red };

/** Human-friendly logger for the terminal (stderr), instead of JSON lines. */
export function createCliLogger(
  level: (typeof LEVELS)[number],
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): Logger {
  const threshold = LEVELS.indexOf(level);
  const make =
    (lvl: (typeof LEVELS)[number]) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      if (LEVELS.indexOf(lvl) < threshold) return;
      const extras = Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      write(`${LEVEL_STYLE[lvl](lvl.padEnd(5))} ${message}${extras ? pc.dim(" " + extras) : ""}`);
    };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}

export interface Context {
  cwd: string;
  envFile: string | null;
  loaded: LoadedPolicy;
  backend: FlagBackend;
  engine: RolloutEngine;
  audit: AuditLog;
  metricsUrl: string | undefined;
  stateDir: string;
  logger: Logger;
}

/** Everything a command needs, assembled from flags, env vars and flagguard.yml. */
export async function createContext(options: GlobalOptions, cwd = process.cwd()): Promise<Context> {
  const envFile = loadDotEnv(cwd);
  const loaded = await loadPolicy({
    cwd,
    ...(options.policy ? { explicitPath: options.policy } : {}),
  });
  const logger = createCliLogger(options.verbose ? "debug" : "warn");

  const offlineUrl = options.offline ?? process.env.FLAGGUARD_OFFLINE_URL;
  const metricsUrl = options.metrics ?? process.env.FLAGGUARD_METRICS_URL ?? offlineUrl;
  const stateDir = path.resolve(cwd, options.stateDir ?? ".flagguard");

  let backend: FlagBackend;
  if (offlineUrl) {
    backend = new OfflineShopBackend(offlineUrl, {
      productionEnvironments: loaded.policy.environments
        .filter((e) => e.production)
        .map((e) => e.name),
      ...(process.env.SHOP_ADMIN_TOKEN ? { adminToken: process.env.SHOP_ADMIN_TOKEN } : {}),
    });
  } else {
    const env = loadEnv();
    const { client, flags } = createFlagsmith(env, { logger });
    backend = new FlagsmithBackend(client, flags, env.FLAGSMITH_PROJECT_ID);
  }

  const audit = new FileAuditLog(path.join(stateDir, "audit.jsonl"));
  const engine = new RolloutEngine({
    policy: loaded.policy,
    backend,
    state: new FileStateStore(path.join(stateDir, "state.json")),
    audit,
    ...(metricsUrl ? { metrics: new HttpMetricsSource(metricsUrl) } : {}),
    logger,
  });

  return { cwd, envFile, loaded, backend, engine, audit, metricsUrl, stateDir, logger };
}
