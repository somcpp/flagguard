import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Test workspace packages against their sources, so no build step is needed first.
    alias: [
      { find: "@flagguard/core/testing", replacement: src("./packages/core/src/testing/index.ts") },
      { find: /^@flagguard\/core$/, replacement: src("./packages/core/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "examples/*/src/**/*.ts"],
    },
  },
});
