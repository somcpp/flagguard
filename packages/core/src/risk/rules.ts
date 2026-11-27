import picomatch from "picomatch";
import type { FileDiff } from "../diff/parse.js";
import type { Policy } from "../policy/schema.js";

export interface RiskFinding {
  ruleId: string;
  description: string;
  file: string;
  /** Line in the new file for content matches; absent for path matches. */
  line?: number;
  evidence: string;
  weight: number;
  source: "rules" | "llm";
}

export interface RuleAnalysis {
  /** 0-100: sum of the weights of distinct matched rules, capped. */
  score: number;
  findings: RiskFinding[];
  /** Files that count towards risk (not ignored, not deleted). */
  consideredFiles: string[];
}

const MAX_FINDINGS_PER_RULE = 5;

/**
 * Deterministic, explainable risk scoring from flagguard.yml rules. This is
 * the floor: the LLM review can raise the score but never lower it.
 */
export function analyzeWithRules(files: FileDiff[], risk: Policy["risk"]): RuleAnalysis {
  const isIgnored = picomatch(risk.ignore, { dot: true });
  const considered = files.filter((f) => f.status !== "deleted" && !isIgnored(f.path));

  const findings: RiskFinding[] = [];
  const matchedRules = new Set<string>();

  for (const rule of risk.rules) {
    const pathMatch =
      rule.paths.length > 0 ? picomatch(rule.paths, { dot: true, nocase: true }) : null;
    const patterns = rule.patterns.map((source) => new RegExp(source, "i"));
    let count = 0;

    for (const file of considered) {
      if (count >= MAX_FINDINGS_PER_RULE) break;
      if (pathMatch?.(file.path)) {
        findings.push({
          ruleId: rule.id,
          description: rule.description,
          file: file.path,
          evidence: `path matches ${rule.paths.join(", ")}`,
          weight: rule.weight,
          source: "rules",
        });
        matchedRules.add(rule.id);
        count++;
        continue;
      }
      for (const added of file.added) {
        const hit = patterns.find((p) => p.test(added.content));
        if (!hit) continue;
        findings.push({
          ruleId: rule.id,
          description: rule.description,
          file: file.path,
          line: added.line,
          evidence: added.content.trim().slice(0, 160),
          weight: rule.weight,
          source: "rules",
        });
        matchedRules.add(rule.id);
        count++;
        break; // one content finding per file per rule keeps reports readable
      }
    }
  }

  const score = Math.min(
    100,
    risk.rules.filter((r) => matchedRules.has(r.id)).reduce((sum, r) => sum + r.weight, 0),
  );
  return { score, findings, consideredFiles: considered.map((f) => f.path) };
}
