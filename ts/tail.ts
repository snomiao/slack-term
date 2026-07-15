import { history, replies, resolveChannel, parseSlackPermalink, userInfoPair, authTest, conversationInfo, RateLimitError, type Json } from "./slack.ts";
import { resolveDateMarkup, resolveMentions } from "./format.ts";
import { tailRTMImpl } from "./rtm.ts";

export function parseSince(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!m) throw new Error(`Invalid --since format: "${s}" (expected e.g. 10m, 2h, 1d)`);
  const n = parseFloat(m[1]!);
  const unit = m[2]! as "s" | "m" | "h" | "d";
  switch (unit) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
  }
}

export const _internals = {
  sleep: (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms)),
  now: (): number => Date.now(),
  tailRTM: tailRTMImpl,
};

function asRecord(v: Json | undefined): Record<string, Json> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {};
}

function asArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}

// Numeric comparison of Slack ts strings ("1700000001.000000"). ts is a
// per-channel-unique, monotonically increasing message id, so this gives a
// total order for merging history (top-level) with replies (thread) streams.
function tsNum(ts: string): number {
  return Number(ts) || 0;
}

// A message is a thread reply (not a root/broadcast) when it carries a
// thread_ts that differs from its own ts.
function isThreadReply(m: Record<string, Json>): boolean {
  const ts = typeof m.ts === "string" ? m.ts : "";
  const tts = typeof m.thread_ts === "string" ? m.thread_ts : "";
  return tts !== "" && tts !== ts;
}

function slackTsToIso(tsRaw: string): string {
  const [secStr, fracStr = "000000"] = tsRaw.split(".");
  const d = new Date(Number(secStr) * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  const frac = fracStr.padEnd(6, "0").slice(0, 6);
  return `${y}-${mo}-${da}T${h}:${mi}:${s}.${frac}`;
}

async function formatTailLine(
  token: string,
  m: Record<string, Json>,
  cache: Map<string, string>,
  chLabel?: string,
): Promise<string> {
  const rawTs = typeof m.ts === "string" ? m.ts : "0.000000";
  const stamp = slackTsToIso(rawTs);
  let handle = "?";
  if (typeof m.user === "string") {
    const uid = m.user;
    const handleKey = "@" + uid;
    if (!cache.has(handleKey)) {
      const [, h] = await userInfoPair(token, uid);
      cache.set(handleKey, h);
    }
    handle = cache.get(handleKey) ?? uid;
  } else if (typeof m.username === "string") {
    handle = m.username;
  }
  const raw = typeof m.text === "string" ? m.text : "";
  const resolved = resolveDateMarkup(await resolveMentions(token, raw, cache));
  const lines = resolved.split("\n");
  const body = lines[0] + (lines.length > 1 ? "\n" + lines.slice(1).map((l) => `  ${l}`).join("\n") : "");
  // Annotate thread replies so a merged channel+thread stream stays readable.
  const mark = isThreadReply(m) ? "↳ " : "";
  const who = chLabel ? `${chLabel}  @${handle}` : `@${handle}`;
  return `${stamp}  ${mark}${who}:  ${body}`;
}

type PollOpts = {
  thread?: string;
  // Watch one thread AND the channel's top-level timeline in a single stream.
  // history() never returns non-broadcast thread replies, so we additionally
  // pull conversations.replies(watchThread) each cycle and merge.
  watchThread?: string;
  me?: boolean;
  myUserId?: string;
};

export async function pollCycle(
  token: string,
  channelId: string,
  cursor: string,
  opts: PollOpts,
  seen: Set<string>,
  cache: Map<string, string>,
  pageCursor?: string,
): Promise<{ newCursor: string; lines: string[]; hasMore: boolean; nextPageCursor: string | undefined; emittedOther: boolean }> {
  const histResp = asRecord((await history(
    token,
    channelId,
    20,
    pageCursor ? undefined : (cursor || undefined),
    pageCursor,
  )) as Json);
  // history returns newest-first; reverse to emit oldest-first
  const histMsgs = asArray(histResp.messages).map(asRecord).reverse();

  const meta = asRecord(histResp.response_metadata as Json | undefined);
  const nextPageCursor = (histResp.has_more === true && typeof meta.next_cursor === "string")
    ? meta.next_cursor
    : undefined;

  // --watch-thread: history omits non-broadcast thread replies, so pull the
  // watched thread separately and merge it into the channel timeline. Only on
  // the first (non-paginated) page so we fetch it once per cycle. The parent
  // (ts === watchThread) is also returned by replies() but already lives in
  // history — drop it to avoid double-emit.
  let replyMsgs: Record<string, Json>[] = [];
  if (opts.watchThread && !pageCursor) {
    const repResp = asRecord((await replies(token, channelId, opts.watchThread, 50)) as Json);
    replyMsgs = asArray(repResp.messages).map(asRecord)
      .filter((m) => (typeof m.ts === "string" ? m.ts : "") !== opts.watchThread);
  }

  // Merge and sort ascending by ts (a total order across both streams).
  type Entry = { m: Record<string, Json>; fromHistory: boolean };
  const entries: Entry[] = [
    ...histMsgs.map((m) => ({ m, fromHistory: true })),
    ...replyMsgs.map((m) => ({ m, fromHistory: false })),
  ].sort((a, b) => tsNum(typeof a.m.ts === "string" ? a.m.ts : "") - tsNum(typeof b.m.ts === "string" ? b.m.ts : ""));

  const lines: string[] = [];
  let newCursor = cursor;
  let emittedOther = false;

  for (const { m, fromHistory } of entries) {
    const ts = typeof m.ts === "string" ? m.ts : "";
    if (!ts || seen.has(ts)) continue;

    // Skip edit/delete events; only display original messages
    const subtype = typeof m.subtype === "string" ? m.subtype : "";
    if (subtype === "message_changed" || subtype === "message_deleted") continue;

    if (opts.thread) {
      const parentTs = typeof m.thread_ts === "string" ? m.thread_ts : ts;
      if (parentTs !== opts.thread && ts !== opts.thread) continue;
    }

    // --watch-thread shows all top-level posts plus the watched thread's
    // replies; drop replies belonging to *other* threads (e.g. a stray
    // reply_broadcast surfaced by history).
    if (opts.watchThread && isThreadReply(m)) {
      const tts = typeof m.thread_ts === "string" ? m.thread_ts : "";
      if (tts !== opts.watchThread) continue;
    }

    if (opts.me && opts.myUserId) {
      const text = typeof m.text === "string" ? m.text : "";
      if (!text.includes(`<@${opts.myUserId}>`)) continue;
    }

    seen.add(ts);
    if (seen.size > 1000) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }

    lines.push(await formatTailLine(token, m, cache));
    // Advance the history cursor only on top-level messages — thread replies
    // are never returned by history(), so their ts must not move `oldest`.
    if (fromHistory) newCursor = ts;
    // Track whether a message from someone *other than me* arrived, so
    // --exit-on-message can wait for an actual reply (not my own posts).
    const u = typeof m.user === "string" ? m.user : "";
    if (!opts.myUserId || u !== opts.myUserId) emittedOther = true;
  }

  return { newCursor, lines, hasMore: histResp.has_more === true, nextPageCursor, emittedOther };
}

export type TailOpts = {
  since?: string;
  thread?: string;
  watchThread?: string;
  me?: boolean;
  interval?: number;
  timeout?: string;
  exitOnMessage?: boolean;
  cookie?: string;
  noRtm?: boolean;
  asBot?: boolean;
};

// Normalize a --watch-thread argument into a Slack ts ("1700000000.000000").
// Accepts a raw dotted ts, a compact 16-digit ts (no dot), or a permalink.
export function resolveThreadTs(ref: string): string {
  if (ref.includes("slack.com")) {
    const parsed = parseSlackPermalink(ref);
    const ts = parsed?.threadTs ?? parsed?.ts;
    if (ts) return ts;
    throw new Error(`--watch-thread: could not extract a timestamp from "${ref}"`);
  }
  if (/^\d{10}\.\d{6}$/.test(ref)) return ref;
  if (/^\d{16}$/.test(ref)) return `${ref.slice(0, 10)}.${ref.slice(10)}`;
  throw new Error(`--watch-thread: "${ref}" is not a valid ts or permalink`);
}

export async function cmdTail(
  token: string,
  target: string | undefined,
  opts: TailOpts = {},
  signal?: AbortSignal,
): Promise<void> {
  if (opts.me && !target) {
    console.error(
      "slack tail --me requires a <target> channel.\n" +
      "Cross-channel mention streaming is not yet supported.\n" +
      "Use: slack tail \"#channel\" --me",
    );
    process.exit(1);
  }

  if (!target) {
    console.error("Usage: slack tail <#channel|@user>\n  Run `slack tail --help` for details.");
    process.exit(1);
  }

  const channelId = await resolveChannel(token, target);
  const interval = opts.interval ?? 60000;
  // Optional auto-stop deadline (e.g. wait at most 30m for a reply).
  const deadline = opts.timeout ? _internals.now() + parseSince(opts.timeout) * 1000 : Infinity;
  const cache = new Map<string, string>();
  const seen = new Set<string>();

  // Preflight: verify channel access before entering the poll loop
  try {
    const info = asRecord(await conversationInfo(token, channelId) as Json);
    const ch = asRecord(info.channel as Json);
    if (ch.is_archived === true) {
      console.error(`Warning: this channel is archived — no new messages will arrive.`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not_in_channel")) {
      console.error(`Error: you are not a member of that channel. Join it in Slack first, then retry.`);
      process.exit(1);
    }
    if (msg.includes("missing_scope")) {
      console.error(`Error: token lacks the required history scope. Check your token's channels:history (or groups:history) permission.`);
      process.exit(1);
    }
    if (msg.includes("channel_not_found")) {
      console.error(`Error: channel not found — it may be a private channel inaccessible with your token.`);
      process.exit(1);
    }
    // Non-fatal: warn and continue (e.g. transient network error)
    console.error(`Warning: preflight check failed: ${msg}`);
  }

  let cursor = "";
  if (opts.since) {
    const secondsBack = parseSince(opts.since);
    cursor = (_internals.now() / 1000 - secondsBack).toFixed(6);
  } else {
    // Seed with most recent message so we only emit new messages going forward
    const histResp = asRecord((await history(token, channelId, 1)) as Json);
    const msgs = asArray(histResp.messages).map(asRecord);
    if (msgs.length > 0 && typeof msgs[0]?.ts === "string") {
      cursor = msgs[0].ts;
      seen.add(cursor);
    } else {
      cursor = (_internals.now() / 1000).toFixed(6);
    }
  }

  let myUserId: string | undefined;
  if (opts.me || opts.exitOnMessage) {
    const info = await authTest(token);
    myUserId = info.userId || undefined;
  }

  let watchThreadTs: string | undefined;
  if (opts.watchThread !== undefined) {
    try {
      watchThreadTs = resolveThreadTs(opts.watchThread);
    } catch (e: unknown) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  const pollOpts: PollOpts = {
    ...(opts.thread !== undefined ? { thread: opts.thread } : {}),
    ...(watchThreadTs !== undefined ? { watchThread: watchThreadTs } : {}),
    ...(opts.me !== undefined ? { me: opts.me } : {}),
    ...(myUserId !== undefined ? { myUserId } : {}),
  };

  // RTM path: xoxc token + cookie + no backfill requested. Bot-token mode has
  // no RTM cookie, and deadlines/exit-on-message stay in the polling loop.
  if (
    opts.asBot !== true && token.startsWith("xoxc-") && opts.cookie !== undefined && opts.noRtm !== true &&
    opts.since === undefined && opts.timeout === undefined && opts.exitOnMessage !== true
  ) {
    await _internals.tailRTM(token, opts.cookie, channelId, pollOpts, seen, cache, signal);
    if (signal?.aborted) return;
    console.error("RTM unavailable — switching to polling.");
  }

  let isFirstPoll = true;
  let lastPollEndTime = _internals.now();

  while (!signal?.aborted) {
    if (_internals.now() >= deadline) return; // --timeout reached

    let sawOther = false;
    try {
      const now = _internals.now();
      const elapsed = now - lastPollEndTime;
      // If we woke after an unexpectedly long gap (e.g. laptop sleep), paginate to
      // avoid missing messages beyond the single-page limit.
      const shouldPaginate = interval > 0 && elapsed > interval * 5;

      let pageCursor: string | undefined;
      let isFirstPage = true;

      do {
        const { newCursor, lines, nextPageCursor, emittedOther } = await pollCycle(
          token,
          channelId,
          cursor,
          pollOpts,
          seen,
          cache,
          pageCursor,
        );
        cursor = newCursor;

        if (isFirstPoll && isFirstPage && opts.since && lines.length === 0) {
          process.stdout.write(`(no messages in the last ${opts.since} — watching for new)\n`);
        }
        isFirstPage = false;

        for (const line of lines) process.stdout.write(line + "\n");
        if (emittedOther) sawOther = true;
        pageCursor = shouldPaginate ? nextPageCursor : undefined;
      } while (pageCursor);

      isFirstPoll = false;
    } catch (e: unknown) {
      if (e instanceof RateLimitError) {
        console.error(`Warning: Slack rate limit hit — backing off for ${e.retryAfter}s`);
        await _internals.sleep(e.retryAfter * 1000);
        continue;
      }
      throw e;
    }

    // Stop as soon as a reply from someone else arrives.
    if (opts.exitOnMessage && sawOther) return;

    lastPollEndTime = _internals.now();
    // Sleep the poll interval, but never past the deadline.
    const remaining = deadline - _internals.now();
    if (remaining <= 0) return;
    await _internals.sleep(Math.min(interval, remaining));
  }
}
