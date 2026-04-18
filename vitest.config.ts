import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["ts/**/*.ts"],
      exclude: ["ts/cli.ts", "tests/**", "dist/**"],
      // Low starting thresholds — raise as fixtures and tests grow.
      thresholds: {
        lines: 20,
        branches: 5,
        functions: 20,
        statements: 20,
      },
    },
  },
});
