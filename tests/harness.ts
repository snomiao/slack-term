// One import for both runners.
//
// The suite runs twice: `bun test` is the day-to-day and CI path (a native
// runner — vitest-under-bun is what produced a month of six-hour CI hangs), and
// `vitest run --coverage` runs it again only to keep the istanbul coverage gate.
// That gate is why vitest stays at all: bun's coverage reports lines and
// functions only, and emits no branch data anywhere — not in the table, not in
// its lcov (measured on bun 1.3.13, no BRDA/BRF/BRH records). The branch
// threshold is load-bearing here, so it cannot be dropped.
//
// Test files import `describe`/`test`/`expect`/hooks/`vi` from here rather than
// from either runner directly. `vi` is re-shaped rather than renamed so the 118
// existing `vi.spyOn` call sites need no edit.

// Types come from vitest even when bun is the runner: its declarations are the
// superset this suite uses, so every call site keeps the inference it had
// before the split. Only the runtime object swaps.
import type * as Vitest from "vitest";
// Static, NOT `await import("vitest")`. Every test file imports this module, so
// a top-level await here makes each one an async module graph — and under a
// vitest worker that is a worker dynamically importing the very runtime that
// loaded it. Module evaluation has no timeout (testTimeout/hookTimeout cannot
// fire during it), which is why CI hung for the full job budget while never
// reporting a slow test or hook. A static import cannot re-enter.
//
// The bun branch stays dynamic because `bun:test` does not resolve under node —
// but that import is reached only when Bun is the runtime, so it never runs
// inside a vitest worker.
import * as VitestRuntime from "vitest";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runner: any = isBun ? await import("bun:test") : VitestRuntime;

export const describe: typeof Vitest.describe = runner.describe;
export const test: typeof Vitest.test = runner.test;
export const it: typeof Vitest.it = runner.it ?? runner.test;
export const expect: typeof Vitest.expect = runner.expect;
export const beforeAll: typeof Vitest.beforeAll = runner.beforeAll;
export const afterAll: typeof Vitest.afterAll = runner.afterAll;
export const beforeEach: typeof Vitest.beforeEach = runner.beforeEach;
export const afterEach: typeof Vitest.afterEach = runner.afterEach;

/** Replace a module for this test file. The two runners spell it differently
 *  AND schedule it differently: vitest's `vi.mock` is hoisted above the imports
 *  by an AST transform, which a wrapper like this one cannot be. `vi.doMock` is
 *  the un-hoisted form, so it applies only to imports issued AFTER the call —
 *  which is why the files using this import their subject with a dynamic
 *  `await import(...)` below the registration. Bun's `mock.module` applies
 *  retroactively and does not care, so the dynamic form satisfies both.
 *
 *  Under bun the replacement is process-wide, so the suite runs with
 *  `--isolate`; without it a mock registered here reaches every later file. */
export const mockModule: (specifier: string, factory: () => unknown) => void =
  isBun ? runner.mock.module : runner.vi.doMock;

/** The `vi` surface this suite actually uses, mapped onto whichever runner is
 *  live. Anything not listed is deliberately absent: an undefined method fails
 *  loudly at the call site, which beats a silent no-op. */
export const vi: typeof Vitest.vi = isBun
  ? ({
      fn: runner.mock,
      spyOn: runner.spyOn,
      // bun restores every spy at once; vitest's name for the same thing.
      restoreAllMocks: () => runner.mock.restore(),
      // Typing helper only — no runtime behaviour in either runner.
      mocked: <T>(x: T): T => x,
    } as unknown as typeof Vitest.vi)
  : runner.vi;
