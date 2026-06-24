import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["ts/**/*.ts"],
      // Integration/interactive modules: OS keychain, browser cookie extraction,
      // interactive prompts, live-API diagnostics — not meaningfully unit-testable.
      exclude: ["ts/cli.ts", "ts/slack-app.ts", "ts/auth.ts", "ts/botdoctor.ts", "tests/**", "dist/**"],
      thresholds: {
        lines: 99,
        branches: 82,
        functions: 100,
        statements: 97,
      },
    },
  },
});
