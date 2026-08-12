import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      // istanbul, not v8: the suite runs under bun, which does not implement
      // node's V8 coverage inspector. The v8 provider therefore reported 0% for
      // every file (failing every threshold), and in CI it hung the run outright
      // — six hours with no output at all, killed by the job timeout, on every
      // push for a month. istanbul instruments the source instead, so it is
      // runtime-agnostic and produces real numbers under bun.
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      include: ["ts/**/*.ts"],
      // Integration/interactive modules: OS keychain, browser cookie extraction,
      // interactive prompts, live-API diagnostics — not meaningfully unit-testable.
      exclude: ["ts/cli.ts", "ts/slack-app.ts", "ts/auth.ts", "ts/botdoctor.ts", "tests/**", "dist/**"],
      // Recalibrated for istanbul. These are NOT a relaxation of the standard:
      // istanbul counts every function expression, including the injectable
      // seam defaults that tests replace with spies (`now: () => Date.now()`,
      // `sleep`, `path`) — bodies that are unreachable by construction. v8 did
      // not count those, so the old `functions: 100` was 100% of a smaller set.
      // Each value sits just under the current measurement, so any real
      // regression still fails the build.
      thresholds: {
        lines: 99,
        branches: 82,
        functions: 96,
        statements: 96,
      },
    },
  },
});
