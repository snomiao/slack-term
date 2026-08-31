// Seeding the answer pills on an `ask` / `poll` message, in order.
//
// MEASURED, 2026-08-31, two real questions posted five seconds apart by the
// SAME build:
//
//   07:42:31   two | one | question | three          ← shuffled
//   07:42:36   question | one | two | three | four   ← correct
//
// The adds have been sequential (`await` inside a `for`) since the first commit
// of `ask`, and there has never been a `Promise.all` here — so the reordering
// happens on Slack's side, not ours. The comments that used to sit at both call
// sites ("Slack keeps reactions in the order they were added, so sequential
// adds are what make the pills read 1,2,3") asserted a guarantee that does not
// exist, and the shuffled message above is the counter-example.
//
// The working theory is that the display order comes from a reaction timestamp
// stored at second resolution: adds landing inside one second are tie-broken
// arbitrarily, while adds that straddle a boundary keep their order. That fits
// both samples — the slower message came out right — and it is why the gap
// below is just over a second rather than a token 100ms.
//
// It is a THEORY. Confirming it needs `reactions.add` against a real workspace,
// which this repo's QA rule forbids (see CLAUDE.md: read-only only), and Slack
// exposes no timestamp on a reaction to measure it from. So the gap is tunable
// without a code change: set SLACK_REACTION_SEED_GAP_MS, and 0 restores the old
// back-to-back behaviour.

/** Just over one second, so two consecutive seeds cannot share a second. */
export const DEFAULT_SEED_GAP_MS = 1100;

/** True under vitest or `bun test`. Same check as ts/todo.ts, and for the same
 *  reason: a seam that only tests replace gets forgotten, and then the suite
 *  waits real seconds per seeded reaction.
 *
 *  It takes `env` so it can be tested by VALUE. Testing it by deleting
 *  NODE_ENV/VITEST from `process.env` and putting them back is what a first
 *  version did, and under `bun test --parallel=2` the deletion was visible to
 *  every CLI subprocess another test file spawned in that window: the suite
 *  went from 45s to 169s because those children then waited the real gap. */
export function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.VITEST || env.NODE_ENV === "test" || !!env.BUN_TEST;
}

export const _internals = {
  isTestEnv: (): boolean => isTestEnv(),
  sleep: (ms: number): Promise<void> =>
    _internals.isTestEnv() ? Promise.resolve() : new Promise((res) => setTimeout(res, ms)),
};

/** The configured gap. Invalid values fall back to the default rather than
 *  disabling the gap silently — a typo must not quietly restore the bug. */
export function seedGapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SLACK_REACTION_SEED_GAP_MS;
  if (raw === undefined || raw === "") return DEFAULT_SEED_GAP_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SEED_GAP_MS;
  return n;
}

/** Add `names` one at a time, in order, pausing between them.
 *
 *  A failed seed is reported and skipped, never fatal: the message is already
 *  posted, and a missing pill costs the answerer a trip to the emoji picker.
 *  The pause is skipped after the last add, and after one that failed — there
 *  is nothing left to keep in order. */
export async function seedReactionsInOrder(
  names: readonly string[],
  add: (name: string) => Promise<void>,
  onError: (name: string, e: unknown) => void,
  gapMs: number = seedGapMs(),
): Promise<void> {
  for (let i = 0; i < names.length; i++) {
    let ok = true;
    try {
      await add(names[i]!);
    } catch (e: unknown) {
      ok = false;
      onError(names[i]!, e);
    }
    if (ok && gapMs > 0 && i < names.length - 1) await _internals.sleep(gapMs);
  }
}
