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

const SYSTEM_PROMPT = `You are FlagGuard, a release-safety reviewer. You review pull request diffs and decide
whether the change should ship behind a Flagsmith feature flag with a gradual rollout.

Judge risk by blast radius if the change misbehaves in production: money movement, auth and
permissions, data migrations, external integrations, performance on hot paths, and broad
behaviour changes are risky. Refactors, tests, docs and copy changes usually are not.

Rules:
- A deterministic rule engine has already scored the diff. Your riskScore may be HIGHER than
  the rule score if you see risk it missed. It is never used to lower the rule score.
- Reference only files and line numbers that appear in the diff (numbers are new-file lines).
- Flag names: lowercase snake_case, short, describing the behaviour (e.g. "new_checkout_flow").
  Do not include any prefix; it is added for you.
- Suggestions wrap the NEW behaviour behind the flag so that, with the flag off, the old
  behaviour runs. Each suggestion replaces lines startLine..endLine (inclusive) of the new file,
  and those lines must all be ADDED lines (marked "+") in the diff. Keep indentation. Reuse
  the project's existing Flagsmith usage if visible; otherwise use
  \`(await flagsmith.getIdentityFlags(userId)).isFeatureEnabled("<FLAG>")\` and keep it compiling.
  Use the literal placeholder <FLAG> for the flag name. At most 3 suggestions, only where
  they clearly help. Prefer zero suggestions to a wrong one.
- Be concise and specific. No markdown in fields.

Respond with JSON only:
{"riskScore": 0-100, "summary": string, "risks": [{"file", "line"?, "severity": "low"|"medium"|"high", "reason"}],
 "flag": {"name", "description"}, "suggestions": [{"file", "startLine", "endLine", "replacement", "explanation"}]}`;

const MAX_PATCH_CHARS = 60_000;

function buildPrompt(
  files: FileDiff[],
  rules: RuleAnalysis,
  pr: { title: string; body?: string | undefined },
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
${sections.join("\n")}`;
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
    const added = new Set(file.added.map((a) => a.line));
    let ok = true;
    for (let line = s.startLine; line <= s.endLine; line++) {
      if (!added.has(line)) {
        ok = false;
        break;
      }
    }
    if (ok) valid.push({ ...s });
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
): Promise<LlmReviewResult> {
  const response = await llm.complete({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(files, rules, pr),
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
