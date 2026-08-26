import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Tests that drive the CLI as a SUBPROCESS are excluded from this run.
    //
    // They cannot contribute coverage even in principle: istanbul instruments
    // this process, while those tests `spawn("bun", [cli.ts, ...])` into a
    // separate one whose counters nothing collects. And the file they exercise,
    // `ts/cli.ts`, is already in `coverage.exclude` below — so the measured
    // numbers are the same with or without them (verified 2026-08-26: branches
    // 83.75% excluded vs 83.40% included; every threshold still passes).
    //
    // What they cost is the entire CI budget. Each test spawns a `bun` process
    // and stands up an HTTP mock server; under `--no-file-parallelism` those
    // serialise, and in CI the run went silent after ~24s and was killed by the
    // 15-minute job timeout — every push, never once green. Locally the same
    // command takes 4m40s against 14s for `bun run test`.
    //
    // They are NOT skipped: `bun run test` runs the whole suite, subprocess
    // tests included, as its own CI step. This exclusion only scopes the
    // second, coverage-measuring pass to the code it can actually measure.
    exclude: [
      "tests/parity.test.ts", // also needs the release Rust binary, which CI does not build
      "tests/send.test.ts",
      "tests/ask.test.ts",
      "tests/channel.test.ts",
      "tests/search.test.ts",
      "tests/drafts.test.ts",
      "tests/read-thread.test.ts",
      "tests/upload.test.ts",
      "tests/todo-cli.test.ts",
      "node_modules/**",
    ],
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
