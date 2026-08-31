import { describe, test, expect, vi, beforeEach } from "./harness.ts";
import {
  DEFAULT_SEED_GAP_MS,
  isTestEnv,
  seedGapMs,
  seedReactionsInOrder,
  _internals,
} from "../ts/reactionSeed.ts";

// Captured BEFORE any spy is installed, so the "must not wait real time" test
// below exercises the shipped implementation rather than whatever the last
// `mockRestore` happened to leave behind.
const realSleep = _internals.sleep;

// Never wait real time here — and never rely on the module's own isTestEnv
// guard to make that true, since a regression in the guard would show up as a
// slow suite rather than a failure.
let slept: number[];
beforeEach(() => {
  slept = [];
  vi.spyOn(_internals, "sleep").mockImplementation(async (ms: number) => {
    slept.push(ms);
  });
});

describe("seedGapMs", () => {
  test("defaults when unset or empty", () => {
    expect(seedGapMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SEED_GAP_MS);
    expect(seedGapMs({ SLACK_REACTION_SEED_GAP_MS: "" } as NodeJS.ProcessEnv)).toBe(DEFAULT_SEED_GAP_MS);
  });

  test("honours an explicit value, including 0 to disable", () => {
    expect(seedGapMs({ SLACK_REACTION_SEED_GAP_MS: "250" } as NodeJS.ProcessEnv)).toBe(250);
    expect(seedGapMs({ SLACK_REACTION_SEED_GAP_MS: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });

  test("reads process.env when no env is passed", () => {
    expect(seedGapMs()).toBe(DEFAULT_SEED_GAP_MS);
  });

  test("a typo falls back to the default rather than silently disabling the gap", () => {
    for (const bad of ["abc", "-1", "NaN"]) {
      expect(seedGapMs({ SLACK_REACTION_SEED_GAP_MS: bad } as NodeJS.ProcessEnv)).toBe(DEFAULT_SEED_GAP_MS);
    }
  });

  test("the gap is over a second, so two seeds cannot share one", () => {
    expect(DEFAULT_SEED_GAP_MS).toBeGreaterThan(1000);
  });
});

describe("seedReactionsInOrder", () => {
  test("adds in the given order, one at a time", async () => {
    const added: string[] = [];
    await seedReactionsInOrder(["question", "one", "two"], async (n) => { added.push(n); }, () => {}, 900);
    expect(added).toEqual(["question", "one", "two"]);
  });

  test("pauses between adds but not after the last one", async () => {
    await seedReactionsInOrder(["question", "one", "two"], async () => {}, () => {}, 900);
    expect(slept).toEqual([900, 900]);
  });

  test("a single seed never pauses", async () => {
    await seedReactionsInOrder(["question"], async () => {}, () => {}, 900);
    expect(slept).toEqual([]);
  });

  test("gap 0 disables the pause entirely", async () => {
    const added: string[] = [];
    await seedReactionsInOrder(["question", "one"], async (n) => { added.push(n); }, () => {}, 0);
    expect(added).toEqual(["question", "one"]);
    expect(slept).toEqual([]);
  });

  test("a failing add is reported and the rest still go on", async () => {
    const added: string[] = [];
    const failed: string[] = [];
    await seedReactionsInOrder(
      ["question", "one", "two"],
      async (n) => {
        if (n === "one") throw new Error("invalid_name");
        added.push(n);
      },
      (n) => failed.push(n),
      900,
    );
    expect(added).toEqual(["question", "two"]);
    expect(failed).toEqual(["one"]);
  });

  test("no pause is spent after an add that failed — there is nothing to order", async () => {
    await seedReactionsInOrder(
      ["question", "one", "two"],
      async (n) => { if (n === "one") throw new Error("nope"); },
      () => {},
      900,
    );
    // question -> pause, one fails -> no pause, two is last -> no pause.
    expect(slept).toEqual([900]);
  });

  test("defaults to the configured gap when none is passed", async () => {
    await seedReactionsInOrder(["question", "one"], async () => {}, () => {});
    expect(slept).toEqual([DEFAULT_SEED_GAP_MS]);
  });

  test("an empty list does nothing at all", async () => {
    const added: string[] = [];
    await seedReactionsInOrder([], async (n) => { added.push(n); }, () => {}, 900);
    expect(added).toEqual([]);
    expect(slept).toEqual([]);
  });
});

describe("the seed gap cannot wait real time under a test runner", () => {
  test("a multi-second sleep returns immediately", async () => {
    const t0 = Date.now();
    await realSleep(3000);
    expect(Date.now() - t0).toBeLessThan(250);
  });

  // The other half of the guard. Asserting only that it returns immediately
  // would still pass if `sleep` were stubbed out to a no-op for everyone —
  // and then the gap this module exists for would never be spent in real use.
  //
  // Driven through the injected `isTestEnv`, NOT by deleting the variables from
  // `process.env`: `bun test --parallel=2` shares that environment with every
  // CLI subprocess other test files spawn, so the deletion made THEM wait the
  // real gap and took the suite from 45s to 169s.
  test("outside a test runner it really does wait", async () => {
    vi.spyOn(_internals, "isTestEnv").mockReturnValue(false);
    const t0 = Date.now();
    await realSleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  test("the guard reads the environment it is given", () => {
    expect(isTestEnv({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isTestEnv({ VITEST: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTestEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTestEnv({ BUN_TEST: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTestEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    // The live process is running one right now, so the default must say so.
    expect(isTestEnv()).toBe(true);
  });
});
