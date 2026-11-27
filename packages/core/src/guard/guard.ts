import { type FileDiff, parseUnifiedDiff } from "../diff/parse.js";
import type { LlmClient, LlmUsage } from "../llm/client.js";
import { type Logger, silentLogger } from "../logger.js";
import type { Policy } from "../policy/schema.js";
import {
  type CodeSuggestion,
  FLAG_PLACEHOLDER,
  type FileContext,
  reviewWithLlm,
} from "../risk/llm-review.js";
import { analyzeWithRules, type RiskFinding } from "../risk/rules.js";

export interface PullRequestInfo {
  title: string;
  body?: string | undefined;
  number?: number | undefined;
  branch?: string | undefined;
}

export interface GuardReport {
  /** True when the change should ship behind a flag. */
  risky: boolean;
  score: number;
  threshold: number;
  ruleScore: number;
  llmScore: number | null;
  mode: "llm" | "rules";
  /** Set when the LLM was configured but failed; the report fell back to rules. */
  llmError?: string;
  summary: string;
  findings: RiskFinding[];
  flag: { name: string; description: string } | null;
  suggestions: CodeSuggestion[];
  droppedSuggestions: number;
  usage?: LlmUsage & { model: string; failovers: number };
  filesChanged: number;
  filesConsidered: number;
  /** Rough, clearly-labelled estimate of manual work replaced. */
  estimatedMinutesSaved: number;
}

const SEVERITY_WEIGHT = { low: 10, medium: 25, high: 50 } as const;

/** Normalise any string into a valid, prefixed Flagsmith flag name. */
export function toFlagName(raw: string, prefix: string): string {
  let slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (prefix && slug.startsWith(prefix)) slug = slug.slice(prefix.length);
  slug = slug.slice(0, 50 - prefix.length).replace(/_+$/, "");
  return `${prefix}${slug || "risky_change"}`;
}

const GENERIC_NAMES = new Set([
  "flag",
  "feature",
  "feature_flag",
  "new_feature",
  "flag_name",
  "change",
  "risky_change",
  "toggle",
  "my_flag",
  "test",
]);

/** True for names that don't describe a behaviour (often an echoed placeholder). */
export function isGenericFlagName(name: string, prefix = ""): boolean {
  const bare = (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return bare.length < 4 || GENERIC_NAMES.has(bare) || bare.includes("flag_name");
}

function fallbackFlagName(pr: PullRequestInfo): string {
  const fromBranch = pr.branch?.split("/").pop();
  return fromBranch && fromBranch !== "main" ? fromBranch : pr.title;
}

function rulesSummary(findings: RiskFinding[]): string {
  const ids = [...new Set(findings.map((f) => f.description))];
  return ids.length === 0 ? "No risky patterns found." : `Matched risk rules: ${ids.join("; ")}.`;
}

/**
 * Analyse a pull request diff and decide whether it needs a flag.
 *
 * The rule engine is the deterministic floor. The LLM (if configured) can
 * raise the score, explain the risk in plain language and propose code that
 * wraps the change, but it can never talk FlagGuard out of a rule match.
 */
export async function analyzePullRequest(input: {
  diff: string;
  pr: PullRequestInfo;
  policy: Policy;
  llm?: LlmClient | null;
  /** Full new-file contents of changed files, so the AI sees helpers outside the hunks. */
  context?: FileContext;
  logger?: Logger;
}): Promise<GuardReport> {
  const logger = input.logger ?? silentLogger;
  const files: FileDiff[] = parseUnifiedDiff(input.diff);
  const rules = analyzeWithRules(files, input.policy.risk);
  const threshold = input.policy.risk.threshold;
  const prefix = input.policy.flags.prefix;

  const base = {
    threshold,
    ruleScore: rules.score,
    filesChanged: files.length,
    filesConsidered: rules.consideredFiles.length,
  };

  let llmError: string | undefined;
  if (input.llm && rules.consideredFiles.length > 0) {
    try {
      const result = await reviewWithLlm(input.llm, files, rules, input.pr, input.context);
      const score = Math.max(rules.score, result.review.riskScore);
      const risky = score >= threshold;
      const proposed = result.review.flag.name;
      const flagName = toFlagName(
        isGenericFlagName(proposed, prefix) ? fallbackFlagName(input.pr) : proposed,
        prefix,
      );
      const named = result.suggestions.map((s) => ({
        ...s,
        replacement: s.replacement
          .replaceAll(FLAG_PLACEHOLDER, flagName)
          .replaceAll("<FLAG>", flagName),
      }));
      // A suggestion that never mentions the new flag cannot gate the change on it
      // (models like to copy an existing flag variable instead), so it is dropped.
      const suggestions = named.filter((s) => s.replacement.includes(flagName));
      const llmFindings: RiskFinding[] = result.review.risks.map((r) => ({
        ruleId: `ai-${r.severity}`,
        description: r.reason,
        file: r.file,
        ...(r.line ? { line: r.line } : {}),
        evidence: r.reason,
        weight: SEVERITY_WEIGHT[r.severity],
        source: "llm",
      }));
      return {
        ...base,
        risky,
        score,
        llmScore: result.review.riskScore,
        mode: "llm",
        summary: result.review.summary,
        findings: [...rules.findings, ...llmFindings],
        flag: risky ? { name: flagName, description: result.review.flag.description } : null,
        suggestions: risky ? suggestions : [],
        droppedSuggestions: result.droppedSuggestions + (named.length - suggestions.length),
        usage: { ...result.usage, model: result.model, failovers: result.failovers },
        estimatedMinutesSaved: risky
          ? 15 + 5 * result.suggestions.length + 3 * input.policy.environments.length
          : 5,
      };
    } catch (error) {
      llmError = (error as Error).message;
      logger.warn("LLM review failed, falling back to rules", { error: llmError });
    }
  }

  const risky = rules.score >= threshold;
  return {
    ...base,
    risky,
    score: rules.score,
    llmScore: null,
    mode: "rules",
    ...(llmError ? { llmError } : {}),
    summary: rulesSummary(rules.findings),
    findings: rules.findings,
    flag: risky
      ? {
          name: toFlagName(fallbackFlagName(input.pr), prefix),
          description: `Guards: ${input.pr.title}`.slice(0, 300),
        }
      : null,
    suggestions: [],
    droppedSuggestions: 0,
    estimatedMinutesSaved: risky ? 10 + 3 * input.policy.environments.length : 2,
  };
}
