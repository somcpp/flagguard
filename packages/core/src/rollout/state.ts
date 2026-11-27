import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HealthStatus } from "../guardrails/health.js";
import type { AgentAction } from "../policy/schema.js";

export type RolloutStatus = "not_started" | "in_progress" | "completed" | "killed";

export interface PendingApproval {
  id: string;
  action: AgentAction;
  /** Percentage the flag moves to once approved. */
  targetPercentage: number;
  requestedAt: string;
  reason: string;
}

/**
 * FlagGuard's bookkeeping for one flag in one environment. Flagsmith stays the
 * source of truth for *what users get*; this records *how we got here*: stage
 * timing, pending approvals and the last health verdict.
 */
export interface RolloutRecord {
  flag: string;
  environment: string;
  status: RolloutStatus;
  percentage: number;
  /** When the current percentage was applied (drives the minimum stage duration). */
  stageStartedAt: string | null;
  pendingApproval: PendingApproval | null;
  lastHealth: HealthStatus | null;
  updatedAt: string;
}

export function newRecord(flag: string, environment: string, now: Date): RolloutRecord {
  return {
    flag,
    environment,
    status: "not_started",
    percentage: 0,
    stageStartedAt: null,
    pendingApproval: null,
    lastHealth: null,
    updatedAt: now.toISOString(),
  };
}

export function newApproval(
  action: AgentAction,
  targetPercentage: number,
  reason: string,
  now: Date,
): PendingApproval {
  return {
    id: randomUUID().slice(0, 8),
    action,
    targetPercentage,
    requestedAt: now.toISOString(),
    reason,
  };
}

export interface StateStore {
  get(flag: string, environment: string): Promise<RolloutRecord | null>;
  put(record: RolloutRecord): Promise<void>;
  list(): Promise<RolloutRecord[]>;
}

const keyOf = (flag: string, environment: string): string =>
  `${flag}::${environment.toLowerCase()}`;

export class MemoryStateStore implements StateStore {
  private readonly records = new Map<string, RolloutRecord>();

  get(flag: string, environment: string): Promise<RolloutRecord | null> {
    const record = this.records.get(keyOf(flag, environment));
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  put(record: RolloutRecord): Promise<void> {
    this.records.set(keyOf(record.flag, record.environment), structuredClone(record));
    return Promise.resolve();
  }

  list(): Promise<RolloutRecord[]> {
    return Promise.resolve([...this.records.values()].map((r) => structuredClone(r)));
  }
}

interface StateFile {
  version: 1;
  rollouts: Record<string, RolloutRecord>;
}

/**
 * JSON file (`.flagguard/state.json`), written atomically (temp file and rename)
 * so a crash mid-write never leaves a corrupt state behind. Every operation
 * re-reads the file, so a watcher process and CLI commands see each other's
 * changes.
 */
export class FileStateStore implements StateStore {
  constructor(private readonly file: string) {}

  async get(flag: string, environment: string): Promise<RolloutRecord | null> {
    return (await this.read()).rollouts[keyOf(flag, environment)] ?? null;
  }

  async put(record: RolloutRecord): Promise<void> {
    const state = await this.read();
    state.rollouts[keyOf(record.flag, record.environment)] = record;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(temp, this.file);
  }

  async list(): Promise<RolloutRecord[]> {
    return Object.values((await this.read()).rollouts);
  }

  private async read(): Promise<StateFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as StateFile;
      return { version: 1, rollouts: parsed.rollouts };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, rollouts: {} };
      throw error;
    }
  }
}
