import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/diff/parse.js";
import { analyzePullRequest, isGenericFlagName, toFlagName } from "../src/guard/guard.js";
import { GUARD_COMMENT_MARKER, renderGuardComment } from "../src/guard/comment.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/llm/client.js";
import { defaultPolicy } from "../src/policy/load.js";
import { validateSuggestions } from "../src/risk/llm-review.js";
import { analyzeWithRules } from "../src/risk/rules.js";

const DIFF = `diff --git a/src/checkout/pay.ts b/src/checkout/pay.ts
index 1111111..2222222 100644
--- a/src/checkout/pay.ts
+++ b/src/checkout/pay.ts
@@ -1,4 +1,7 @@
 export async function pay(order) {
-  return legacyPay(order);
+  const intent = await stripe.paymentIntents.create({ amount: order.total });
+  await chargeCard(intent);
+  return intent;
 }
+
+export const VERSION = 2;
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Shop
+Now with Stripe.
diff --git a/src/utils/format.ts b/src/utils/format.ts
new file mode 100644
--- /dev/null
+++ b/src/utils/format.ts
@@ -0,0 +1,2 @@
+export const money = (c: number) => (c / 100).toFixed(2);
+export const pct = (n: number) => n + "%";
`;

class FakeLlm implements LlmClient {
  readonly provider = "fake";
  readonly model = "fake-1";
  requests: LlmRequest[] = [];
  constructor(private readonly reply: unknown) {}
  complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const reply = Array.isArray(this.reply)
      ? (this.reply as unknown[])[Math.min(this.requests.length - 1, this.reply.length - 1)]
      : this.reply;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      model: this.model,
      usage: { inputTokens: 1200, outputTokens: 300 },
    });
  }
}

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(DIFF);

  it("finds every file with its status", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/checkout/pay.ts", "modified"],
      ["README.md", "modified"],
      ["src/utils/format.ts", "added"],
    ]);
  });

  it("tracks added lines with new-file line numbers", () => {
    expect(files[0]?.added.map((a) => a.line)).toEqual([2, 3, 4, 6, 7]);
    expect(files[0]?.added[0]?.content).toContain("stripe.paymentIntents");
    expect(files[0]?.removedCount).toBe(1);
    expect(files[2]?.added.map((a) => a.line)).toEqual([1, 2]);
  });

  it("renders a numbered patch for LLM context", () => {
    expect(files[0]?.patch).toContain("   2 +  const intent");
    expect(files[0]?.patch).toContain("     -  return legacyPay(order);");
  });

  it("handles renames and deletions", () => {
    const parsed = parseUnifiedDiff(`diff --git a/a.ts b/b.ts
similarity index 90%
rename from a.ts
rename to b.ts
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-x
`);
    expect(parsed.map((f) => [f.path, f.status])).toEqual([
      ["b.ts", "renamed"],
      ["gone.ts", "deleted"],
    ]);
  });
});

describe("analyzeWithRules", () => {
  const policy = defaultPolicy();

  it("scores path and content matches, ignoring docs", () => {
    const analysis = analyzeWithRules(parseUnifiedDiff(DIFF), policy.risk);
    expect(analysis.consideredFiles).toEqual(["src/checkout/pay.ts", "src/utils/format.ts"]);
    expect(analysis.findings.map((f) => f.ruleId)).toContain("payments");
    expect(analysis.score).toBe(60);
  });

  it("scores zero for harmless changes", () => {
    const diff = DIFF.split("diff --git a/README.md")[1] ?? "";
    expect(
      analyzeWithRules(parseUnifiedDiff(`diff --git a/README.md${diff}`), policy.risk).score,
    ).toBe(0);
  });
});

describe("toFlagName", () => {
  it("produces valid, prefixed snake_case names", () => {
    expect(toFlagName("New Checkout Flow!", "fg_")).toBe("fg_new_checkout_flow");
    expect(toFlagName("fg_already_prefixed", "fg_")).toBe("fg_already_prefixed");
    expect(toFlagName("feature/express-pay", "fg_")).toBe("fg_feature_express_pay");
    expect(toFlagName("!!!", "fg_")).toBe("fg_risky_change");
    expect(toFlagName("x".repeat(100), "fg_").length).toBeLessThanOrEqual(50);
  });
});

describe("validateSuggestions", () => {
  const files = parseUnifiedDiff(DIFF);
  it("keeps suggestions on added lines and drops the rest", () => {
    const { valid, dropped } = validateSuggestions(
      [
        {
          file: "src/checkout/pay.ts",
          startLine: 2,
          endLine: 4,
          replacement: 'check("__FLAG_NAME__")',
          explanation: "ok",
        },
        {
          file: "src/checkout/pay.ts",
          startLine: 1,
          endLine: 2,
          replacement: "x",
          explanation: "context line",
        },
        {
          file: "nope.ts",
          startLine: 1,
          endLine: 1,
          replacement: "x",
          explanation: "unknown file",
        },
        {
          file: "src/checkout/pay.ts",
          startLine: 4,
          endLine: 2,
          replacement: "x",
          explanation: "inverted",
        },
      ],
      files,
    );
    expect(valid.map((s) => s.explanation)).toEqual(["ok"]);
    expect(dropped).toBe(3);
  });
});

describe("analyzePullRequest", () => {
  const policy = defaultPolicy();
  const pr = { title: "Pay with Stripe", branch: "feat/stripe-pay" };

  it("uses rules only when no LLM is configured", async () => {
    const report = await analyzePullRequest({ diff: DIFF, pr, policy });
    expect(report).toMatchObject({ mode: "rules", risky: true, score: 60, llmScore: null });
    expect(report.flag?.name).toBe("fg_stripe_pay");
  });

  it("lets the LLM raise risk, name the flag and suggest a wrap", async () => {
    const llm = new FakeLlm({
      riskScore: 85,
      summary: "Switches payments to Stripe with no fallback.",
      risks: [
        {
          file: "src/checkout/pay.ts",
          line: 3,
          severity: "high",
          reason: "Charges cards directly",
        },
      ],
      flag: { name: "Stripe Payments", description: "Route payments through Stripe" },
      suggestions: [
        {
          file: "src/checkout/pay.ts",
          startLine: 2,
          endLine: 4,
          replacement:
            'if (!(await flags.isEnabled("<FLAG>"))) return legacyPay(order);\n  const intent = 1;',
          explanation: "Fall back to legacyPay when the flag is off",
        },
      ],
    });
    const report = await analyzePullRequest({ diff: DIFF, pr, policy, llm });

    expect(report).toMatchObject({ mode: "llm", score: 85, ruleScore: 60, llmScore: 85 });
    expect(report.flag?.name).toBe("fg_stripe_payments");
    expect(report.suggestions[0]?.replacement).toContain('isEnabled("fg_stripe_payments")');
    expect(report.findings.some((f) => f.source === "llm")).toBe(true);
    expect(report.usage).toMatchObject({ model: "fake-1", inputTokens: 1200 });
    expect(llm.requests[0]?.prompt).toContain("Rule engine score: 60/100");
  });

  it("never lets the LLM lower the rule score", async () => {
    const llm = new FakeLlm({
      riskScore: 5,
      summary: "Looks fine",
      flag: { name: "x", description: "x" },
    });
    const report = await analyzePullRequest({ diff: DIFF, pr, policy, llm });
    expect(report.score).toBe(60);
    expect(report.risky).toBe(true);
  });

  it("falls back to rules when the LLM fails or returns garbage", async () => {
    for (const reply of [new Error("quota exceeded"), "not json", { riskScore: "high" }]) {
      const report = await analyzePullRequest({ diff: DIFF, pr, policy, llm: new FakeLlm(reply) });
      expect(report.mode).toBe("rules");
      expect(report.llmError).toBeDefined();
      expect(report.risky).toBe(true);
    }
  });

  it("does not call the LLM when only ignored files changed", async () => {
    const llm = new FakeLlm({});
    const docsOnly = `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Shop\n+More docs\n`;
    const report = await analyzePullRequest({ diff: docsOnly, pr, policy, llm });
    expect(llm.requests).toHaveLength(0);
    expect(report.risky).toBe(false);
  });
});

describe("renderGuardComment", () => {
  const policy = defaultPolicy();

  it("explains the risk, the flag, the plan and who decides", async () => {
    const report = await analyzePullRequest({
      diff: DIFF,
      pr: { title: "Pay with Stripe" },
      policy,
    });
    const md = renderGuardComment({ report, policy, dryRun: true });

    expect(md.startsWith(GUARD_COMMENT_MARKER)).toBe(true);
    expect(md).toContain("🔴 **60/100**");
    expect(md).toContain(`Ship it behind \`${report.flag?.name ?? ""}\``);
    expect(md).toContain("5% → 25% → 50% → 100%");
    expect(md).toMatch(/Start \/ advance production rollout \| 🧑 needs you/);
    expect(md).toMatch(/Kill the flag if the new code regresses \| 🤖 automatic/);
    expect(md).toContain("/flagguard approve");
  });

  it("says no flag is needed for safe changes", async () => {
    const report = await analyzePullRequest({
      diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n x\n+const y = 1;\n`,
      pr: { title: "tidy" },
      policy,
    });
    expect(renderGuardComment({ report, policy })).toContain("No flag needed");
  });
});

describe("live-PR regressions", () => {
  const policy = defaultPolicy();
  const pr = { title: "Add one-click express checkout", branch: "feat/express-checkout" };

  it("rejects generic flag names and falls back to the branch name", async () => {
    for (const name of ["flag", "__FLAG_NAME__", "<FLAG>", "feature", "fg_flag"]) {
      const llm = new FakeLlm({ riskScore: 80, summary: "s", flag: { name, description: "d" } });
      const report = await analyzePullRequest({ diff: DIFF, pr, policy, llm });
      expect(report.flag?.name, name).toBe("fg_express_checkout");
    }
  });

  it("replaces the placeholder and restores lost indentation in suggestions", async () => {
    const llm = new FakeLlm({
      riskScore: 80,
      summary: "s",
      flag: { name: "stripe_payments", description: "d" },
      suggestions: [
        {
          file: "src/checkout/pay.ts",
          startLine: 2,
          endLine: 3,
          replacement:
            'if (!isEnabled("__FLAG_NAME__")) return legacyPay(order);\nconst intent = 1;',
          explanation: "wrap",
        },
      ],
    });
    const report = await analyzePullRequest({ diff: DIFF, pr, policy, llm });
    expect(report.suggestions[0]?.replacement).toBe(
      '  if (!isEnabled("fg_stripe_payments")) return legacyPay(order);\n  const intent = 1;',
    );
  });

  it("gives the AI the full changed files so it can reuse existing helpers", async () => {
    const llm = new FakeLlm({
      riskScore: 80,
      summary: "s",
      flag: { name: "stripe_payments", description: "d" },
    });
    await analyzePullRequest({
      diff: DIFF,
      pr,
      policy,
      llm,
      context: {
        "src/checkout/pay.ts":
          "import { flags } from './flags';\nexport async function pay(order) {}",
      },
    });
    expect(llm.requests[0]?.prompt).toContain("Full new version of changed files");
    expect(llm.requests[0]?.prompt).toContain("   1  import { flags } from './flags';");
  });
});

describe("isGenericFlagName", () => {
  it("separates meaningful names from placeholders", () => {
    expect(isGenericFlagName("fg_flag", "fg_")).toBe(true);
    expect(isGenericFlagName("__FLAG_NAME__")).toBe(true);
    expect(isGenericFlagName("abc")).toBe(true);
    expect(isGenericFlagName("fg_express_checkout", "fg_")).toBe(false);
  });
});

describe("suggestions must gate on the new flag", () => {
  it("drops suggestions that reuse another flag instead of the new one", async () => {
    const llm = new FakeLlm({
      riskScore: 80,
      summary: "s",
      flag: { name: "stripe_payments", description: "d" },
      suggestions: [
        {
          file: "src/checkout/pay.ts",
          startLine: 2,
          endLine: 2,
          replacement: "if (await isEnabled(deps.flagName)) x();",
          explanation: "wrong flag",
        },
        {
          file: "src/checkout/pay.ts",
          startLine: 3,
          endLine: 3,
          replacement: 'if (await isEnabled("__FLAG_NAME__")) y();',
          explanation: "right flag",
        },
      ],
    });
    const report = await analyzePullRequest({
      diff: DIFF,
      pr: { title: "t" },
      policy: defaultPolicy(),
      llm,
    });
    expect(report.suggestions.map((s) => s.explanation)).toEqual(["right flag"]);
    expect(report.droppedSuggestions).toBe(1);
  });
});

describe("self-correction", () => {
  const wrong = {
    file: "src/checkout/pay.ts",
    startLine: 2,
    endLine: 3,
    replacement: ["if (await isEnabled(deps.flagName)) {", "  const intent = 1;"].join("\n"),
    explanation: "reuses the existing flag",
  };
  const fixedReplacement = ['if (await isEnabled("__FLAG_NAME__")) {', "  const intent = 1;"].join(
    "\n",
  );
  const review = {
    riskScore: 80,
    summary: "s",
    flag: { name: "stripe_payments", description: "d" },
    suggestions: [wrong],
  };

  it("tells the model what was wrong and accepts the fixed suggestion", async () => {
    const llm = new FakeLlm([
      review,
      { suggestions: [{ ...wrong, replacement: fixedReplacement, explanation: "fixed" }] },
    ]);
    const report = await analyzePullRequest({
      diff: DIFF,
      pr: { title: "t" },
      policy: defaultPolicy(),
      llm,
    });

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.prompt).toContain("never checks the new flag");
    expect(report.suggestions.map((s) => s.explanation)).toEqual(["fixed"]);
    expect(report.suggestions[0]?.replacement).toContain('"fg_stripe_payments"');
    expect(report).toMatchObject({ repairedSuggestions: 1, droppedSuggestions: 0 });
    expect(report.usage?.inputTokens).toBe(2400);
    expect(renderGuardComment({ report, policy: defaultPolicy() })).toContain("1 self-corrected");
  });

  it("explains out-of-range lines with the lines that were actually added", async () => {
    const llm = new FakeLlm([
      { ...review, suggestions: [{ ...wrong, startLine: 1, endLine: 2 }] },
      { suggestions: [] },
    ]);
    const report = await analyzePullRequest({
      diff: DIFF,
      pr: { title: "t" },
      policy: defaultPolicy(),
      llm,
    });
    expect(llm.requests[1]?.prompt).toContain("added lines in src/checkout/pay.ts: 2-4, 6-7");
    expect(report).toMatchObject({ repairedSuggestions: 0, droppedSuggestions: 1 });
  });

  it("does not retry when every suggestion is valid", async () => {
    const llm = new FakeLlm({
      ...review,
      suggestions: [{ ...wrong, replacement: fixedReplacement }],
    });
    await analyzePullRequest({ diff: DIFF, pr: { title: "t" }, policy: defaultPolicy(), llm });
    expect(llm.requests).toHaveLength(1);
  });
});
