// Reaction-backed task tracking.
//
// A task is a message carrying the marker reaction (:pushpin: by default). Its
// progress lives in a second reaction, and optional "reason" flags stack on top:
//
//   progress (priority order, highest first)
//     1 done            :white_check_mark:
//     2 dropped         :no_entry_sign:
//     3 doing           :eyes:
//     4 pending         :hourglass_flowing_sand:
//     5 undefined       (marker only, no progress reaction)
//
//   reason flags (any number, independent of progress)
//     alert             :exclamation:
//     needs-discussion  :thinking_face:
//     waiting           :speech_balloon:   ball is with the other party IN this thread
//     blocked           :lock:             stuck OUTSIDE this conversation
//
// needs-discussion moved off :question: (2026-08-24) so `ask` can claim it as
// its marker. `has:` matches one emoji exactly, so sharing it would have made
// every `ask` question show up in `todo ls --state stuck` and vice versa.
// The cost is real and accepted: :question: reactions already sitting on old
// messages no longer register as needs-discussion — reactions cannot be
// migrated retroactively. Anyone relying on the old emoji can put it back via
// ~/.config/slack-cli/todo.json, which overrides every name here.
//
// waiting vs blocked: "whose ball is it" has only three answers, and `pending`
// already means "mine". So the remaining two are a flag each — waiting = I've
// replied and am waiting on someone in this conversation; blocked = something
// outside it (another task, a third party, an external dependency).
//
// Why the reference itself ("blocked on WHICH task / WHOM") is not stored here:
// reactions are a set of enum values, they cannot carry a pointer. The obvious
// alternative — posting a machine-readable token in a thread reply, e.g.
// `todo:v1 blocked-on=@alice` — does NOT work: Slack's full-text index splits on
// punctuation, so a quoted search for "blocked-on" returns 0 hits (measured),
// and "1.91" matches 1.91.0. Any future attempt needs a single alphanumeric
// marker word (e.g. `tdblock`) plus a bare @mention, not a symbol-laden token.
//
// The invariant is NOT "exactly one progress reaction" but "at least one, and
// readers collapse by priority". That is what makes `todo set` safe to interrupt
// — see the ordering comment on todoSet().
//
// Everything here is built on search's has:/hasmy: modifiers because
// search.messages does not return a reactions field at all: filtering results
// client-side is impossible, so the filter must live in the query.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  RateLimitError,
  authTest,
  history,
  reactionAdd,
  reactionRemove,
  reactionsGet,
} from "./slack.ts";
import { cacheGet, cacheSet } from "./cache.ts";

// ── config ────────────────────────────────────────────────────────────────

export type ProgressState = "done" | "dropped" | "doing" | "pending";
export type FlagName = "alert" | "needs-discussion" | "waiting" | "blocked";
export type LsState = ProgressState | "untriaged" | "stuck" | "open";

export type TodoConfig = {
  marker: string;
  /** Highest priority first — readers collapse a multi-reaction message to progress[0]. */
  progress: Record<ProgressState, string>;
  flags: Record<FlagName, string>;
};

export const DEFAULT_TODO_CONFIG: TodoConfig = {
  marker: "pushpin",
  progress: {
    done: "white_check_mark",
    dropped: "no_entry_sign",
    doing: "eyes",
    // ⏳ hourglass_flowing_sand, NOT ⌛ hourglass: measured against a live
    // workspace, real usage is 21× :hourglass_flowing_sand: and 0× :hourglass:.
    pending: "hourglass_flowing_sand",
  },
  flags: {
    alert: "exclamation",
    "needs-discussion": "thinking_face",
    waiting: "speech_balloon",
    blocked: "lock",
  },
};

/** Progress states from highest to lowest priority. */
export const PROGRESS_ORDER: ProgressState[] = ["done", "dropped", "doing", "pending"];

export const FLAG_NAMES: FlagName[] = ["alert", "needs-discussion", "waiting", "blocked"];

function todoConfigPath(): string {
  // Same directory resolution as profiles.json / cache.json.
  return join(process.env.HOME || homedir(), ".config", "slack-cli", "todo.json");
}

function stripColons(s: string): string {
  return s.replace(/^:+|:+$/g, "");
}

/** Load ~/.config/slack-cli/todo.json over the defaults. Fail-soft: a missing or
 *  malformed file just means "use the defaults" — a broken override must not
 *  make every todo command unusable. */
export function loadTodoConfig(path = todoConfigPath()): TodoConfig {
  const cfg: TodoConfig = {
    marker: DEFAULT_TODO_CONFIG.marker,
    progress: { ...DEFAULT_TODO_CONFIG.progress },
    flags: { ...DEFAULT_TODO_CONFIG.flags },
  };
  try {
    if (!existsSync(path)) return cfg;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TodoConfig>;
    if (typeof raw.marker === "string" && raw.marker.trim()) cfg.marker = stripColons(raw.marker.trim());
    for (const s of PROGRESS_ORDER) {
      const v = raw.progress?.[s];
      if (typeof v === "string" && v.trim()) cfg.progress[s] = stripColons(v.trim());
    }
    for (const f of FLAG_NAMES) {
      const v = raw.flags?.[f];
      if (typeof v === "string" && v.trim()) cfg.flags[f] = stripColons(v.trim());
    }
  } catch {
    // Unreadable/invalid config — defaults.
  }
  return cfg;
}

// ── query building ────────────────────────────────────────────────────────

/** `hasmy::eyes:` / `has::eyes:` — the modifier's argument is itself colon-wrapped. */
function hasTerm(emoji: string, shared: boolean, negate = false): string {
  return `${negate ? "-" : ""}${shared ? "has" : "hasmy"}::${stripColons(emoji)}:`;
}

export type LsQueryOpts = {
  /** true → has: (anyone's reactions). Default false → hasmy: (only mine). */
  shared?: boolean;
  /** #channel (or @user / raw name) to scope with in:. */
  in?: string;
  /** @user (or "me") to scope with from: — the sender is usually the person
   *  you're blocked on, so this covers most of "who is this waiting on?". */
  from?: string;
};

/** Build the ONE search query that answers a `todo ls --state <state>`.
 *
 *  Never split a state into several searches: search.messages is a Tier-2
 *  method (~20 req/min) and a per-state fan-out burns that budget instantly.
 *  Priority is expressed as negations of the higher-priority emoji, which is
 *  exactly the "collapse by priority" rule the state model defines. */
export function buildTodoQuery(state: LsState, cfg: TodoConfig, opts: LsQueryOpts = {}): string {
  const shared = opts.shared === true;
  const has = (e: string) => hasTerm(e, shared);
  const not = (e: string) => hasTerm(e, shared, true);
  const terms: string[] = [];

  if (state === "untriaged") {
    // Marked as a task but with no progress reaction at all.
    terms.push(has(cfg.marker), ...PROGRESS_ORDER.map((s) => not(cfg.progress[s])));
  } else if (state === "stuck") {
    // Not finished, and carrying at least one reason flag.
    terms.push(
      has(cfg.marker),
      not(cfg.progress.done),
      not(cfg.progress.dropped),
      `(${FLAG_NAMES.map((f) => has(cfg.flags[f])).join(" OR ")})`,
    );
  } else if (state === "open") {
    // Default view: everything marked as a task that isn't finished or dropped.
    terms.push(has(cfg.marker), not(cfg.progress.done), not(cfg.progress.dropped));
  } else {
    // A progress state: its own emoji, minus every higher-priority emoji.
    const idx = PROGRESS_ORDER.indexOf(state);
    terms.push(has(cfg.progress[state]));
    for (const higher of PROGRESS_ORDER.slice(0, idx)) terms.push(not(cfg.progress[higher]));
  }

  if (opts.in) {
    const ref = opts.in.startsWith("#") || opts.in.startsWith("@") ? opts.in : `#${opts.in}`;
    terms.push(`in:${ref}`);
  }
  if (opts.from) {
    // "me" is a Slack search keyword in its own right — never prefix it with @.
    const who = opts.from === "me" || opts.from.startsWith("@") ? opts.from : `@${opts.from}`;
    terms.push(`from:${who}`);
  }
  return terms.join(" ");
}

// ── rate-limit retry ──────────────────────────────────────────────────────

export const MAX_RATE_LIMIT_RETRIES = 3;

export const _internals = {
  // Swappable so tests never wait real time (same pattern as tail.ts).
  //
  // The spy is NOT the only defence, and must not be: a stub installed in a
  // `beforeEach` is undone by any `vi.restoreAllMocks()` in a nested block's
  // `afterEach`, and the next test then backs off for REAL seconds. That is
  // what wedged CI — `todo.test.ts` burned the whole job budget in the retry
  // path while every other file finished in under two seconds, and it never
  // reproduced locally because the timing differs.
  //
  // So the backoff itself refuses to sleep under a test runner. Detecting the
  // environment is ugly, but the alternative is a rule ("never let a nested
  // afterEach restore this") that has to be remembered by every future test —
  // and it already was not.
  sleep: (ms: number): Promise<void> =>
    isTestEnv() ? Promise.resolve() : new Promise((res) => setTimeout(res, ms)),
};

/** True under vitest or `bun test`. Both set NODE_ENV=test; vitest also sets
 *  VITEST. Checked at call time, not at import, so a test that deliberately
 *  wants the real timer can clear it. */
function isTestEnv(): boolean {
  return !!process.env.VITEST || process.env.NODE_ENV === "test" || !!process.env.BUN_TEST;
}

/** Run an API call, backing off and retrying on 429. Mirrors tail.ts: warn on
 *  stderr, sleep `retryAfter`, try again — but bounded, so a persistently
 *  throttled workspace fails loudly instead of hanging forever. */
export async function withRateLimitRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries = MAX_RATE_LIMIT_RETRIES,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      if (!(e instanceof RateLimitError)) throw e;
      if (attempt >= maxRetries) {
        throw new Error(
          `Slack rate limit hit on ${label} — gave up after ${maxRetries} retries. Try again in a minute.`,
        );
      }
      console.error(`Warning: Slack rate limit hit on ${label} — backing off for ${e.retryAfter}s`);
      await _internals.sleep(e.retryAfter * 1000);
    }
  }
}

// ── cached lookups ────────────────────────────────────────────────────────

const identityMemo = new Map<string, { userId: string; teamId: string }>();

/** auth.test, memoised for the process and keyed by token (never persisted: this
 *  is identity, not a lookup, and a stale self-ID would corrupt `todo set`).
 *  Yields both the user ID (to tell my reactions from other people's) and the
 *  team ID (the cache namespace). */
async function identity(token: string, cookie?: string): Promise<{ userId: string; teamId: string }> {
  const hit = identityMemo.get(token);
  if (hit) return hit;
  const info = await withRateLimitRetry("auth.test", () => authTest(token, cookie));
  const id = { userId: info.userId, teamId: info.teamId };
  identityMemo.set(token, id);
  return id;
}

/** The authenticated user's ID — needed to tell my reactions from other people's. */
export async function selfUserId(token: string, cookie?: string): Promise<string> {
  return (await identity(token, cookie)).userId;
}

/** Cache namespace for this token's workspace. Fail-soft: if auth.test can't be
 *  reached, return "" — cacheGet/cacheSet treat that as a miss, so the command
 *  runs uncached rather than risking another workspace's IDs. */
export async function cacheScope(token: string, cookie?: string): Promise<string> {
  try {
    return (await identity(token, cookie)).teamId;
  } catch {
    return "";
  }
}

export function resetSelfIdForTests(): void {
  identityMemo.clear();
}

/** resolveChannel() with the persistent cache in front of it (channel name → ID
 *  is stable for an hour). Raw IDs and permalinks never hit the cache. */
export async function resolveChannelCached(
  token: string,
  ref: string,
  resolve: (token: string, ref: string, cookie?: string) => Promise<string>,
  cookie?: string,
): Promise<string> {
  if (!ref.startsWith("#")) return resolve(token, ref, cookie);
  const scope = await cacheScope(token, cookie);
  const hit = cacheGet("channels", scope, ref);
  if (hit) return hit;
  const id = await withRateLimitRetry("resolveChannel", () => resolve(token, ref, cookie));
  cacheSet("channels", scope, ref, id);
  return id;
}

/** userID → handle with the persistent cache in front of it. Callers put their
 *  own in-process Map in front of THIS, making the lookup two-tier:
 *  Map → cache.json (1h TTL) → users.info. */
export async function userHandleCached(
  token: string,
  userId: string,
  lookup: (token: string, userId: string, cookie?: string) => Promise<string>,
  cookie?: string,
): Promise<string> {
  const scope = await cacheScope(token, cookie);
  const hit = cacheGet("users", scope, userId);
  if (hit) return hit;
  const handle = await withRateLimitRetry("users.info", () => lookup(token, userId, cookie));
  // Don't persist a failed resolution — userInfoPair/userName fall back to the
  // raw ID, and caching that would pin the ugly form for an hour.
  if (handle && handle !== userId) cacheSet("users", scope, userId, handle);
  return handle;
}

/** The recipient's IANA timezone, or null when Slack does not know it.
 *
 *  Cached on the same 1h TTL as handles, so a send costs no extra API call in
 *  practice. `users:read` failures are swallowed: a missing scope must degrade
 *  the quiet-hours label, never block sending.
 *
 *  NOTE the shape check. Slack Connect counterparts have NO `tz` KEY at all —
 *  not `tz: null`, the key is simply absent (measured 2026-08-26 on every
 *  external user in this workspace). So `=== null` would sail straight past it;
 *  only a truthy-string test is correct here. */
export async function userTzCached(
  token: string,
  userId: string,
  lookup: (token: string, userId: string, cookie?: string) => Promise<unknown>,
  cookie?: string,
): Promise<string | null> {
  const scope = await cacheScope(token, cookie);
  const hit = cacheGet("users", scope, `tz:${userId}`);
  if (hit) return hit === "?" ? null : hit;
  let tz: string | null = null;
  try {
    const resp = (await withRateLimitRetry("users.info", () => lookup(token, userId, cookie))) as
      { user?: { tz?: unknown; is_bot?: unknown } };
    // A bot reports America/Los_Angeles (Slack's own default) and has no phone
    // to buzz, so its "timezone" is a false signal — treat it as unknown rather
    // than warn about the middle of the night in California. Measured: 12 of
    // this workspace's 14 bots report exactly that, so it is Slack's default
    // rather than one app's misconfiguration.
    //
    // USLACKBOT needs naming separately because it reports `is_bot: false`
    // while carrying the same bogus zone — the one account where the flag and
    // the reality disagree. `format.ts` and the `user ls` filter already
    // special-case it for the same reason.
    if (resp?.user?.is_bot === true || userId === "USLACKBOT") {
      return cacheThen(scope, userId, null);
    }
    const raw = resp?.user?.tz;
    tz = typeof raw === "string" && raw ? raw : null;
  } catch {
    // No users:read, rate limit exhausted, network — all mean "unknown", and
    // unknown is a state the caller already handles. Never fail the send.
    return null;
  }
  return cacheThen(scope, userId, tz);
}

/** Persist and return. "?" records a definite "Slack has no timezone for this
 *  person", so we do not re-ask every send for the external users and bots that
 *  will never have a usable one. */
function cacheThen(scope: string, userId: string, tz: string | null): string | null {
  cacheSet("users", scope, `tz:${userId}`, tz ?? "?");
  return tz;
}

// ── set / flag ────────────────────────────────────────────────────────────

export type SetResult = {
  noop: boolean;
  added?: ProgressState;
  removed: string[];
  /** Progress emoji that could not be removed — the message is left multi-state. */
  leftover: string[];
};

/** Move a task to `state`.
 *
 *  ORDER IS THE WHOLE POINT: reactions.add runs FIRST, then the other progress
 *  reactions are removed one at a time.
 *
 *  Never invert this to remove-then-add. Removing first leaves a window with
 *  zero progress reactions; a crash, a 429 or a Ctrl-C inside that window drops
 *  the task out of every `todo ls` query permanently, with nothing left to point
 *  at it. Add-first's worst case is a message carrying two progress reactions —
 *  harmless, because readers collapse by priority, and trivially repaired later
 *  by `todo doctor --fix`.
 *
 *  Removes are awaited serially for the same reason: Promise.all would drop the
 *  ordering guarantee (and could land a remove before the add is acknowledged).
 *  Individual remove failures (no_reaction, already gone) are swallowed so one
 *  bad emoji cannot strand the rest. */
export async function todoSet(
  token: string,
  channel: string,
  ts: string,
  state: ProgressState,
  cfg: TodoConfig,
  cookie?: string,
): Promise<SetResult> {
  const target = cfg.progress[state];
  const selfId = await selfUserId(token, cookie);

  // Always a live read — reaction state is the thing we're about to change, so a
  // cached copy could make us skip a real transition.
  const reactions = await withRateLimitRetry("reactions.get", () => reactionsGet(token, channel, ts, cookie));
  const mine = new Set(
    reactions.filter((r) => r.users.includes(selfId)).map((r) => r.name),
  );
  const myProgress = PROGRESS_ORDER.map((s) => cfg.progress[s]).filter((e) => mine.has(e));

  if (myProgress.length === 1 && myProgress[0] === target) {
    return { noop: true, removed: [], leftover: [] };
  }

  // 1. ADD FIRST — after this line the task is findable under the new state.
  if (!mine.has(target)) {
    await withRateLimitRetry("reactions.add", () => reactionAdd(token, channel, ts, target, cookie));
  }

  // 2. Then retire the stale progress reactions, strictly one after another.
  const removed: string[] = [];
  const leftover: string[] = [];
  for (const emoji of myProgress) {
    if (emoji === target) continue;
    try {
      await withRateLimitRetry("reactions.remove", () => reactionRemove(token, channel, ts, emoji, cookie));
      removed.push(emoji);
    } catch {
      // no_reaction / raced removal / lost scope — keep going, report at the end.
      leftover.push(emoji);
    }
  }
  return { noop: false, added: state, removed, leftover };
}

/** Reason flags stack freely, so this is a plain add/remove with no ordering rule. */
export async function todoFlag(
  token: string,
  channel: string,
  ts: string,
  flag: FlagName,
  cfg: TodoConfig,
  remove: boolean,
  cookie?: string,
): Promise<string> {
  const emoji = cfg.flags[flag];
  if (remove) {
    await withRateLimitRetry("reactions.remove", () => reactionRemove(token, channel, ts, emoji, cookie));
  } else {
    await withRateLimitRetry("reactions.add", () => reactionAdd(token, channel, ts, emoji, cookie));
  }
  return emoji;
}

// ── doctor ────────────────────────────────────────────────────────────────

export const DOCTOR_DEFAULT_LIMIT = 1000;

export type DoctorFinding = {
  ts: string;
  text: string;
  /** Progress emoji found on the message, highest priority first. */
  emoji: string[];
  /** The one that survives the priority rule. */
  keep: string;
  fixed?: boolean;
  error?: string;
};

export type DoctorReport = {
  scanned: number;
  findings: DoctorFinding[];
  /** True when the scan stopped at `limit` with more history left — reported, never silent. */
  truncated: boolean;
};

/** Scan a channel's history for messages carrying more than one of MY progress
 *  reactions, and optionally repair them.
 *
 *  Paging is strictly sequential — parallel page fetches would multiply the
 *  request rate against a Tier-3 method for no latency win worth having, and
 *  cursors are inherently serial anyway. */
export async function todoDoctor(
  token: string,
  channel: string,
  cfg: TodoConfig,
  opts: { fix?: boolean; limit?: number; cookie?: string } = {},
): Promise<DoctorReport> {
  const limit = opts.limit ?? DOCTOR_DEFAULT_LIMIT;
  const cookie = opts.cookie;
  const selfId = await selfUserId(token, cookie);
  const progressEmoji = PROGRESS_ORDER.map((s) => cfg.progress[s]);

  const findings: DoctorFinding[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  let truncated = false;

  while (scanned < limit) {
    const page = Math.min(200, limit - scanned);
    const resp = (await withRateLimitRetry("conversations.history", () =>
      history(token, channel, page, undefined, cursor, cookie))) as {
      messages?: Array<{ ts?: string; text?: string; reactions?: Array<{ name?: string; users?: string[] }> }>;
      response_metadata?: { next_cursor?: string };
    };
    const messages = resp.messages ?? [];
    scanned += messages.length;

    for (const m of messages) {
      const ts = String(m.ts ?? "");
      if (!ts) continue;
      const mine = new Set(
        (m.reactions ?? []).filter((r) => (r.users ?? []).map(String).includes(selfId)).map((r) => String(r.name ?? "")),
      );
      const found = progressEmoji.filter((e) => mine.has(e));
      if (found.length < 2) continue;
      findings.push({ ts, text: String(m.text ?? "").split("\n")[0] ?? "", emoji: found, keep: found[0]! });
    }

    cursor = resp.response_metadata?.next_cursor || undefined;
    // An empty page with a cursor would otherwise spin forever without ever
    // reaching `limit` — Slack rarely does this, but the loop must terminate.
    if (!cursor || messages.length === 0) break;
    if (scanned >= limit) {
      truncated = true;
      break;
    }
  }

  if (opts.fix) {
    for (const f of findings) {
      // Same invariant as todoSet: the winner must be present BEFORE anything is
      // removed. The scan says it already is, but that snapshot can be stale by
      // now, so re-assert it — already_reacted just means it was true — and only
      // then remove the losers, serially.
      try {
        try {
          await withRateLimitRetry("reactions.add", () => reactionAdd(token, channel, f.ts, f.keep, cookie));
        } catch (e: unknown) {
          if (!(e instanceof Error) || !/already_reacted/.test(e.message)) throw e;
        }
        for (const emoji of f.emoji) {
          if (emoji === f.keep) continue;
          await withRateLimitRetry("reactions.remove", () => reactionRemove(token, channel, f.ts, emoji, cookie));
        }
        f.fixed = true;
      } catch (e: unknown) {
        f.fixed = false;
        f.error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  return { scanned, findings, truncated };
}
