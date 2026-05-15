import { history, resolveChannel, userInfoPair, authTest, conversationInfo, RateLimitError, type Json } from "./slack.ts";
import { resolveDateMarkup, resolveMentions } from "./format.ts";

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
};

function asRecord(v: Json | undefined): Record<string, Json> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {};
}

function asArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
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
  const who = chLabel ? `${chLabel}  @${handle}` : `@${handle}`;
  return `${stamp}  ${who}:  ${body}`;
}

type PollOpts = {
  thread?: string;
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
): Promise<{ newCursor: string; lines: string[]; hasMore: boolean; nextPageCursor: string | undefined }> {
  const histResp = asRecord((await history(
    token,
    channelId,
    20,
    pageCursor ? undefined : (cursor || undefined),
    pageCursor,
  )) as Json);
  // history returns newest-first; reverse to emit oldest-first
  const msgs = asArray(histResp.messages).map(asRecord).reverse();

  const meta = asRecord(histResp.response_metadata as Json | undefined);
  const nextPageCursor = (histResp.has_more === true && typeof meta.next_cursor === "string")
    ? meta.next_cursor
    : undefined;

  const lines: string[] = [];
  let newCursor = cursor;

  for (const m of msgs) {
    const ts = typeof m.ts === "string" ? m.ts : "";
    if (!ts || seen.has(ts)) continue;

    // Skip edit/delete events; only display original messages
    const subtype = typeof m.subtype === "string" ? m.subtype : "";
    if (subtype === "message_changed" || subtype === "message_deleted") continue;

    if (opts.thread) {
      const parentTs = typeof m.thread_ts === "string" ? m.thread_ts : ts;
      if (parentTs !== opts.thread && ts !== opts.thread) continue;
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
    newCursor = ts;
  }

  return { newCursor, lines, hasMore: histResp.has_more === true, nextPageCursor };
}

export type TailOpts = {
  since?: string;
  thread?: string;
  me?: boolean;
  interval?: number;
};

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
  if (opts.me) {
    const info = await authTest(token);
    myUserId = info.userId || undefined;
  }

  const pollOpts: PollOpts = {
    ...(opts.thread !== undefined ? { thread: opts.thread } : {}),
    ...(opts.me !== undefined ? { me: opts.me } : {}),
    ...(myUserId !== undefined ? { myUserId } : {}),
  };

  let isFirstPoll = true;
  let lastPollEndTime = _internals.now();

  while (!signal?.aborted) {
    try {
      const now = _internals.now();
      const elapsed = now - lastPollEndTime;
      // If we woke after an unexpectedly long gap (e.g. laptop sleep), paginate to
      // avoid missing messages beyond the single-page limit.
      const shouldPaginate = interval > 0 && elapsed > interval * 5;

      let pageCursor: string | undefined;
      let isFirstPage = true;

      do {
        const { newCursor, lines, nextPageCursor } = await pollCycle(
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

    lastPollEndTime = _internals.now();
    await _internals.sleep(interval);
  }
}
