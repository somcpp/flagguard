import { z } from "zod";

/**
 * Every side effect the agent can perform. Each one is mapped to an autonomy
 * mode in the policy, so a team decides exactly where the agent may act alone.
 */
export const AGENT_ACTIONS = [
  "create_flag",
  "suggest_code_patch",
  "enable_in_non_production",
  "start_rollout",
  "advance_rollout",
  "complete_rollout",
  "kill_flag",
  "open_cleanup_pr",
  "archive_flag",
] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];

/**
 * Actions that increase how many real users see new code (or remove a safety
 * net). These may only run without a human if the policy explicitly opts in.
 */
export const RISK_INCREASING_ACTIONS: ReadonlySet<AgentAction> = new Set([
  "start_rollout",
  "advance_rollout",
  "complete_rollout",
  "archive_flag",
]);

export const AutonomyModeSchema = z.enum(["auto", "approval", "never"]);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

const DEFAULT_AUTONOMY: Record<AgentAction, AutonomyMode> = {
  create_flag: "auto",
  suggest_code_patch: "auto",
  enable_in_non_production: "auto",
  start_rollout: "approval",
  advance_rollout: "approval",
  complete_rollout: "approval",
  kill_flag: "auto",
  open_cleanup_pr: "auto",
  archive_flag: "approval",
};

const AutonomySchema = z
  .object({
    /** Escape hatch for teams that really want risk-increasing actions to run unattended. */
    allowUnsafe: z.boolean().default(false),
    actions: z
      .object(
        Object.fromEntries(
          AGENT_ACTIONS.map((action) => [
            action,
            AutonomyModeSchema.default(DEFAULT_AUTONOMY[action]),
          ]),
        ) as Record<AgentAction, z.ZodDefault<typeof AutonomyModeSchema>>,
      )
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((autonomy, ctx) => {
    if (!autonomy.allowUnsafe) {
      for (const action of RISK_INCREASING_ACTIONS) {
        if (autonomy.actions[action] === "auto") {
          ctx.addIssue({
            code: "custom",
            path: ["actions", action],
            message: `"${action}" increases user exposure and cannot be "auto" unless autonomy.allowUnsafe is true`,
          });
        }
      }
    }
    if (autonomy.actions.kill_flag === "never") {
      ctx.addIssue({
        code: "custom",
        path: ["actions", "kill_flag"],
        message: `"kill_flag" is the safety net and cannot be "never" (use "approval" to require a human)`,
      });
    }
  });

const EnvironmentSchema = z
  .object({
    /** Environment name as shown in Flagsmith (matched case-insensitively). */
    name: z.string().min(1),
    /** Production environments only ever get flags turned on through a gated rollout. */
    production: z.boolean().default(false),
  })
  .strict();

const RiskRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "rule ids must be lowercase kebab-case"),
    description: z.string().min(1),
    /** Contribution to the 0-100 risk score when the rule matches. */
    weight: z.number().int().min(1).max(100),
    /** Glob patterns matched against changed file paths. */
    paths: z.array(z.string().min(1)).default([]),
    /** Regular expressions matched against added lines of the diff. */
    patterns: z
      .array(
        z.string().refine((source) => {
          try {
            new RegExp(source);
            return true;
          } catch {
            return false;
          }
        }, "must be a valid regular expression"),
      )
      .default([]),
  })
  .strict()
  .refine((rule) => rule.paths.length > 0 || rule.patterns.length > 0, {
    error: "a risk rule needs at least one path glob or content pattern",
  });

export type RiskRule = z.infer<typeof RiskRuleSchema>;

const DEFAULT_RISK_RULES: z.input<typeof RiskRuleSchema>[] = [
  {
    id: "payments",
    description: "Moves money: payments, checkout, billing or pricing",
    weight: 60,
    paths: ["**/{payment,payments,checkout,billing,pricing}/**", "**/*{payment,checkout,billing}*"],
    patterns: ["\\bstripe\\b", "\\b(charge|refund|invoice)\\w*\\("],
  },
  {
    id: "auth",
    description: "Authentication, sessions or permissions",
    weight: 50,
    paths: ["**/{auth,authn,authz,session,sessions,permissions}/**", "**/*{auth,login,session}*"],
    patterns: ["\\b(jwt|bcrypt|password|oauth)\\b"],
  },
  {
    id: "data-migration",
    description: "Database schema or data migrations",
    weight: 45,
    paths: ["**/migrations/**", "**/*.sql", "**/prisma/schema.prisma"],
    patterns: ["\\b(ALTER|DROP)\\s+TABLE\\b"],
  },
  {
    id: "external-integration",
    description: "Calls to third-party services",
    weight: 25,
    paths: ["**/{integrations,clients,webhooks}/**"],
    patterns: ["\\bfetch\\(\\s*[\"'`]https?://", "\\baxios\\."],
  },
];

const RiskSchema = z
  .object({
    /** Changes scoring at or above this get a flag. */
    threshold: z.number().int().min(1).max(100).default(50),
    /** Globs for files that never count towards risk (tests, docs...). */
    ignore: z
      .array(z.string())
      .default(["**/*.{test,spec}.*", "**/__tests__/**", "**/*.md", "docs/**"]),
    rules: z
      .array(RiskRuleSchema)
      .default(() => DEFAULT_RISK_RULES.map((r) => RiskRuleSchema.parse(r))),
  })
  .strict()
  .superRefine((risk, ctx) => {
    const seen = new Set<string>();
    risk.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", index, "id"],
          message: `duplicate rule id "${rule.id}"`,
        });
      }
      seen.add(rule.id);
    });
  });

const RolloutSchema = z
  .object({
    /** Percentage of users per stage. Strictly increasing and ending at 100. */
    stages: z
      .array(z.number().int().min(1).max(100))
      .min(1)
      .default([5, 25, 50, 100])
      .refine((stages) => stages.every((value, i) => i === 0 || value > (stages[i - 1] ?? 0)), {
        error: "stages must be strictly increasing",
      })
      .refine((stages) => stages.at(-1) === 100, { error: "the last stage must be 100" }),
    /** A stage must stay healthy at least this long before it may be advanced. */
    minStageMinutes: z.number().min(0).default(10),
  })
  .strict();

const GuardrailsSchema = z
  .object({
    /** Do not judge health before each cohort has seen this many requests. */
    minSamples: z.number().int().min(1).default(50),
    /** Absolute ceiling for the error rate of users on the new code (0-1). */
    maxErrorRate: z.number().min(0).max(1).default(0.05),
    /** Kill if new-code error rate exceeds old-code error rate by this factor. */
    maxErrorRateRatio: z.number().min(1).default(2),
    /** Kill if new-code p95 latency exceeds old-code p95 by this factor. */
    maxLatencyRatio: z.number().min(1).default(1.5),
  })
  .strict();

const FlagsSchema = z
  .object({
    /** Prefix for flags created by FlagGuard, so they are easy to find and clean up. */
    prefix: z
      .string()
      .regex(/^[a-z0-9_]*$/, "prefix may only contain lowercase letters, digits and underscores")
      .default("fg_"),
    /** Tag added to every FlagGuard flag description. */
    owner: z.string().default("flagguard"),
  })
  .strict();

const CleanupSchema = z
  .object({
    /** A flag fully rolled out and healthy for this long is proposed for removal. */
    staleAfterDays: z.number().int().min(1).default(7),
  })
  .strict();

export const PolicySchema = z
  .object({
    version: z.literal(1),
    environments: z
      .array(EnvironmentSchema)
      .min(1)
      .default([
        { name: "Development", production: false },
        { name: "Staging", production: false },
        { name: "Production", production: true },
      ])
      .refine((envs) => new Set(envs.map((e) => e.name.toLowerCase())).size === envs.length, {
        error: "environment names must be unique",
      }),
    flags: FlagsSchema.prefault({}),
    risk: RiskSchema.prefault({}),
    rollout: RolloutSchema.prefault({}),
    guardrails: GuardrailsSchema.prefault({}),
    autonomy: AutonomySchema.prefault({}),
    cleanup: CleanupSchema.prefault({}),
  })
  .strict();

/** Fully resolved policy with every default applied. */
export type Policy = z.infer<typeof PolicySchema>;
/** What users write in flagguard.yml (everything except `version` is optional). */
export type PolicyInput = z.input<typeof PolicySchema>;
