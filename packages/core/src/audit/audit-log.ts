import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAction } from "../policy/schema.js";

/** Who performed an action: the agent itself, or a named human. */
export type Actor = "agent" | `human:${string}`;

export const human = (name: string): Actor => `human:${name.trim() || "unknown"}`;

export type AuditAction = AgentAction | "health_check" | "approve" | "reject";

/**
 * - `applied`: the change was made in Flagsmith
 * - `pending_approval`: the agent wants to do this and is waiting for a human
 * - `blocked`: a gate (stage time, health) stopped it
 * - `denied`: policy forbids it
 * - `failed`: tried and errored
 * - `observed`: informational (e.g. a health check result)
 */
export type AuditOutcome =
  "applied" | "pending_approval" | "blocked" | "denied" | "failed" | "observed";

export interface AuditEvent {
  id: string;
  /** ISO timestamp. */
  timestamp: string;
  flag: string;
  environment: string | null;
  action: AuditAction;
  actor: Actor;
  outcome: AuditOutcome;
  /** Why this happened, in plain language. Shown in PR comments and the dashboard. */
  reason: string;
  details?: Record<string, unknown>;
}

export type NewAuditEvent = Omit<AuditEvent, "id" | "timestamp"> & { timestamp?: string };

export interface AuditFilter {
  flag?: string;
  environment?: string;
  /** Most recent N events. */
  limit?: number;
}

/** Append-only record of everything the agent did, or wanted to do, and why. */
export interface AuditLog {
  append(event: NewAuditEvent): Promise<AuditEvent>;
  list(filter?: AuditFilter): Promise<AuditEvent[]>;
}

function materialize(event: NewAuditEvent): AuditEvent {
  return { id: randomUUID(), ...event, timestamp: event.timestamp ?? new Date().toISOString() };
}

function applyFilter(events: AuditEvent[], filter: AuditFilter = {}): AuditEvent[] {
  const matching = events.filter(
    (e) =>
      (filter.flag === undefined || e.flag === filter.flag) &&
      (filter.environment === undefined || e.environment === filter.environment),
  );
  return filter.limit === undefined ? matching : matching.slice(-filter.limit);
}

export class MemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];

  append(event: NewAuditEvent): Promise<AuditEvent> {
    const stored = materialize(event);
    this.events.push(stored);
    return Promise.resolve(stored);
  }

  list(filter?: AuditFilter): Promise<AuditEvent[]> {
    return Promise.resolve(applyFilter(this.events, filter));
  }
}

/**
 * JSON Lines file (`.flagguard/audit.jsonl`): one event per line, append-only,
 * greppable, and safe to tail from the dashboard while the watcher writes.
 */
export class FileAuditLog implements AuditLog {
  constructor(private readonly file: string) {}

  async append(event: NewAuditEvent): Promise<AuditEvent> {
    const stored = materialize(event);
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(stored) + "\n", "utf8");
    return stored;
  }

  async list(filter?: AuditFilter): Promise<AuditEvent[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AuditEvent];
        } catch {
          return []; // a torn final line from a crash must not hide the rest of the log
        }
      });
    return applyFilter(events, filter);
  }
}
