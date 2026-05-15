import { type Json, userInfoPair, clientBoot as clientBootImpl } from "./slack.ts";
import { resolveDateMarkup, resolveMentions } from "./format.ts";

export type RtmPollOpts = {
  thread?: string;
  me?: boolean;
  myUserId?: string;
};

// Minimal WebSocket interface — avoids requiring DOM lib in tsconfig
interface WsLike {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}
interface WsConstructor {
  new(url: string): WsLike;
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

async function formatRtmLine(
  token: string,
  m: Record<string, Json>,
  cache: Map<string, string>,
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
  return `${stamp}  @${handle}:  ${body}`;
}

async function connectAndStream(
  WS: WsConstructor,
  token: string,
  wsUrl: string,
  channelId: string,
  opts: RtmPollOpts,
  seen: Set<string>,
  cache: Map<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  // If already aborted before we even create the WS, resolve immediately.
  if (signal?.aborted) return;
  return new Promise<void>((resolve) => {
    const ws = new WS(wsUrl);

    signal?.addEventListener("abort", () => {
      ws.close();
      resolve();
    }, { once: true } as AddEventListenerOptions);

    ws.addEventListener("open", () => {
      process.stderr.write("Connected via RTM (experimental).\n");
    });

    ws.addEventListener("close", () => resolve());

    ws.addEventListener("error", () => resolve());

    ws.addEventListener("message", (event: unknown) => {
      void (async () => {
        try {
          let data: Record<string, Json>;
          try {
            data = JSON.parse(String((event as { data?: unknown }).data)) as Record<string, Json>;
          } catch {
            return;
          }

          const type = typeof data.type === "string" ? data.type : "";

          if (type === "ping") {
            ws.send(JSON.stringify({ type: "pong", reply_to: data.id ?? 0 }));
            return;
          }

          if (type !== "message") return;

          const msgChannel = typeof data.channel === "string" ? data.channel : "";
          if (msgChannel !== channelId) return;

          const ts = typeof data.ts === "string" ? data.ts : "";
          if (!ts || seen.has(ts)) return;

          const subtype = typeof data.subtype === "string" ? data.subtype : "";
          if (subtype === "message_changed" || subtype === "message_deleted") return;

          if (opts.thread) {
            const parentTs = typeof data.thread_ts === "string" ? data.thread_ts : ts;
            if (parentTs !== opts.thread && ts !== opts.thread) return;
          }

          if (opts.me && opts.myUserId) {
            const text = typeof data.text === "string" ? data.text : "";
            if (!text.includes(`<@${opts.myUserId}>`)) return;
          }

          seen.add(ts);
          if (seen.size > 1000) {
            const oldest = seen.values().next().value;
            if (oldest !== undefined) seen.delete(oldest);
          }

          const line = await formatRtmLine(token, data, cache);
          process.stdout.write(line + "\n");
        } catch (e: unknown) {
          process.stderr.write(`RTM message error: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      })();
    });
  });
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export const _internals = {
  sleep: (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms)),
  clientBoot: clientBootImpl,
  getWebSocket: (): WsConstructor | undefined => {
    const ws = (globalThis as Record<string, unknown>).WebSocket;
    return typeof ws === "function" ? ws as WsConstructor : undefined;
  },
};

export async function tailRTMImpl(
  token: string,
  cookie: string,
  channelId: string,
  opts: RtmPollOpts,
  seen: Set<string>,
  cache: Map<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const WS = _internals.getWebSocket();
  if (!WS) return;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal?.aborted) return;

    try {
      const { wsUrl } = await _internals.clientBoot(token, cookie);
      await connectAndStream(WS, token, wsUrl, channelId, opts, seen, cache, signal);
    } catch {
      // boot or connection error — retry
    }

    if (signal?.aborted) return;
    if (attempt < MAX_RETRIES - 1) {
      await _internals.sleep(RETRY_DELAY_MS);
    }
  }
}
