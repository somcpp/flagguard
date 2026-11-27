import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import { defaultPolicy, loadPolicy, parsePolicy, parsePolicyYaml } from "../src/policy/load.js";

describe("policy defaults", () => {
  it("produces a complete, safe policy from just a version", () => {
    const policy = defaultPolicy();

    expect(policy.rollout.stages).toEqual([5, 25, 50, 100]);
    expect(policy.environments.map((e) => e.name)).toEqual([
      "Development",
      "Staging",
      "Production",
    ]);
    expect(policy.environments.find((e) => e.name === "Production")?.production).toBe(true);
    expect(policy.autonomy.actions.kill_flag).toBe("auto");
    expect(policy.autonomy.actions.advance_rollout).toBe("approval");
    expect(policy.risk.rules.map((r) => r.id)).toContain("payments");
  });

  it("merges partial overrides with defaults", () => {
    const policy = parsePolicy({ version: 1, rollout: { stages: [10, 100] } });

    expect(policy.rollout.stages).toEqual([10, 100]);
    expect(policy.rollout.minStageMinutes).toBe(10);
    expect(policy.guardrails.maxErrorRate).toBe(0.05);
  });
});

describe("policy validation", () => {
  const invalid: [string, unknown, RegExp][] = [
    ["missing version", {}, /version/],
    ["unknown top-level key", { version: 1, rollot: {} }, /rollot/],
    [
      "non-increasing stages",
      { version: 1, rollout: { stages: [5, 5, 100] } },
      /strictly increasing/,
    ],
    [
      "stages not ending at 100",
      { version: 1, rollout: { stages: [5, 50] } },
      /last stage must be 100/,
    ],
    [
      "risk-increasing action set to auto",
      { version: 1, autonomy: { actions: { advance_rollout: "auto" } } },
      /cannot be "auto"/,
    ],
    [
      "kill switch disabled",
      { version: 1, autonomy: { actions: { kill_flag: "never" } } },
      /safety net/,
    ],
    [
      "invalid regex pattern",
      { version: 1, risk: { rules: [{ id: "x", description: "x", weight: 10, patterns: ["("] }] } },
      /valid regular expression/,
    ],
    [
      "rule with neither paths nor patterns",
      { version: 1, risk: { rules: [{ id: "x", description: "x", weight: 10 }] } },
      /at least one path glob or content pattern/,
    ],
    [
      "duplicate environment names",
      { version: 1, environments: [{ name: "Prod" }, { name: "prod" }] },
      /unique/,
    ],
  ];

  it.each(invalid)("rejects %s", (_name, input, message) => {
    expect(() => parsePolicy(input)).toThrow(ConfigError);
    expect(() => parsePolicy(input)).toThrow(message);
  });

  it("allows risk-increasing autonomy only with an explicit opt-in", () => {
    const policy = parsePolicy({
      version: 1,
      autonomy: { allowUnsafe: true, actions: { advance_rollout: "auto" } },
    });
    expect(policy.autonomy.actions.advance_rollout).toBe("auto");
  });
});

describe("YAML loading", () => {
  it("reports YAML syntax errors as ConfigError", () => {
    expect(() => parsePolicyYaml("version: 1\nrollout: [")).toThrow(ConfigError);
  });

  it("finds .github/flagguard.yml and falls back to defaults", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flagguard-"));
    expect((await loadPolicy({ cwd: dir })).path).toBeNull();

    await mkdir(path.join(dir, ".github"));
    await writeFile(
      path.join(dir, ".github", "flagguard.yml"),
      "version: 1\nrollout:\n  stages: [1, 100]\n",
    );
    const loaded = await loadPolicy({ cwd: dir });
    expect(loaded.path).toBe(path.join(dir, ".github", "flagguard.yml"));
    expect(loaded.policy.rollout.stages).toEqual([1, 100]);
  });

  it("fails loudly when an explicit policy path does not exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flagguard-"));
    await expect(loadPolicy({ cwd: dir, explicitPath: "nope.yml" })).rejects.toThrow(
      /Policy file not found/,
    );
  });
});

describe("flagguard.example.yml", () => {
  it("is valid and documents exactly the built-in defaults", async () => {
    const examplePath = path.resolve(import.meta.dirname, "../../../flagguard.example.yml");
    const { policy } = await loadPolicy({ explicitPath: examplePath });
    expect(policy).toEqual(defaultPolicy());
  });
});
