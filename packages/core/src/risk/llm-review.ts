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
  /** Suggestions that failed validation, even after one repair attempt. */
  droppedSuggestions: number;
  /** Suggestions that passed only after the model fixed them on feedback. */
  repairedSuggestions: number;
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

export interface RejectedSuggestion {
  suggestion: LlmReview["suggestions"][number];
  reason: string;
}

const usesNewFlag = (replacement: string): boolean =>
  replacement.includes(FLAG_PLACEHOLDER) || replacement.includes("<FLAG>");

/** Compact "12-14, 20" description of a file's added lines, for repair feedback. */
function addedRanges(file: FileDiff): string {
  const ranges: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const { line } of file.added) {
    if (start !== null && prev !== null && line === prev + 1) {
      prev = line;
      continue;
    }
    if (start !== null && prev !== null)
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = line;
    prev = line;
  }
  if (start !== null && prev !== null)
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(", ") || "none";
}

/**
 * Keep only suggestions that (1) replace a contiguous run of lines this PR added
 * and (2) gate on the NEW flag. Everything else is rejected with a reason the
 * model can act on.
 */
export function validateSuggestions(
  suggestions: LlmReview["suggestions"],
  files: FileDiff[],
): { valid: CodeSuggestion[]; dropped: number; rejected: RejectedSuggestion[] } {
  const valid: CodeSuggestion[] = [];
  const rejected: RejectedSuggestion[] = [];
  for (const s of suggestions) {
    const file = files.find((f) => f.path === s.file);
    if (!file) {
      rejected.push({ suggestion: s, reason: `${s.file} is not part of this diff` });
      continue;
    }
    const added = new Map(file.added.map((a) => [a.line, a.content]));
    const originals: string[] = [];
    let ok = s.endLine >= s.startLine;
    for (let line = s.startLine; ok && line <= s.endLine; line++) {
      const content = added.get(line);
      if (content === undefined) ok = false;
      else originals.push(content);
    }
    if (!ok) {
      rejected.push({
        suggestion: s,
        reason: `lines ${s.startLine}-${s.endLine} are not all lines added by this PR (added lines in ${s.file}: ${addedRanges(file)})`,
      });
      continue;
    }
    if (!usesNewFlag(s.replacement)) {
      rejected.push({
        suggestion: s,
        reason: `the replacement never checks the new flag; it must pass the string literal "${FLAG_PLACEHOLDER}" to the flag check instead of reusing another flag or flag variable`,
      });
      continue;
    }
    valid.push({ ...s, replacement: reindent(s.replacement, originals) });
  }
  return { valid, dropped: rejected.length, rejected };
}

function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(trimmed) as unknown;
}

const RepairSchema = z.object({ suggestions: LlmReviewSchema.shape.suggestions });

/** Ask a review, then give the model one chance to fix any suggestion that failed validation. */
export async function reviewWithLlm(
  llm: LlmClient,
  files: FileDiff[],
  rules: RuleAnalysis,
  pr: { title: string; body?: string | undefined },
  context: FileContext = {},
): Promise<LlmReviewResult> {
  const prompt = buildPrompt(files, rules, pr, context);
  const response = await llm.complete({ system: SYSTEM_PROMPT, prompt, json: true });
  const review = LlmReviewSchema.parse(extractJson(response.text));
  const first = validateSuggestions(review.suggestions, files);

  const usage = { ...response.usage };
  let failovers = response.failovers ?? 0;
  let model = response.model;
  let suggestions = first.valid;
  let dropped = first.dropped;
  let repaired = 0;

  if (first.rejected.length > 0) {
    // Self-correction: say precisely what was wrong and let the model try once more.
    const feedback = first.rejected
      .map(
        (r, i) =>
          `${i + 1}. ${r.suggestion.file}:${r.suggestion.startLine}-${r.suggestion.endLine} was rejected: ${r.reason}.\n   Your replacement was:\n${r.suggestion.replacement}`,
      )
      .join("\n");
    try {
      const retry = await llm.complete({
        system: SYSTEM_PROMPT,
        prompt: `${prompt}\n\nYour flag is "${review.flag.name}". These suggestions you proposed were rejected by validation:\n${feedback}\n\nReturn JSON {"suggestions": [...]} with corrected versions of ONLY these suggestions, following every rule. Return an empty list for any you cannot fix correctly.`,
        json: true,
      });
      usage.inputTokens += retry.usage.inputTokens;
      usage.outputTokens += retry.usage.outputTokens;
      failovers += retry.failovers ?? 0;
      model = retry.model;
      const second = validateSuggestions(
        RepairSchema.parse(extractJson(retry.text)).suggestions,
        files,
      );
      const room = Math.max(0, 3 - suggestions.length);
      // Models often echo back suggestions that were already fine; only count genuinely new ones.
      const overlaps = (a: CodeSuggestion, b: CodeSuggestion): boolean =>
        a.file === b.file && a.startLine <= b.endLine && b.startLine <= a.endLine;
      const fixed = second.valid
        .filter((candidate) => !suggestions.some((kept) => overlaps(kept, candidate)))
        .slice(0, room);
      suggestions = [...suggestions, ...fixed];
      repaired = fixed.length;
      dropped = first.dropped - repaired;
    } catch {
      // The first verdict stands; an unrepaired suggestion is simply not posted.
    }
  }

  return {
    review,
    suggestions,
    droppedSuggestions: dropped,
    repairedSuggestions: repaired,
    usage,
    model,
    failovers,
  };
}
