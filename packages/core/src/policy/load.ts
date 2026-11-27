import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import { ConfigError } from "../errors.js";
import { type Policy, PolicySchema } from "./schema.js";

/** Locations searched (in order) when no explicit policy path is given. */
export const POLICY_FILE_CANDIDATES = [
  "flagguard.yml",
  "flagguard.yaml",
  ".github/flagguard.yml",
  ".github/flagguard.yaml",
] as const;

/** Validate an already-parsed policy object. */
export function parsePolicy(input: unknown, source = "policy"): Policy {
  const result = PolicySchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      `Invalid FlagGuard policy (${source}):\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/** The policy used when a repository has no flagguard.yml. */
export function defaultPolicy(): Policy {
  return parsePolicy({ version: 1 }, "built-in defaults");
}

/** Parse YAML text into a validated policy. */
export function parsePolicyYaml(text: string, source = "flagguard.yml"): Policy {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new ConfigError(`Could not parse ${source}: ${error.message}`, { cause: error });
    }
    throw error;
  }
  return parsePolicy(data ?? {}, source);
}

export interface LoadedPolicy {
  policy: Policy;
  /** Absolute path of the file that was loaded, or null when defaults were used. */
  path: string | null;
}

/**
 * Load the policy for a repository.
 *
 * - With `explicitPath`, that file must exist.
 * - Otherwise the first of {@link POLICY_FILE_CANDIDATES} found under `cwd` is used,
 *   falling back to {@link defaultPolicy}.
 */
export async function loadPolicy(
  options: { cwd?: string; explicitPath?: string } = {},
): Promise<LoadedPolicy> {
  const cwd = options.cwd ?? process.cwd();

  if (options.explicitPath) {
    const absolute = path.resolve(cwd, options.explicitPath);
    const text = await readFileOrNull(absolute);
    if (text === null) throw new ConfigError(`Policy file not found: ${absolute}`);
    return { policy: parsePolicyYaml(text, absolute), path: absolute };
  }

  for (const candidate of POLICY_FILE_CANDIDATES) {
    const absolute = path.resolve(cwd, candidate);
    const text = await readFileOrNull(absolute);
    if (text !== null) return { policy: parsePolicyYaml(text, absolute), path: absolute };
  }

  return { policy: defaultPolicy(), path: null };
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
