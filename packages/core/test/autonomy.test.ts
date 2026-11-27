import { describe, expect, it } from "vitest";
import { decide } from "../src/autonomy/autonomy.js";
import { defaultPolicy, parsePolicy } from "../src/policy/load.js";

describe("autonomy decisions", () => {
  const policy = defaultPolicy();

  it("acts alone on risk-reducing actions", () => {
    expect(decide(policy, "create_flag").kind).toBe("allow");
    expect(decide(policy, "kill_flag", { production: true }).kind).toBe("allow");
  });

  it("asks a human before exposing more users", () => {
    for (const action of ["start_rollout", "advance_rollout", "complete_rollout"] as const) {
      expect(decide(policy, action, { production: true }).kind).toBe("needs_approval");
    }
  });

  it("never enables a production environment outside a rollout", () => {
    const decision = decide(policy, "enable_in_non_production", { production: true });
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toMatch(/gated rollout/);
  });

  it("respects actions the policy forbids", () => {
    const strict = parsePolicy({ version: 1, autonomy: { actions: { open_cleanup_pr: "never" } } });
    expect(decide(strict, "open_cleanup_pr").kind).toBe("deny");
  });
});
