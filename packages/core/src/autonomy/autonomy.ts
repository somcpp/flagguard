import type { AgentAction, AutonomyMode, Policy } from "../policy/schema.js";

export interface AutonomyContext {
  /** Whether the action targets a production environment. */
  production?: boolean;
}

export type AutonomyDecision =
  | { kind: "allow"; mode: "auto"; reason: string }
  | { kind: "needs_approval"; mode: "approval"; reason: string }
  | { kind: "deny"; mode: "never"; reason: string };

/**
 * The single place that decides whether the agent may act alone.
 *
 * Principle: the agent acts on its own when an action *reduces* risk (create a
 * disabled flag, kill a misbehaving flag) and asks a human whenever an action
 * *increases* how many real users run new code.
 */
export function decide(
  policy: Policy,
  action: AgentAction,
  context: AutonomyContext = {},
): AutonomyDecision {
  // Turning a flag on is only "non-production" when it really is.
  if (action === "enable_in_non_production" && context.production) {
    return {
      kind: "deny",
      mode: "never",
      reason: "Production environments are only enabled through a gated rollout",
    };
  }

  const mode: AutonomyMode = policy.autonomy.actions[action];
  switch (mode) {
    case "auto":
      return { kind: "allow", mode, reason: `Policy allows "${action}" without approval` };
    case "approval":
      return {
        kind: "needs_approval",
        mode,
        reason: `Policy requires human approval for "${action}"`,
      };
    case "never":
      return { kind: "deny", mode, reason: `Policy forbids "${action}"` };
  }
}
