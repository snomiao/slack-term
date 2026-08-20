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

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runner: any = isBun ? await import("bun:test") : await import("vitest");

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
