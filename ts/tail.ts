import { history, resolveChannel, userInfoPair, authTest, type Json } from "./slack.ts";
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
): Promise<{ newCursor: string; lines: string[] }> {
  const histResp = asRecord((await history(token, channelId, 20, cursor || undefined)) as Json);
  // history returns newest-first; reverse to emit oldest-first
  const msgs = asArray(histResp.messages).map(asRecord).reverse();

  const lines: string[] = [];
  let newCursor = cursor;

  for (const m of msgs) {
    const ts = typeof m.ts === "string" ? m.ts : "";
    if (!ts || seen.has(ts)) continue;

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

  return { newCursor, lines };
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

  let cursor = "";
  if (opts.since) {
    const secondsBack = parseSince(opts.since);
    cursor = (Date.now() / 1000 - secondsBack).toFixed(6);
  } else {
    // Seed with most recent message so we only emit new messages going forward
    const histResp = asRecord((await history(token, channelId, 1)) as Json);
    const msgs = asArray(histResp.messages).map(asRecord);
    if (msgs.length > 0 && typeof msgs[0]?.ts === "string") {
      cursor = msgs[0].ts;
      seen.add(cursor);
    } else {
      cursor = (Date.now() / 1000).toFixed(6);
    }
  }

  let myUserId: string | undefined;
  if (opts.me) {
    const info = await authTest(token);
    myUserId = info.userId || undefined;
  }

  while (!signal?.aborted) {
    const { newCursor, lines } = await pollCycle(
      token,
      channelId,
      cursor,
      {
        ...(opts.thread !== undefined ? { thread: opts.thread } : {}),
        ...(opts.me !== undefined ? { me: opts.me } : {}),
        ...(myUserId !== undefined ? { myUserId } : {}),
      },
      seen,
      cache,
    );
    cursor = newCursor;
    for (const line of lines) process.stdout.write(line + "\n");
    await _internals.sleep(interval);
  }
}
