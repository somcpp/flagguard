import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` from the current directory, then from the repository root, without
 * overriding variables that are already set. Uses Node's built-in loader.
 */
export function loadDotEnv(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const file of [path.resolve(".env"), path.join(repoRoot, ".env")]) {
    if (existsSync(file)) {
      const before = { ...process.env };
      process.loadEnvFile(file);
      Object.assign(process.env, before); // already-set variables win
    }
  }
}
