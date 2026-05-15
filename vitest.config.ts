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
      thresholds: {
        lines: 99,
        branches: 82,
        functions: 100,
        statements: 97,
      },
    },
  },
});
