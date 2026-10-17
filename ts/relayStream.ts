// Realtime wake-ups for `bun run relay`: an outbound WebSocket to the relay Worker
// (relay-worker/), which turns Slack Events API callbacks into tiny
// {channel, ts, thread_ts} frames. A frame only cuts the poll sleep short — the
// relay still reads, filters and dedupes through the API — so a dropped or
// duplicated frame costs nothing, and polling stays the fallback.

export type WakeFrame = { type: "wake"; channel: string; ts: string; thread_ts?: string };

export type StreamOpts = {
  url: string;                       // wss://<worker>/stream
  key: string;                       // RELAY_KEY, sent as the first frame (never in the URL)
  onWake: (w: WakeFrame) => void;
  onState?: (s: "open" | "closed", why?: string) => void;
  pingMs?: number;
  maxBackoffMs?: number;
};

/** Connect and keep reconnecting (exponential backoff, capped). Returns a stop(). */
export function connectRelayStream(o: StreamOpts): () => void {
  let stopped = false;
  let ws: WebSocket | undefined;
  let backoff = 1000;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = (): void => {
    if (stopped) return;
    ws = new WebSocket(o.url);
    ws.onopen = () => { ws!.send(JSON.stringify({ auth: o.key })); };
    ws.onmessage = (ev) => {
      let f: { type?: string; channel?: string; ts?: string; thread_ts?: string };
      try { f = JSON.parse(String(ev.data)); } catch { return; }
      if (f.type === "hello") {
        backoff = 1000;
        o.onState?.("open");
        ping = setInterval(() => { try { ws?.send("ping"); } catch { /* closing */ } }, o.pingMs ?? 30_000);
      } else if (f.type === "wake" && f.channel && f.ts) {
        o.onWake(f as WakeFrame);
      }
    };
    ws.onclose = (ev) => {
      if (ping) clearInterval(ping);
      ping = undefined;
      o.onState?.("closed", `${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`);
      if (stopped) return;
      retry = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, o.maxBackoffMs ?? 60_000);
    };
    ws.onerror = () => { /* onclose follows */ };
  };
  open();
  return () => {
    stopped = true;
    if (ping) clearInterval(ping);
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

/** A sleep that a wake can end early. */
export function wakeableSleep(): { sleep: (ms: number) => Promise<void>; wake: () => void } {
  let resolve: (() => void) | undefined;
  return {
    sleep: (ms) => new Promise<void>((r) => {
      const t = setTimeout(() => { resolve = undefined; r(); }, ms);
      resolve = () => { clearTimeout(t); resolve = undefined; r(); };
    }),
    wake: () => resolve?.(),
  };
}
