// `slack stream` — every new message the identity can see that matches --grep,
// one line per match, across all of its channels (top-level posts AND thread
// replies), resumable from a persisted per-channel cursor.
//
// Transport: polling. Slack's real-time paths need either a desktop session
// (RTM, user identity only) or Socket Mode (an app-level xapp- token). The bot
// identity — the privacy-safe default — has neither, so this polls
// conversations.history over a sliding "thread window": one history scan per
// channel yields both new top-level messages (ts past the cursor) and every
// thread whose `latest_reply` moved past that thread's cursor, and only those
// threads cost a conversations.replies call.
//
// Delivery is at-least-once: the cursor is saved right after each match is
// written, so a crash between the write and the save can repeat that one line.
// Consumers dedupe on channel.id + ts.
//
// Relay (optional, worker/): a Cloudflare Worker turns Slack's Events API into
// a stream of doorbells — {channel, ts, thread_ts}, no text. On a bell the
// stream reads that one message through the Web API and runs it through the
// same filter, so a mention is emitted within a second or two. Polling keeps
// running underneath at a long interval as the safety net (a bell the relay
// never got, a reconnect), and returns to --interval while the relay is down.
// Both paths emit through one `seen` set, so a message is never printed twice.
//
// Not covered (documented in README): edits (a message edited INTO matching is
// not re-emitted), and replies to a thread whose parent is older than the
// thread window.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Doorbell, Subscribe } from "./relay.ts";
import { RelayAuthError } from "./relay.ts";
import { history, RateLimitError, repliesPage, userConversations, userName, type Json } from "./slack.ts";

export type ChannelRef = { id: string; name: string; isIm: boolean; isMpim?: boolean; user?: string };

export type Page = { messages: Record<string, Json>[]; nextCursor?: string };

/** The Slack surface the stream needs — injected so tests run without HTTP. */
export type StreamClient = {
  listChannels(): Promise<ChannelRef[]>;
  history(channel: string, oldest: string, cursor?: string): Promise<Page>;
  replies(channel: string, threadTs: string, oldest: string, cursor?: string): Promise<Page>;
  userName(id: string): Promise<string>;
};

function page(resp: Json): Page {
  const r = resp as { messages?: Json; has_more?: Json; response_metadata?: { next_cursor?: Json } };
  const messages = (Array.isArray(r.messages) ? r.messages : [])
    .filter((m): m is Record<string, Json> => !!m && typeof m === "object" && !Array.isArray(m));
  const next = r.has_more === true ? r.response_metadata?.next_cursor : undefined;
  return typeof next === "string" && next ? { messages, nextCursor: next } : { messages };
}

/** The real client: Slack Web API calls as the given identity. */
export function webClient(token: string, cookie?: string): StreamClient {
  return {
    async listChannels() {
      const raw = await userConversations(token, "public_channel,private_channel,im,mpim", cookie);
      return raw.flatMap((c): ChannelRef[] => {
        if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.id !== "string") return [];
        const isIm = c.is_im === true;
        return [{
          id: c.id, name: str(c.name) || c.id, isIm,
          ...(c.is_mpim === true ? { isMpim: true } : {}),
          ...(isIm && typeof c.user === "string" ? { user: c.user } : {}),
        }];
      });
    },
    history: async (channel, oldest, cursor) => page(await history(token, channel, 200, oldest, cursor, cookie)),
    replies: async (channel, threadTs, oldest, cursor) =>
      page(await repliesPage(token, channel, threadTs, { oldest, ...(cursor ? { cursor } : {}) }, cookie)),
    userName: (id) => userName(token, id, cookie),
  };
}

export type ChanState = {
  /** When this channel started being watched: a thread first seen gets this as its cursor. */
  since: string;
  /** Every top-level message with ts ≤ cursor has been matched (or skipped). */
  cursor: string;
  /** Per thread (parent ts): every reply with ts ≤ value has been matched. */
  threads: Record<string, string>;
};

export type StreamState = {
  version: 1; identity: string; channels: Record<string, ChanState>;
  /** Matches already emitted, "channel:ts" → ts — what keeps the relay path and
   *  the polling path from printing the same message twice. */
  seen?: Record<string, number>;
  /** Last relay bell fully handled; a restart resumes the relay from here. */
  relay?: { url: string; seq: number };
};

export type StreamMatch = {
  type: "message" | "reply";
  channel: { id: string; name: string };
  ts: string;
  thread_ts: string | null;
  user: { id: string; name: string };
  text: string;
  permalink: string;
};

export type StreamOpts = {
  grep: RegExp;
  /** Restrict to these channel ids; otherwise every conversation the identity is in. */
  channels?: string[];
  /** Sender ids whose posts are never emitted: the identity itself (user id / bot id). */
  selfUsers: Set<string>;
  selfBots: Set<string>;
  json: boolean;
  once: boolean;
  /** Seconds back to (re)start every channel from, overriding the saved cursor. */
  sinceSec?: number;
  intervalMs: number;
  threadWindowSec: number;
  statePath: string;
  /** Workspace URL ("https://acme.slack.com/") for permalinks. */
  teamUrl: string;
  /** auth.test user id — a state file written by another identity is refused. */
  identity: string;
  /** Messages younger than this are left for the next cycle, so a message Slack
   *  has not made visible yet cannot be skipped by a cursor that jumped past it. */
  settleSec?: number;
  /** Consecutive failed cycles before giving up (exit 3). */
  maxFailures?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Re-list the identity's channels every N cycles (new invites / DMs). */
  refreshEvery?: number;
  signal?: AbortSignal;
  /** Doorbell relay. While connected, the full poll only runs every
   *  max(intervalMs, reconcileMs) as a safety net. Ignored with --once. */
  relay?: { url: string; subscribe: Subscribe; reconcileMs: number };
};

export const PHI = 1.618;
/** Relay bells handled per turn of the loop before the poll gets a look in. */
const MAX_DRAIN = 25;
/** Bells queued beyond this are dropped in favour of a catch-up poll. */
const MAX_QUEUED_BELLS = 2000;
/** Reads of a bell's message before giving up on it (~4 min with φ backoff). */
const BELL_TRIES = 8;

export const _internals = {
  now: (): number => Date.now(),
  sleep: (ms: number, signal?: AbortSignal): Promise<void> => new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  }),
  out: (line: string): void => { process.stdout.write(line + "\n"); },
  err: (line: string): void => { process.stderr.write(line + "\n"); },
  pidAlive: (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
  },
};

/** φ backoff: min(cap, base·φ^(attempt-1)). With the defaults (2 s, cap 300 s,
 *  12 attempts) the worst-case total wait before giving up is ~16 min. */
export function phiDelay(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, Math.round(baseMs * Math.pow(PHI, Math.max(0, attempt - 1))));
}

/** Errors that no retry can fix — the whole stream stops (exit 3). */
const FATAL = ["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "no_permission"];
/** Errors confined to one channel — that channel is skipped, loudly, the rest go on. */
const CHANNEL = ["channel_not_found", "not_in_channel", "missing_scope", "is_archived"];

export class StreamFatal extends Error {}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function classify(e: unknown): "fatal" | "channel" | "transient" {
  const m = errText(e);
  if (FATAL.some((c) => m.includes(c))) return "fatal";
  if (CHANNEL.some((c) => m.includes(c))) return "channel";
  return "transient";
}

const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");
const num = (ts: string): number => Number(ts) || 0;
const fmt = (sec: number): string => sec.toFixed(6);

// Housekeeping subtypes: never a person talking.
const SKIP_SUBTYPES = new Set([
  "message_changed", "message_deleted", "channel_join", "channel_leave", "group_join", "group_leave",
]);

/** The text --grep runs against: the message body plus legacy attachment text
 *  (bots and integrations often put everything there). */
export function matchText(m: Record<string, Json>): string {
  const parts = [str(m.text)];
  if (Array.isArray(m.attachments)) {
    for (const a of m.attachments) {
      if (a && typeof a === "object" && !Array.isArray(a)) {
        parts.push(str(a.pretext), str(a.text), str(a.fallback));
      }
    }
  }
  return parts.filter(Boolean).join("\n");
}

export function permalink(teamUrl: string, channel: string, ts: string, threadTs?: string): string {
  const base = teamUrl.endsWith("/") ? teamUrl : teamUrl + "/";
  const p = `${base}archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${p}?thread_ts=${threadTs}&cid=${channel}` : p;
}

export function loadState(path: string, identity: string): StreamState {
  if (!existsSync(path)) return { version: 1, identity, channels: {} };
  let parsed: StreamState;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as StreamState;
  } catch (e) {
    // A corrupt cursor must not silently restart from "now" (that would drop
    // whatever arrived while we were down) — refuse and let a human decide.
    throw new StreamFatal(`state file ${path} is unreadable (${errText(e)}); move it aside to start fresh`);
  }
  const shapeOk = parsed && typeof parsed === "object" && parsed.version === 1 &&
    parsed.channels && typeof parsed.channels === "object" &&
    Object.values(parsed.channels).every((c) =>
      c && typeof c.since === "string" && typeof c.cursor === "string" && c.threads && typeof c.threads === "object");
  if (!shapeOk) throw new StreamFatal(`state file ${path} is not a slack stream state; move it aside to start fresh`);
  if (parsed.identity !== identity) {
    throw new StreamFatal(`state file ${path} belongs to identity ${parsed.identity}, not ${identity}; pass a different --state`);
  }
  return parsed;
}

export function saveState(path: string, st: StreamState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, path);
}

/** One stream per state file: a second one would emit every match twice. */
export function acquireLock(path: string): () => void {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  // Remove the lock only while it is still ours: if it was taken over (removed
  // by hand, reclaimed as stale), the new owner's lock must survive us.
  const release = (): void => {
    try { if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock); } catch { /* already gone */ }
  };
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (pid && _internals.pidAlive(pid)) {
      throw new StreamFatal(`another slack stream (pid ${pid}) already uses ${path}`);
    }
    unlinkSync(lock); // stale: its owner is gone
    writeFileSync(lock, String(process.pid), { flag: "wx" }); // throws if another stream won the race
  }
  return release;
}

type Ctx = {
  opts: StreamOpts;
  client: StreamClient;
  state: StreamState;
  names: Map<string, string>;
  matches: number;
};

async function nameOf(ctx: Ctx, id: string): Promise<string> {
  let n = ctx.names.get(id);
  if (n === undefined) {
    n = await ctx.client.userName(id);
    ctx.names.set(id, n);
  }
  return n;
}

/** Match one message and, only if it matches, resolve names and emit it.
 *  Nothing about a non-matching message is printed or logged. */
async function consider(ctx: Ctx, ch: ChannelRef, m: Record<string, Json>, isReply: boolean): Promise<boolean> {
  if (SKIP_SUBTYPES.has(str(m.subtype))) return false;
  const uid = str(m.user);
  const bid = str(m.bot_id);
  if ((uid && ctx.opts.selfUsers.has(uid)) || (bid && ctx.opts.selfBots.has(bid))) return false;
  ctx.opts.grep.lastIndex = 0; // a /g or /y regex keeps state between test() calls
  if (!ctx.opts.grep.test(matchText(m))) return false;

  const ts = str(m.ts);
  // A message can arrive twice — from a relay bell and from the poll — and
  // must be printed once.
  const seen = (ctx.state.seen ??= {});
  const key = `${ch.id}:${ts}`;
  if (seen[key] !== undefined) return false;
  seen[key] = num(ts);
  const threadTs = str(m.thread_ts) || null;
  const senderId = uid || bid;
  const senderName = uid
    ? await nameOf(ctx, uid)
    : str(m.username) || str((m.bot_profile as Record<string, Json> | undefined)?.name) || bid;
  const chName = ch.isIm ? `@${ch.user ? await nameOf(ctx, ch.user) : ch.id}` : ch.isMpim ? ch.name : `#${ch.name}`;
  const rec: StreamMatch = {
    type: isReply ? "reply" : "message",
    channel: { id: ch.id, name: chName },
    ts,
    thread_ts: threadTs,
    user: { id: senderId, name: senderName },
    // Slack escapes only these three; the regex ran on the raw text above.
    text: str(m.text).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
    permalink: permalink(ctx.opts.teamUrl, ch.id, ts, threadTs ?? undefined),
  };
  ctx.opts.json ? _internals.out(JSON.stringify(rec)) : _internals.out(humanLine(rec));
  ctx.matches++;
  return true;
}

export function humanLine(r: StreamMatch): string {
  const when = new Date(num(r.ts) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const mark = r.type === "reply" ? "↳ " : "";
  const body = r.text.split("\n").join("\n    ");
  return `${when}  ${r.channel.name}  ${mark}@${r.user.name}: ${body}\n    ${r.permalink}`;
}

async function allPages(fetch: (cursor?: string) => Promise<Page>): Promise<Record<string, Json>[]> {
  const out: Record<string, Json>[] = [];
  let cursor: string | undefined;
  do {
    const p = await fetch(cursor);
    out.push(...p.messages);
    cursor = p.nextCursor;
  } while (cursor);
  return out;
}

/** Scan one channel up to `horizon` (now − settle) and advance its cursors. */
export async function scanChannel(ctx: Ctx, ch: ChannelRef, nowSec: number): Promise<void> {
  const st = ctx.state.channels[ch.id]!;
  const horizon = nowSec - (ctx.opts.settleSec ?? 5);
  const windowStart = nowSec - ctx.opts.threadWindowSec;
  const cursor = num(st.cursor);
  const oldest = Math.min(cursor, windowStart);

  const msgs = (await allPages((c) => ctx.client.history(ch.id, fmt(oldest), c)))
    .sort((a, b) => num(str(a.ts)) - num(str(b.ts)));

  for (const m of msgs) {
    const t = num(str(m.ts));
    if (t <= cursor || t > horizon) continue;
    // A thread_broadcast is a reply also shown in the channel; it is emitted
    // here (once) and skipped when its thread's replies are read.
    const tts = str(m.thread_ts);
    const hit = await consider(ctx, ch, m, tts !== "" && tts !== str(m.ts));
    st.cursor = str(m.ts);
    // Persist right after a match is written, so a restart cannot repeat it.
    if (hit) saveState(ctx.opts.statePath, ctx.state);
  }
  if (num(st.cursor) < horizon) st.cursor = fmt(horizon);

  // Threads: any parent in the window whose latest reply is past its cursor.
  for (const p of msgs) {
    const pts = str(p.ts);
    const latest = num(str(p.latest_reply));
    if (!latest || str(p.thread_ts) !== pts) continue;
    const tc = num(st.threads[pts] ?? st.since);
    if (latest <= tc) continue;
    const reps = (await allPages((c) => ctx.client.replies(ch.id, pts, fmt(tc), c)))
      .sort((a, b) => num(str(a.ts)) - num(str(b.ts)));
    for (const r of reps) {
      const t = num(str(r.ts));
      if (str(r.ts) === pts || t <= tc || t > horizon) continue;
      const hit = str(r.subtype) !== "thread_broadcast" && await consider(ctx, ch, r, true);
      st.threads[pts] = str(r.ts);
      if (hit) saveState(ctx.opts.statePath, ctx.state);
    }
    st.threads[pts] = fmt(Math.max(num(st.threads[pts] ?? "0"), Math.min(latest, horizon)));
  }
  // Forget threads that slid out of the window.
  for (const k of Object.keys(st.threads)) if (num(k) < windowStart) delete st.threads[k];
  saveState(ctx.opts.statePath, ctx.state);
}

/** Read the one message a bell names and run it through the filter. Cursors
 *  are not touched: the poll still owns them and will pass over this message
 *  (already in `seen`) on its next scan. Returns false when the message is not
 *  visible (yet). */
export async function ringBell(ctx: Ctx, ch: ChannelRef, bell: Doorbell): Promise<boolean> {
  const oldest = fmt(num(bell.ts) - 1);
  const msgs = bell.thread_ts
    ? await allPages((c) => ctx.client.replies(ch.id, bell.thread_ts!, oldest, c))
    : (await ctx.client.history(ch.id, oldest)).messages;
  const m = msgs.find((x) => str(x.ts) === bell.ts);
  if (!m) return false;
  const tts = str(m.thread_ts);
  if (await consider(ctx, ch, m, tts !== "" && tts !== bell.ts)) saveState(ctx.opts.statePath, ctx.state);
  return true;
}

/** Drop `seen` entries no scan can reach any more. */
function pruneSeen(st: StreamState, oldestSec: number): void {
  if (!st.seen) return;
  for (const [k, t] of Object.entries(st.seen)) if (t < oldestSec) delete st.seen[k];
}

/** Run the stream. Resolves with the process exit code:
 *  0 — matches were emitted (--once) / stopped by a signal (long-running);
 *  2 — --once found no match;
 *  3 — transport/config failure (stderr says what). */
export async function runStream(client: StreamClient, opts: StreamOpts): Promise<number> {
  const maxFailures = opts.maxFailures ?? (opts.once ? 3 : 12);
  const base = opts.backoffBaseMs ?? 2000;
  const cap = opts.backoffCapMs ?? 300_000;
  const refreshEvery = opts.refreshEvery ?? 10;
  const relay = opts.once ? undefined : opts.relay;

  let release: (() => void) | undefined;
  // Stops the relay subscription when the stream ends, for any reason.
  const inner = new AbortController();
  const stopInner = (): void => inner.abort();
  opts.signal?.addEventListener("abort", stopInner, { once: true });
  try {
    release = acquireLock(opts.statePath);
    const state = loadState(opts.statePath, opts.identity);
    const ctx: Ctx = { opts, client, state, names: new Map(), matches: 0 };
    const skipped = new Set<string>();
    let channels: ChannelRef[] = [];
    const runStartSec = _internals.now() / 1000;
    let lastRefreshSec = runStartSec;
    let lastSkip = "";
    let failures = 0;
    let cycle = 0;
    let lastFullMs = -Infinity;
    // Slack's Retry-After applies to every caller, not just the request that
    // got it: while it runs, neither bells nor the poll touch the API.
    let cooldownUntil = 0;
    const coolDown = (e: RateLimitError): void => {
      _internals.err(`slack stream: rate limited — waiting ${e.retryAfter}s`);
      cooldownUntil = Math.max(cooldownUntil, _internals.now() + e.retryAfter * 1000);
    };

    const refresh = async (nowSec: number): Promise<void> => {
      const listed = await client.listChannels();
      channels = listed.filter((c) => !opts.channels || opts.channels.includes(c.id));
      if (opts.channels) {
        for (const id of opts.channels) {
          if (!channels.some((c) => c.id === id)) {
            throw new StreamFatal(`--channel ${id}: the identity is not a member of it`);
          }
        }
      }
      const isFirst = Object.keys(state.channels).length === 0;
      for (const c of channels) {
        if (state.channels[c.id]) continue;
        // First run: start now. A channel that appears later (new invite /
        // DM) starts at the previous refresh, so the gap between joining
        // and noticing it is still scanned. --since reaches back further,
        // for late-discovered channels too.
        const natural = isFirst || cycle === 0 ? nowSec : lastRefreshSec;
        const start = Math.min(natural, opts.sinceSec !== undefined ? runStartSec - opts.sinceSec : Infinity);
        state.channels[c.id] = { since: fmt(start), cursor: fmt(start), threads: {} };
      }
      lastRefreshSec = nowSec;
      saveState(opts.statePath, state);
    };

    if (opts.sinceSec !== undefined) {
      // An explicit --since replays from that point: drop the saved cursors,
      // and the record of what was printed, so it is printed again.
      state.channels = {};
      delete state.seen;
    }

    // --- relay: a background subscription that only queues bells; the loop
    // below handles them, so Slack calls and state writes stay sequential.
    // `live` starts undefined so the first outcome, up or down, is announced.
    type Pending = { seq: number; bell: Doorbell; tries: number; dueMs: number };
    const bus = {
      queue: [] as Pending[], // in seq order, due now
      retry: [] as Pending[], // waiting for dueMs
      inflight: undefined as Pending | undefined, // being read right now
      onDrain: undefined as (() => void) | undefined, // a paused relay waiting for room
      handled: 0, // highest seq resolved (emitted, filtered out, or abandoned)
      live: undefined as boolean | undefined, full: false,
    };
    let wake = new AbortController();
    const ring = (): void => wake.abort();
    const setLive = (live: boolean, why = ""): void => {
      if (bus.live === live) return;
      bus.live = live;
      _internals.err(live
        ? `slack stream: relay connected — polling every ${Math.round(Math.max(opts.intervalMs, relay!.reconcileMs) / 1000)}s as a safety net`
        : `slack stream: relay unavailable${why ? ` (${why})` : ""} — polling every ${Math.round(opts.intervalMs / 1000)}s`);
      ring();
    };
    const relayLoop = async (r: NonNullable<typeof relay>): Promise<void> => {
      let after = state.relay?.url === r.url ? state.relay.seq : undefined;
      let attempt = 0;
      const pendingCount = (): number => bus.queue.length + bus.retry.length + (bus.inflight ? 1 : 0);
      while (!inner.signal.aborted) {
        // Flow control: after an overflow, let the backlog drain before
        // resubscribing; the relay replays what we did not take from storage.
        while (pendingCount() >= MAX_QUEUED_BELLS / 2 && !inner.signal.aborted) {
          await new Promise<void>((res) => {
            bus.onDrain = res;
            inner.signal.addEventListener("abort", () => res(), { once: true });
          });
        }
        if (inner.signal.aborted) return;
        const conn = new AbortController();
        const stopConn = (): void => conn.abort();
        inner.signal.addEventListener("abort", stopConn, { once: true });
        let paused = false;
        let why = "stream closed";
        try {
          await r.subscribe(after, conn.signal, {
            hello: (h) => {
              attempt = 0;
              // Bells after our resume point are gone: poll to catch up.
              if (h.gap && after !== undefined) bus.full = true;
              if (h.gap || state.relay?.url !== r.url) state.relay = { url: r.url, seq: h.seq };
              after = h.seq;
              setLive(true);
            },
            bell: (seq, bell) => {
              if (paused) return;
              if (pendingCount() >= MAX_QUEUED_BELLS) {
                // Bells arrive faster than they can be read. Rather than grow
                // without bound — or drop bells the poll may never find —
                // hang up and come back for this one and the rest later.
                _internals.err(`slack stream: relay backlog over ${MAX_QUEUED_BELLS} — pausing the relay until it drains`);
                paused = true;
                conn.abort();
                return;
              }
              after = seq;
              bus.queue.push({ seq, bell, tries: 0, dueMs: 0 });
              ring();
            },
          });
        } catch (e) {
          if (e instanceof RelayAuthError) {
            if (bus.live) setLive(false, errText(e));
            bus.live = false;
            _internals.err(`slack stream: relay disabled for this run: ${errText(e)} — check SLACK_RELAY_TOKEN`);
            return;
          }
          why = errText(e);
        } finally {
          inner.signal.removeEventListener("abort", stopConn);
        }
        if (inner.signal.aborted) return;
        if (paused) continue;
        setLive(false, why);
        attempt++;
        await _internals.sleep(phiDelay(attempt, 2000, 60_000), inner.signal);
      }
    };
    if (relay) void relayLoop(relay);

    /** true = resolved (emitted, or nothing to emit); false = not visible yet. */
    const handleBell = async (bell: Doorbell): Promise<boolean> => {
      if (opts.channels && !opts.channels.includes(bell.channel)) return true;
      let ch = channels.find((c) => c.id === bell.channel);
      if (!ch) {
        // A channel joined since the last refresh. Re-list at most once a
        // minute; until then the bell waits rather than being written off.
        if (_internals.now() / 1000 - lastRefreshSec < 60) return false;
        await refresh(_internals.now() / 1000);
        ch = channels.find((c) => c.id === bell.channel);
      }
      if (!ch || skipped.has(ch.id) || !state.channels[ch.id]) return true;
      return ringBell(ctx, ch, bell);
    };
    /** Resume point: every bell up to it is resolved. A bell still being
     *  retried holds it back, so a restart gets that bell again. */
    const ack = (): void => {
      if (!state.relay || state.relay.url !== relay?.url) return;
      const pending = [...bus.queue, ...bus.retry, ...(bus.inflight ? [bus.inflight] : [])].map((p) => p.seq);
      state.relay.seq = pending.length ? Math.min(...pending) - 1 : Math.max(state.relay.seq, bus.handled);
    };
    /** Handle due bells — at most MAX_DRAIN per call, so a flood cannot starve
     *  the poll. A bell whose message is not readable yet is retried with φ
     *  backoff, then abandoned loudly (the poll still covers its window). */
    const drainBells = async (): Promise<void> => {
      const nowMs = _internals.now();
      const due = bus.retry.filter((p) => p.dueMs <= nowMs);
      if (due.length) {
        bus.retry = bus.retry.filter((p) => p.dueMs > nowMs);
        bus.queue = [...due, ...bus.queue].sort((a, b) => a.seq - b.seq);
      }
      let n = 0;
      while (bus.queue.length && n < MAX_DRAIN && !opts.signal?.aborted && _internals.now() >= cooldownUntil) {
        // Off the queue before the await: the subscription may replace the
        // queue meanwhile (backlog overflow), and must not lose this bell.
        const p = bus.queue.shift()!;
        bus.inflight = p;
        n++;
        let done: boolean;
        let why = "not visible yet";
        try {
          done = await handleBell(p.bell);
        } catch (e) {
          if (e instanceof RateLimitError) {
            // Back to the scheduler, so the poll is not starved by the wait.
            coolDown(e);
            p.dueMs = cooldownUntil;
            bus.retry.push(p);
            bus.inflight = undefined;
            break;
          }
          done = false;
          why = errText(e);
        }
        bus.inflight = undefined;
        if (done) {
          bus.handled = Math.max(bus.handled, p.seq);
        } else if (++p.tries >= BELL_TRIES) {
          // Name the place, never the message.
          _internals.err(`slack stream: relay bell for ${p.bell.channel} abandoned after ${p.tries} tries (${why}) — only the poll can find it now`);
          bus.handled = Math.max(bus.handled, p.seq);
        } else {
          p.dueMs = _internals.now() + phiDelay(p.tries, 1500, 60_000);
          bus.retry.push(p);
        }
      }
      if (bus.onDrain && bus.queue.length + bus.retry.length < MAX_QUEUED_BELLS / 2) {
        bus.onDrain();
        bus.onDrain = undefined;
      }
      const before = state.relay?.seq;
      ack();
      if (n || state.relay?.seq !== before) saveState(opts.statePath, state);
    };
    const interval = (): number => (bus.live === true && relay ? Math.max(opts.intervalMs, relay.reconcileMs) : opts.intervalMs);

    while (!opts.signal?.aborted) {
      if ((_internals.now() >= lastFullMs + interval() || bus.full) && _internals.now() >= cooldownUntil) {
        bus.full = false;
        const nowSec = _internals.now() / 1000;
        try {
          if (cycle % refreshEvery === 0) await refresh(nowSec);

          for (const ch of channels) {
            if (opts.signal?.aborted) break;
            if (skipped.has(ch.id)) continue;
            for (;;) {
              try {
                await scanChannel(ctx, ch, nowSec);
                break;
              } catch (e) {
                if (e instanceof RateLimitError) {
                  coolDown(e);
                  await _internals.sleep(cooldownUntil - _internals.now(), opts.signal);
                  if (opts.signal?.aborted) break;
                  continue;
                }
                if (classify(e) === "channel") {
                  skipped.add(ch.id);
                  lastSkip = errText(e);
                  _internals.err(`slack stream: skipping ${ch.isIm ? ch.id : "#" + ch.name} (${ch.id}): ${errText(e)}`);
                  break;
                }
                throw e;
              }
            }
          }
          if (channels.length > 0 && channels.every((c) => skipped.has(c.id))) {
            throw new StreamFatal(`every channel failed — nothing left to watch (last: ${lastSkip})`);
          }
          if (failures > 0) _internals.err(`slack stream: recovered after ${failures} failed attempt(s)`);
          failures = 0;
        } catch (e) {
          if (e instanceof StreamFatal || classify(e) === "fatal") {
            _internals.err(`slack stream: fatal: ${errText(e)}`);
            return 3;
          }
          failures++;
          if (failures >= maxFailures) {
            _internals.err(`slack stream: giving up after ${failures} consecutive failures: ${errText(e)}`);
            return 3;
          }
          const delay = phiDelay(failures, base, cap);
          _internals.err(`slack stream: ${errText(e)} — reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${failures}/${maxFailures})`);
          await _internals.sleep(delay, opts.signal);
          bus.full = true;
          continue; // retry the same cycle
        }

        cycle++;
        if (opts.once) {
          if (ctx.matches === 0) _internals.err(`slack stream: no matches in ${channels.length - skipped.size} channel(s)`);
          return ctx.matches > 0 ? 0 : 2;
        }
        lastFullMs = nowSec * 1000;
        pruneSeen(state, nowSec - opts.threadWindowSec - 86400);
      }

      // Sleep until the next full poll or bell retry, or until a bell (or a
      // relay up/down) wakes us.
      if (opts.signal?.aborted) break;
      const nowMs = _internals.now();
      const until = Math.max(
        cooldownUntil,
        bus.queue.length || bus.full ? nowMs : Math.min(lastFullMs + interval(), ...bus.retry.map((p) => p.dueMs)),
      );
      if (until > nowMs) {
        wake = new AbortController();
        const w = wake;
        const stop = (): void => w.abort();
        opts.signal?.addEventListener("abort", stop, { once: true });
        await _internals.sleep(until - nowMs, w.signal);
        opts.signal?.removeEventListener("abort", stop);
      }
      await drainBells();
    }
    return 0;
  } catch (e) {
    _internals.err(`slack stream: fatal: ${errText(e)}`);
    return 3;
  } finally {
    inner.abort();
    opts.signal?.removeEventListener("abort", stopInner);
    release?.();
  }
}
