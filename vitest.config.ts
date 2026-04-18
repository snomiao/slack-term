import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["ts/**/*.ts"],
      exclude: ["ts/cli.ts", "ts/slack-app.ts", "tests/**", "dist/**"],
      // Low starting thresholds — raise as fixtures and tests grow.
      thresholds: {
        lines: 90,
        branches: 65,
        functions: 90,
        statements: 90,
      },
    },
  },
});
