import { z } from "zod";
import type { FileDiff } from "../diff/parse.js";
import type { LlmClient, LlmUsage } from "../llm/client.js";
import type { RuleAnalysis } from "./rules.js";

export const LlmReviewSchema = z.object({
  riskScore: z.number().int().min(0).max(100),
  summary: z.string().min(1).max(1200),
  risks: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive().optional(),
        severity: z.enum(["low", "medium", "high"]),
        reason: z.string().min(1).max(400),
      }),
    )
    .max(10)
    .default([]),
  flag: z.object({
    name: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
  }),
  suggestions: z
    .array(
      z.object({
        file: z.string(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        replacement: z.string().min(1).max(6000),
        explanation: z.string().min(1).max(400),
      }),
    )
    .max(3)
    .default([]),
});

export type LlmReview = z.infer<typeof LlmReviewSchema>;

export interface CodeSuggestion {
  file: string;
  startLine: number;
  endLine: number;
  replacement: string;
  explanation: string;
}

export interface LlmReviewResult {
  review: LlmReview;
  /** Suggestions that target only lines added in this diff (safe to post as GitHub suggestions). */
  suggestions: CodeSuggestion[];
  /** Suggestions dropped because they pointed outside the added lines. */
  droppedSuggestions: number;
  usage: LlmUsage;
  model: string;
  /** Keys/models/providers that failed before one answered. */
  failovers: number;
}

/** Placeholder the model must use for the flag name inside suggested code. */
export const FLAG_PLACEHOLDER = "__FLAG_NAME__";

const SYSTEM_PROMPT = `You are FlagGuard, a release-safety reviewer. You review pull request diffs and decide
whether the change should ship behind a Flagsmith feature flag with a gradual rollout.

Judge risk by blast radius if the change misbehaves in production: money movement, auth and
permissions, data migrations, external integrations, performance on hot paths, and broad
behaviour changes are risky. Refactors, tests, docs and copy changes usually are not.

Rules:
- A deterministic rule engine has already scored the diff. Your riskScore may be HIGHER than
  the rule score if you see risk it missed. It is never used to lower the rule score.
- Reference only files and line numbers that appear in the diff (numbers are new-file lines).
- flag.name: lowercase snake_case naming the BEHAVIOUR being released, 2-5 words, e.g.
  "express_checkout" or "stripe_payments". Never generic words like "flag" or "feature", and
  no prefix (one is added for you).
- Suggestions make the NEW behaviour run only when the flag is on, and the old behaviour (or
  a clean "not available" response for brand-new endpoints) when it is off:
  * Put the flag check INSIDE the function or request handler, where a user/customer
    identifier is in scope. Never wrap route registration, imports or module-level code.
  * Reuse the project's existing feature-flag helper when the full file shows one (for
    example a provider/service with an isEnabled(flag, userId) method). Only if there is none,
    use \`(await flagsmith.getIdentityFlags(userId)).isFeatureEnabled(...)\`.
  * Pass the NEW flag's name as the string literal "${FLAG_PLACEHOLDER}" (it is replaced for
    you). Never pass another flag's name or a variable that holds one (e.g. an existing
    flagName config value): that would gate the change on the wrong flag. Example: if the
    file has \`await deps.provider.isEnabled(deps.flagName, userId)\`, write
    \`await deps.provider.isEnabled("${FLAG_PLACEHOLDER}", customerId)\`.
  * A suggestion replaces lines startLine..endLine (inclusive) of the new file, all of which
    must be ADDED lines ("+") in the diff. Copy the original indentation exactly.
  * The replacement must compile in context. At most 3 suggestions. Prefer zero to a wrong one.
- Be concise and specific. No markdown in fields.

Respond with JSON only:
{"riskScore": 0-100, "summary": string, "risks": [{"file", "line"?, "severity": "low"|"medium"|"high", "reason"}],
 "flag": {"name", "description"}, "suggestions": [{"file", "startLine", "endLine", "replacement", "explanation"}]}`;

const MAX_PATCH_CHARS = 60_000;
const MAX_CONTEXT_CHARS = 40_000;

/** Full new-file contents keyed by path, so the model sees helpers outside the diff hunks. */
export type FileContext = Record<string, string>;

function numbered(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
    .join("\n");
}

function buildPrompt(
  files: FileDiff[],
  rules: RuleAnalysis,
  pr: { title: string; body?: string | undefined },
  context: FileContext = {},
): string {
  const flagged = new Set(rules.findings.map((f) => f.file));
  // Files the rules flagged first, so truncation drops the least relevant context.
  const ordered = [...files].sort(
    (a, b) => Number(flagged.has(b.path)) - Number(flagged.has(a.path)),
  );

  let budget = MAX_PATCH_CHARS;
  const sections: string[] = [];
  for (const file of ordered) {
    if (file.status === "deleted") continue;
    const section = `### ${file.path} (${file.status})\n${file.patch}`;
    if (section.length > budget) {
      sections.push(`### ${file.path} (${file.status})\n[diff omitted: too large]`);
      continue;
    }
    budget -= section.length;
    sections.push(section);
  }

  let contextBudget = MAX_CONTEXT_CHARS;
  const contextSections: string[] = [];
  for (const file of ordered) {
    const content = context[file.path];
    if (content === undefined || content.length > contextBudget) continue;
    contextBudget -= content.length;
    contextSections.push(`### ${file.path}\n${numbered(content)}`);
  }

  const findings =
    rules.findings.length === 0
      ? "none"
      : rules.findings
          .map(
            (f) =>
              `- [${f.ruleId}, weight ${f.weight}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.evidence}`,
          )
          .join("\n");

  return `Pull request: ${pr.title}
${pr.body ? `Description:\n${pr.body.slice(0, 2000)}\n` : ""}
Rule engine score: ${rules.score}/100
Rule findings:
${findings}

Diff (line numbers are new-file lines; "+" = added, "-" = removed):
${sections.join("\n")}
${contextSections.length > 0 ? `\nFull new version of changed files (for context only; line numbers match the diff):\n${contextSections.join("\n")}` : ""}`;
}

const leadingSpace = (line: string): number => /^[ \t]*/.exec(line)?.[0].length ?? 0;

/**
 * Models often drop the original indentation. Shift the replacement so its
 * least-indented line lines up with the least-indented original line.
 */
export function reindent(replacement: string, originalLines: string[]): string {
  const nonEmpty = (lines: string[]): string[] => lines.filter((l) => l.trim() !== "");
  const original = nonEmpty(originalLines);
  const lines = replacement.replace(/\n+$/, "").split("\n");
  if (original.length === 0 || nonEmpty(lines).length === 0) return lines.join("\n");
  const want = Math.min(...original.map(leadingSpace));
  const have = Math.min(...nonEmpty(lines).map(leadingSpace));
  if (have >= want) return lines.join("\n");
  const pad = " ".repeat(want - have);
  return lines.map((l) => (l.trim() === "" ? l : pad + l)).join("\n");
}

/** Keep only suggestions that replace a contiguous run of lines this PR added. */
export function validateSuggestions(
  suggestions: LlmReview["suggestions"],
  files: FileDiff[],
): { valid: CodeSuggestion[]; dropped: number } {
  const valid: CodeSuggestion[] = [];
  for (const s of suggestions) {
    const file = files.find((f) => f.path === s.file);
    if (!file || s.endLine < s.startLine) continue;
    const added = new Map(file.added.map((a) => [a.line, a.content]));
    const originals: string[] = [];
    let ok = true;
    for (let line = s.startLine; line <= s.endLine; line++) {
      const content = added.get(line);
      if (content === undefined) {
        ok = false;
        break;
      }
      originals.push(content);
    }
    if (ok) valid.push({ ...s, replacement: reindent(s.replacement, originals) });
  }
  return { valid, dropped: suggestions.length - valid.length };
}

function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(trimmed) as unknown;
}

/** Ask the LLM for a second opinion on the diff. Throws on malformed output. */
export async function reviewWithLlm(
  llm: LlmClient,
  files: FileDiff[],
  rules: RuleAnalysis,
  pr: { title: string; body?: string | undefined },
  context: FileContext = {},
): Promise<LlmReviewResult> {
  const response = await llm.complete({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(files, rules, pr, context),
    json: true,
  });
  const review = LlmReviewSchema.parse(extractJson(response.text));
  const { valid, dropped } = validateSuggestions(review.suggestions, files);
  return {
    review,
    suggestions: valid,
    droppedSuggestions: dropped,
    usage: response.usage,
    model: response.model,
    failovers: response.failovers ?? 0,
  };
}
