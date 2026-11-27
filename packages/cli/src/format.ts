import type {
  AuditEvent,
  CohortStats,
  EngineResult,
  HealthVerdict,
  RolloutRecord,
} from "@flagguard/core";
import pc from "picocolors";

const OUTCOME_STYLE: Record<EngineResult["outcome"], (s: string) => string> = {
  applied: pc.green,
  pending_approval: pc.yellow,
  blocked: pc.red,
  denied: pc.red,
  noop: pc.dim,
};

const OUTCOME_ICON: Record<EngineResult["outcome"], string> = {
  applied: "✔",
  pending_approval: "⏳",
  blocked: "⛔",
  denied: "🚫",
  noop: "•",
};

export function formatResult(result: EngineResult): string {
  const style = OUTCOME_STYLE[result.outcome];
  const lines = [
    `${style(`${OUTCOME_ICON[result.outcome]} ${result.outcome.replace("_", " ")}`)}  ${result.message}`,
  ];
  if (result.approval) {
    lines.push(
      pc.dim(`   approval ${result.approval.id}: run `) +
        pc.bold(`flagguard approve ${result.record.flag} --env ${result.record.environment}`),
    );
  }
  if (result.health) lines.push(`   ${formatHealth(result.health)}`);
  return lines.join("\n");
}

export function percentBar(percentage: number, width = 20): string {
  const filled = Math.round((percentage / 100) * width);
  return pc.green("█".repeat(filled)) + pc.dim("░".repeat(width - filled));
}

const STATUS_STYLE: Record<RolloutRecord["status"], (s: string) => string> = {
  not_started: pc.dim,
  in_progress: pc.cyan,
  completed: pc.green,
  killed: (s) => pc.bold(pc.red(s)),
};

export function formatStatus(records: RolloutRecord[], production: Set<string>): string {
  const rows = records.map((r) => {
    const label = `${r.environment}${production.has(r.environment) ? " (prod)" : ""}`;
    // Pad before colouring: escape codes would otherwise count towards the width.
    const env = label.padEnd(24).replace(" (prod)", pc.dim(" (prod)"));
    const pending = r.pendingApproval
      ? pc.yellow(`  ⏳ awaiting approval → ${r.pendingApproval.targetPercentage}%`)
      : "";
    return `  ${env} ${percentBar(r.percentage)} ${String(r.percentage).padStart(3)}%  ${STATUS_STYLE[r.status](r.status.replace("_", " "))}${pending}`;
  });
  return rows.join("\n");
}

const rate = (s: CohortStats): string => `${(s.errorRate * 100).toFixed(1)}%`;

export function formatHealth(verdict: HealthVerdict): string {
  const label = {
    healthy: pc.green("healthy"),
    unhealthy: pc.bold(pc.red("UNHEALTHY")),
    platform_degraded: pc.yellow("platform degraded"),
    insufficient_data: pc.dim("collecting data"),
  }[verdict.status];
  const t = verdict.treatment;
  const c = verdict.control;
  return (
    `${label}  new: ${t.requests} req, ${rate(t)} err, p95 ${Math.round(t.p95LatencyMs)}ms` +
    pc.dim(`  │  `) +
    `old: ${c.requests} req, ${rate(c)} err, p95 ${Math.round(c.p95LatencyMs)}ms`
  );
}

const AUDIT_OUTCOME: Record<AuditEvent["outcome"], (s: string) => string> = {
  applied: pc.green,
  pending_approval: pc.yellow,
  blocked: pc.red,
  denied: pc.red,
  failed: (s) => pc.bold(pc.red(s)),
  observed: pc.dim,
};

export function formatAudit(event: AuditEvent): string {
  const time = new Date(event.timestamp).toLocaleString();
  const actor =
    event.actor === "agent" ? pc.magenta("🤖 agent") : pc.cyan(`🧑 ${event.actor.slice(6)}`);
  return `${pc.dim(time)}  ${actor.padEnd(22)} ${AUDIT_OUTCOME[event.outcome](event.outcome.padEnd(16))} ${pc.bold(event.action)} ${pc.dim(event.environment ?? "")}\n    ${event.reason}`;
}
