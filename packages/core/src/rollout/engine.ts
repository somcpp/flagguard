import {
  type Actor,
  type AuditAction,
  type AuditLog,
  type AuditOutcome,
} from "../audit/audit-log.js";
import { decide } from "../autonomy/autonomy.js";
import { ConfigError } from "../errors.js";
import { evaluateHealth, type HealthVerdict } from "../guardrails/health.js";
import { type Logger, silentLogger } from "../logger.js";
import { type MetricsSource } from "../metrics/source.js";
import type { AgentAction, Policy } from "../policy/schema.js";
import { type FlagBackend } from "./backend.js";
import {
  newApproval,
  newRecord,
  type PendingApproval,
  type RolloutRecord,
  type StateStore,
} from "./state.js";

export interface RolloutEngineDeps {
  policy: Policy;
  backend: FlagBackend;
  state: StateStore;
  audit: AuditLog;
  /** Needed for health gates and the watcher. Without it, health is never checked. */
  metrics?: MetricsSource;
  clock?: () => Date;
  logger?: Logger;
}

export type EngineOutcome = "applied" | "pending_approval" | "blocked" | "denied" | "noop";

export interface EngineResult {
  outcome: EngineOutcome;
  message: string;
  record: RolloutRecord;
  approval?: PendingApproval;
  health?: HealthVerdict;
}

export interface AdvanceOptions {
  /** Skip the minimum stage duration and insufficient-data gates (never the unhealthy gate). */
  force?: boolean;
}

export interface HealthCheckResult {
  verdict: HealthVerdict;
  /** What the agent did about it. */
  action: "none" | "killed" | "kill_requested";
  /** Exposure when the check ran (before any kill). */
  percentageAtCheck: number;
  record: RolloutRecord;
}

const pct = (n: number): string => `${n}%`;

/**
 * Orchestrates staged rollouts: what the next step is, whether it is safe, and
 * whether the agent may take it alone or must ask a human (via the autonomy
 * policy). Every decision is written to the audit log with its reason.
 */
export class RolloutEngine {
  private readonly policy: Policy;
  private readonly backend: FlagBackend;
  private readonly state: StateStore;
  private readonly audit: AuditLog;
  private readonly metrics: MetricsSource | undefined;
  private readonly clock: () => Date;
  private readonly logger: Logger;

  constructor(deps: RolloutEngineDeps) {
    this.policy = deps.policy;
    this.backend = deps.backend;
    this.state = deps.state;
    this.audit = deps.audit;
    this.metrics = deps.metrics;
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger ?? silentLogger;
  }

  /* ------------------------------------ queries ------------------------------------ */

  environments(): Policy["environments"] {
    return this.policy.environments;
  }

  /** Default target for rollout commands: the first production environment. */
  defaultEnvironment(): string {
    const env = this.policy.environments.find((e) => e.production) ?? this.policy.environments[0];
    if (!env) throw new ConfigError("Policy defines no environments");
    return env.name;
  }

  /** Records for every policy environment, reconciled with the live percentage. */
  async status(flag: string): Promise<RolloutRecord[]> {
    return Promise.all(this.policy.environments.map((env) => this.load(flag, env.name)));
  }

  async pendingApprovals(): Promise<RolloutRecord[]> {
    return (await this.state.list()).filter((r) => r.pendingApproval !== null);
  }

  /* ------------------------------------ commands ----------------------------------- */

  /**
   * Create the flag (off everywhere), then switch it on in every non-production
   * environment so the team can test it. Production is untouched.
   */
  async createFlag(
    flag: string,
    description: string,
    actor: Actor = "agent",
  ): Promise<EngineResult[]> {
    const createDecision = decide(this.policy, "create_flag");
    if (createDecision.kind !== "allow" && actor === "agent") {
      const record = await this.load(flag, this.defaultEnvironment());
      await this.log(record, "create_flag", actor, "denied", createDecision.reason);
      return [{ outcome: "denied", message: createDecision.reason, record }];
    }

    const { created } = await this.backend.ensureFlag(flag, description);
    const results: EngineResult[] = [];

    for (const env of this.policy.environments) {
      const record = await this.load(flag, env.name);
      if (env.production) {
        if (created) {
          await this.log(
            record,
            "create_flag",
            actor,
            "applied",
            `Created "${flag}", off in ${env.name}`,
          );
        }
        results.push({
          outcome: "noop",
          message: `${env.name}: off until a gated rollout`,
          record,
        });
        continue;
      }
      if (record.percentage === 100) {
        results.push({ outcome: "noop", message: `${env.name}: already on`, record });
        continue;
      }
      results.push(
        await this.propose(record, "enable_in_non_production", 100, actor, {
          reason: `Enable "${flag}" in ${env.name} so the team can test it`,
          production: false,
        }),
      );
    }
    return results;
  }

  /** Request the next rollout stage. Applies it, or creates a pending approval. */
  async advance(
    flag: string,
    environment: string,
    actor: Actor = "agent",
    options: AdvanceOptions = {},
  ): Promise<EngineResult> {
    const env = this.requireEnvironment(environment);
    const record = await this.load(flag, env.name);

    if (record.pendingApproval) {
      return {
        outcome: "pending_approval",
        message: `Already waiting for approval: ${record.pendingApproval.reason}`,
        record,
        approval: record.pendingApproval,
      };
    }

    const stages = this.policy.rollout.stages;
    const target = stages.find((stage) => stage > record.percentage);
    if (target === undefined) {
      return {
        outcome: "noop",
        message: `${flag} is already fully rolled out in ${env.name}`,
        record,
      };
    }

    const gate = await this.checkGates(record, options);
    if (gate.blocked) {
      // The watcher proposes on every tick; only log blocks a human asked about, to avoid noise.
      if (actor !== "agent") {
        await this.log(record, "advance_rollout", actor, "blocked", gate.reason, gate.health);
      }
      return { outcome: "blocked", message: gate.reason, record, ...withHealth(gate.health) };
    }

    const action: AgentAction =
      record.percentage === 0
        ? "start_rollout"
        : target === 100
          ? "complete_rollout"
          : "advance_rollout";
    const reason =
      record.percentage === 0
        ? `Start rollout of ${flag} in ${env.name} at ${pct(target)}`
        : `Advance ${flag} in ${env.name} from ${pct(record.percentage)} to ${pct(target)}`;

    return this.propose(record, action, target, actor, {
      reason: options.force ? `${reason} (forced past time/data gates)` : reason,
      production: env.production,
      ...withHealth(gate.health),
    });
  }

  /** A human approves the pending action. Health is re-checked before applying. */
  async approve(flag: string, environment: string, approver: Actor): Promise<EngineResult> {
    const env = this.requireEnvironment(environment);
    const record = await this.load(flag, env.name);
    const approval = record.pendingApproval;
    if (!approval) {
      return {
        outcome: "noop",
        message: `Nothing is waiting for approval for ${flag} in ${env.name}`,
        record,
      };
    }

    const increasesExposure = approval.targetPercentage > record.percentage;
    if (increasesExposure) {
      const health = await this.currentHealth(record);
      if (health?.status === "unhealthy") {
        record.pendingApproval = null;
        await this.save(record);
        const message = `Approval refused: new code is unhealthy (${health.summary})`;
        await this.log(record, "approve", approver, "blocked", message, health);
        return { outcome: "blocked", message, record, health };
      }
    }

    await this.log(record, "approve", approver, "applied", `Approved: ${approval.reason}`);
    return this.apply(
      record,
      approval.action,
      approval.targetPercentage,
      approver,
      approval.reason,
    );
  }

  async reject(
    flag: string,
    environment: string,
    approver: Actor,
    reason?: string,
  ): Promise<EngineResult> {
    const env = this.requireEnvironment(environment);
    const record = await this.load(flag, env.name);
    const approval = record.pendingApproval;
    if (!approval) {
      return {
        outcome: "noop",
        message: `Nothing is waiting for approval for ${flag} in ${env.name}`,
        record,
      };
    }
    record.pendingApproval = null;
    await this.save(record);
    const message = `Rejected: ${approval.reason}${reason ? ` (${reason})` : ""}`;
    await this.log(record, "reject", approver, "applied", message);
    return { outcome: "applied", message, record };
  }

  /**
   * Kill switch. A human can always pull it. The agent pulls it on its own
   * when policy allows (the default), otherwise it requests approval.
   */
  async kill(
    flag: string,
    environment: string,
    actor: Actor,
    reason: string,
  ): Promise<EngineResult> {
    const env = this.requireEnvironment(environment);
    const record = await this.load(flag, env.name);
    if (actor !== "agent") return this.apply(record, "kill_flag", 0, actor, reason);
    return this.propose(record, "kill_flag", 0, actor, { reason, production: env.production });
  }

  /**
   * One watcher tick: read cohort metrics, judge health, and pull the kill
   * switch when the new code is the problem.
   */
  async checkHealth(flag: string, environment: string): Promise<HealthCheckResult> {
    const env = this.requireEnvironment(environment);
    const record = await this.load(flag, env.name);
    const verdict = await this.currentHealth(record, { evenWhenOff: true });
    if (!verdict) throw new ConfigError("checkHealth requires a metrics source");

    const changed = verdict.status !== record.lastHealth;
    record.lastHealth = verdict.status;
    await this.save(record);
    if (changed) {
      await this.log(
        record,
        "health_check",
        "agent",
        "observed",
        `Health: ${verdict.status}. ${verdict.summary}`,
        verdict,
      );
    }

    const exposed = record.percentage > 0;
    const percentageAtCheck = record.percentage;
    if (verdict.status !== "unhealthy" || !exposed) {
      return { verdict, action: "none", percentageAtCheck, record };
    }
    if (record.pendingApproval?.action === "kill_flag") {
      return { verdict, action: "kill_requested", percentageAtCheck, record };
    }

    const result = await this.kill(
      flag,
      env.name,
      "agent",
      `Guardrail breached: ${verdict.summary}`,
    );
    return {
      verdict,
      action: result.outcome === "applied" ? "killed" : "kill_requested",
      percentageAtCheck,
      record: result.record,
    };
  }

  /* ----------------------------------- internals ----------------------------------- */

  private async propose(
    record: RolloutRecord,
    action: AgentAction,
    targetPercentage: number,
    actor: Actor,
    context: { reason: string; production: boolean; health?: HealthVerdict },
  ): Promise<EngineResult> {
    const decision = decide(this.policy, action, { production: context.production });

    // A human explicitly running a command is the approval for that command,
    // except where the policy forbids the action outright.
    if (decision.kind === "allow" || (decision.kind === "needs_approval" && actor !== "agent")) {
      return this.apply(record, action, targetPercentage, actor, context.reason);
    }

    if (decision.kind === "deny") {
      await this.log(record, action, actor, "denied", `${context.reason}: ${decision.reason}`);
      return { outcome: "denied", message: decision.reason, record };
    }

    const approval = newApproval(action, targetPercentage, context.reason, this.clock());
    record.pendingApproval = approval;
    await this.save(record);
    await this.log(record, action, actor, "pending_approval", context.reason, context.health, {
      approvalId: approval.id,
      targetPercentage,
    });
    return {
      outcome: "pending_approval",
      message: `Waiting for human approval: ${context.reason}`,
      record,
      approval,
      ...withHealth(context.health),
    };
  }

  private async apply(
    record: RolloutRecord,
    action: AgentAction,
    targetPercentage: number,
    actor: Actor,
    reason: string,
  ): Promise<EngineResult> {
    try {
      if (action === "kill_flag") {
        await this.backend.kill(record.environment, record.flag);
      } else {
        await this.backend.setPercentage(record.environment, record.flag, targetPercentage);
      }
    } catch (error) {
      const message = `${reason} failed: ${(error as Error).message}`;
      await this.log(record, action, actor, "failed", message);
      this.logger.error("rollout action failed", {
        action,
        flag: record.flag,
        error: (error as Error).message,
      });
      throw error;
    }

    const now = this.clock();
    record.percentage = targetPercentage;
    record.stageStartedAt = now.toISOString();
    record.pendingApproval = null;
    record.status =
      action === "kill_flag" ? "killed" : targetPercentage === 100 ? "completed" : "in_progress";
    await this.save(record);
    await this.log(record, action, actor, "applied", reason, undefined, {
      percentage: targetPercentage,
    });
    return { outcome: "applied", message: reason, record };
  }

  private async checkGates(
    record: RolloutRecord,
    options: AdvanceOptions,
  ): Promise<{ blocked: boolean; reason: string; health?: HealthVerdict }> {
    if (record.percentage === 0) return { blocked: false, reason: "" };

    const health = await this.currentHealth(record);
    if (health?.status === "unhealthy") {
      return { blocked: true, reason: `New code is unhealthy: ${health.summary}`, health };
    }
    if (options.force) return { blocked: false, reason: "", ...withHealth(health) };

    if (health?.status === "insufficient_data") {
      return { blocked: true, reason: health.summary, health };
    }

    const minMs = this.policy.rollout.minStageMinutes * 60_000;
    if (record.stageStartedAt && minMs > 0) {
      const elapsed = this.clock().getTime() - Date.parse(record.stageStartedAt);
      if (elapsed < minMs) {
        const remaining = Math.ceil((minMs - elapsed) / 60_000);
        return {
          blocked: true,
          reason: `Stage ${pct(record.percentage)} must run ${this.policy.rollout.minStageMinutes} min before advancing (${remaining} min left)`,
          ...withHealth(health),
        };
      }
    }
    return { blocked: false, reason: "", ...withHealth(health) };
  }

  private async currentHealth(
    record: RolloutRecord,
    options: { evenWhenOff?: boolean } = {},
  ): Promise<HealthVerdict | undefined> {
    if (!this.metrics || (record.percentage === 0 && !options.evenWhenOff)) return undefined;
    const snapshot = await this.metrics.snapshot(record.flag);
    return evaluateHealth(snapshot, this.policy.guardrails);
  }

  /** Load bookkeeping and reconcile it with what the flag system actually serves. */
  private async load(flag: string, environment: string): Promise<RolloutRecord> {
    const stored = await this.state.get(flag, environment);
    const record = stored ?? newRecord(flag, environment, this.clock());
    let live: number;
    try {
      live = await this.backend.getPercentage(environment, flag);
    } catch {
      return record; // flag not created yet
    }
    if (live !== record.percentage) {
      // Someone changed it outside FlagGuard (e.g. in the Flagsmith dashboard): trust Flagsmith.
      // With no stored state (a fresh CI runner) there is nothing to drift from, so stay quiet.
      if (stored) {
        this.logger.warn("rollout drifted from FlagGuard state", {
          flag,
          environment,
          recorded: record.percentage,
          live,
        });
      }
      record.percentage = live;
      // With no history (e.g. a fresh CI runner) the stage start is unknown, not "now".
      record.stageStartedAt = stored ? this.clock().toISOString() : null;
      record.status =
        live === 0
          ? record.status === "killed"
            ? "killed"
            : "not_started"
          : live === 100
            ? "completed"
            : "in_progress";
      await this.save(record);
    }
    return record;
  }

  private async save(record: RolloutRecord): Promise<void> {
    record.updatedAt = this.clock().toISOString();
    await this.state.put(record);
  }

  private async log(
    record: RolloutRecord,
    action: AuditAction,
    actor: Actor,
    outcome: AuditOutcome,
    reason: string,
    health?: HealthVerdict,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.append({
      timestamp: this.clock().toISOString(),
      flag: record.flag,
      environment: record.environment,
      action,
      actor,
      outcome,
      reason,
      details: {
        ...extra,
        ...(health
          ? {
              health: {
                status: health.status,
                treatment: health.treatment,
                control: health.control,
              },
            }
          : {}),
      },
    });
  }

  private requireEnvironment(name: string): Policy["environments"][number] {
    const env = this.policy.environments.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!env) {
      throw new ConfigError(
        `Environment "${name}" is not in flagguard.yml. Known: ${this.policy.environments.map((e) => e.name).join(", ")}`,
      );
    }
    return env;
  }
}

function withHealth(health: HealthVerdict | undefined): { health?: HealthVerdict } {
  return health ? { health } : {};
}
