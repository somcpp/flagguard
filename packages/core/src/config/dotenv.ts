import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Load the nearest `.env`, searching from `cwd` up to the filesystem root.
 * Variables already set in the environment win, so CI secrets and shell
 * exports always override the file. Returns the file used, or null.
 */
export function loadDotEnv(cwd: string = process.cwd()): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      const preset = { ...process.env };
      process.loadEnvFile(file);
      Object.assign(process.env, preset);
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
