import { decide } from "../autonomy/autonomy.js";
import type { Policy } from "../policy/schema.js";
import type { EngineResult } from "../rollout/engine.js";
import type { RolloutRecord } from "../rollout/state.js";
import type { GuardReport } from "./guard.js";

/** Hidden marker so the bot edits its own comment instead of posting a new one each push. */
export const GUARD_COMMENT_MARKER = "<!-- flagguard:guard -->";

const scoreBadge = (score: number, threshold: number): string =>
  score >= threshold
    ? `🔴 **${score}/100**`
    : score >= threshold / 2
      ? `🟡 **${score}/100**`
      : `🟢 **${score}/100**`;

const escapeCell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderGuardComment(options: {
  report: GuardReport;
  policy: Policy;
  flagResults?: EngineResult[];
  dryRun?: boolean;
}): string {
  const { report, policy } = options;
  const lines: string[] = [GUARD_COMMENT_MARKER, "## 🛡️ FlagGuard release review", ""];

  lines.push(
    `**Risk** ${scoreBadge(report.score, report.threshold)} (threshold ${report.threshold}) · ` +
      `rules ${report.ruleScore}${report.llmScore !== null ? ` · AI ${report.llmScore}` : ""} · ` +
      `${report.filesConsidered}/${report.filesChanged} files considered`,
    "",
    `> ${report.summary.replace(/\n/g, "\n> ")}`,
    "",
  );

  if (report.llmError) {
    lines.push(
      `⚠️ AI review unavailable (${escapeCell(report.llmError.slice(0, 160))}); used rules only.`,
      "",
    );
  }

  if (report.findings.length > 0) {
    lines.push(
      "<details><summary><b>Why</b> (" + String(report.findings.length) + " findings)</summary>",
      "",
    );
    lines.push("| Source | Where | Finding |", "| --- | --- | --- |");
    for (const f of report.findings.slice(0, 15)) {
      const where = `\`${f.file}${f.line ? `:${f.line}` : ""}\``;
      const source = f.source === "llm" ? "🤖 AI" : `📏 ${f.ruleId}`;
      lines.push(
        `| ${source} | ${where} | ${escapeCell(f.source === "llm" ? f.description : `${f.description}: \`${f.evidence}\``)} |`,
      );
    }
    lines.push("", "</details>", "");
  }

  if (!report.risky || !report.flag) {
    lines.push(
      "✅ **No flag needed.** This change is below the risk threshold, so it can ship normally.",
    );
    return finish(lines, report);
  }

  lines.push(`### 🚩 Ship it behind \`${report.flag.name}\``, "", report.flag.description, "");

  if (options.flagResults) {
    lines.push("| Environment | State | |", "| --- | --- | --- |");
    for (const result of options.flagResults) {
      const env = policy.environments.find((e) => e.name === result.record.environment);
      lines.push(
        `| ${result.record.environment}${env?.production ? " (prod)" : ""} | ${stateLabel(result.record)} | ${escapeCell(result.message)} |`,
      );
    }
    lines.push("");
  } else if (options.dryRun) {
    lines.push("_Dry run: no flag was created in Flagsmith._", "");
  }

  if (report.suggestions.length > 0) {
    lines.push(
      `💡 I left **${report.suggestions.length} suggested change${report.suggestions.length > 1 ? "s" : ""}** inline that wrap the new code in this flag. Review them, then click _Commit suggestion_.${report.repairedSuggestions > 0 ? ` (${report.repairedSuggestions} self-corrected after failing validation the first time.)` : ""}`,
      "",
    );
  } else if (report.droppedSuggestions > 0) {
    lines.push(
      `💡 The AI proposed ${report.droppedSuggestions} code change${report.droppedSuggestions > 1 ? "s" : ""}, but ${report.droppedSuggestions > 1 ? "they" : "it"} failed validation (wrong lines, or not gated on \`${report.flag.name}\`), so none ${report.droppedSuggestions > 1 ? "were" : "was"} posted. Wrap the new code in a check for this flag manually.`,
      "",
    );
  }

  const stages = policy.rollout.stages.map((s) => `${s}%`).join(" → ");
  lines.push(
    "### Rollout plan",
    "",
    `**${stages}** in production, at least ${policy.rollout.minStageMinutes} min per stage. Each stage needs at least ${policy.guardrails.minSamples} requests on the new code, and it's killed if errors exceed ${(policy.guardrails.maxErrorRate * 100).toFixed(0)}% or ${policy.guardrails.maxErrorRateRatio}× the old code, or p95 latency exceeds ${policy.guardrails.maxLatencyRatio}× the old code.`,
    "",
  );

  const who = (action: Parameters<typeof decide>[1], production = true): string => {
    const decision = decide(policy, action, { production });
    return decision.kind === "allow"
      ? "🤖 automatic"
      : decision.kind === "needs_approval"
        ? "🧑 needs you"
        : "🚫 never";
  };
  lines.push(
    "| Step | Who decides |",
    "| --- | --- |",
    `| Create flag, enable outside production | ${who("create_flag", false)} |`,
    `| Start / advance production rollout | ${who("start_rollout")} |`,
    `| Kill the flag if the new code regresses | ${who("kill_flag")} |`,
    `| Remove the flag once fully rolled out | ${who("open_cleanup_pr")} |`,
    "",
    "<details><summary><b>Commands</b> (comment on this PR)</summary>",
    "",
    "| Comment | Effect |",
    "| --- | --- |",
    "| `/flagguard status` | Rollout state in every environment |",
    "| `/flagguard approve` | Approve the next production stage (health is checked first) |",
    "| `/flagguard reject` | Decline the pending stage |",
    "| `/flagguard kill` | Kill switch: flag off for everyone in production |",
    "",
    "Only repository owners, members and collaborators can run commands.",
    "</details>",
    "",
  );
  return finish(lines, report);
}

function stateLabel(record: RolloutRecord): string {
  if (record.status === "killed") return "🛑 killed";
  if (record.percentage === 100) return "🟢 on";
  if (record.percentage === 0) return "⚪ off";
  return `🟡 ${record.percentage}%`;
}

function finish(lines: string[], report: GuardReport): string {
  const usage = report.usage
    ? ` · ${report.usage.model}${report.usage.failovers > 0 ? ` (after ${report.usage.failovers} failover${report.usage.failovers > 1 ? "s" : ""})` : ""}, ${report.usage.inputTokens.toLocaleString("en-US")} in / ${report.usage.outputTokens.toLocaleString("en-US")} out tokens`
    : "";
  lines.push(
    "---",
    `<sub>FlagGuard · ${report.mode === "llm" ? "rules + AI review" : "rules only"}${usage} · saved ~${report.estimatedMinutesSaved} min of manual flag setup (estimate)</sub>`,
  );
  return lines.join("\n");
}

/** Markdown reply for a `/flagguard <command>` comment. */
export function renderCommandReply(
  command: string,
  results: { title: string; body: string }[],
): string {
  return [
    `🛡️ **FlagGuard** · \`/flagguard ${command}\``,
    "",
    ...results.flatMap((r) => [`**${r.title}**`, r.body, ""]),
  ].join("\n");
}

export function renderStatusTable(records: RolloutRecord[], policy: Policy): string {
  const rows = records.map((r) => {
    const prod = policy.environments.find((e) => e.name === r.environment)?.production;
    const pending = r.pendingApproval
      ? ` (awaiting approval → ${r.pendingApproval.targetPercentage}%)`
      : "";
    return `| ${r.environment}${prod ? " (prod)" : ""} | ${stateLabel(r)}${pending} |`;
  });
  return ["| Environment | State |", "| --- | --- |", ...rows].join("\n");
}
