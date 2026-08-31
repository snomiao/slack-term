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
    // A wedged hook or teardown must REPORT, not consume the job budget.
    // Both default to 10s but were unset, and the defaults do not cover the
    // gap that actually bit here: a file that stops producing output between
    // tests leaves the run silent until the CI job timeout, with the last test
    // still marked green and no failure to point at. These make the runner say
    // where it stopped.
    hookTimeout: 20_000,
    teardownTimeout: 20_000,
    // One fresh process per test FILE.
    //
    // `todo.test.ts` replaces `ts/slack.ts` with `vi.doMock` and then imports
    // the module under test at top level. When an earlier file in the SAME
    // worker has already imported the real `ts/slack.ts`, that import can
    // deadlock on Node 24 — the condition tests/todo.test.ts documents at its
    // mockModule call. Module evaluation has no timeout (testTimeout,
    // hookTimeout and teardownTimeout all sit above it), so the run simply goes
    // silent with the last test still green and nothing to point at. Measured
    // in CI: tail and slack complete, todo starts and never finishes.
    //
    // `--no-file-parallelism` alone does NOT prevent this: it serialises files
    // but reuses the worker, which is exactly the sharing that triggers it.
    // Isolating per file costs a process spawn each and buys determinism.
    isolate: true,
    poolOptions: { forks: { singleFork: false }, threads: { singleThread: false } },
    fileParallelism: false,
    coverage: {
      // istanbul, not v8: the suite runs under bun, which does not implement
      // node's V8 coverage inspector. The v8 provider therefore reported 0% for
      // every file (failing every threshold), and in CI it hung the run outright
      // — six hours with no output at all, killed by the job timeout, on every
      // push for a month. istanbul instruments the source instead, so it is
      // runtime-agnostic and produces real numbers under bun.
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      // Listed positively rather than as `ts/**/*.ts` minus `exclude`. Both
      // produce the same REPORT — the numbers below are byte-identical either
      // way — but `include` is what decides which files istanbul INSTRUMENTS,
      // and `exclude` only drops them from the output afterwards. The glob
      // therefore paid to instrument ts/cli.ts (4200 lines) on every run and
      // then threw the result away.
      //
      // That cost is what made this job unrunnable in CI. Measured on Node 24
      // (GitHub's runner version; local dev is on 26 and hides it):
      //
      //   glob    2m59s   transform 19.6s + import 26.0s, tests only 13.1s
      //   listed    33s   same coverage, to the digit
      //
      // Node 26 does the same work in ~11s, which is why this reproduced only
      // in CI for months and read as a "hang" rather than as slowness.
      //
      // Keep this list in step with `exclude` below: a new ts/ module gets no
      // coverage until it is named here.
      include: [
        "ts/ask.ts",
        "ts/cache.ts",
        "ts/format.ts",
        "ts/poll.ts",
        "ts/profiles.ts",
        "ts/quietHours.ts",
        "ts/rtm.ts",
        "ts/slack.ts",
        "ts/tail.ts",
        "ts/todo.ts",
      ],
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
