// Client for the slack-term relay (worker/): a Cloudflare Worker that receives
// Slack's Events API and serves "doorbells" — {channel, ts, thread_ts}, never
// message text — as a resumable stream. `slack stream` uses it to scan the one
// channel a bell names within a second of the post, instead of waiting for its
// next poll.
//
// Transport: a WebSocket to /ws first. The relay accepts it as a hibernatable
// socket, so its Durable Object is not kept awake (and billed) while we sit
// connected, and our 25 s "ping" is answered without waking it. The bearer
// token never goes in a URL: it rides in the Sec-WebSocket-Protocol header as
// `bearer.<base64url(token)>` — Node's WebSocket cannot set other headers.
// If the socket cannot be opened at all (a relay from before /ws, a proxy
// that strips upgrades, a runtime without WebSocket), the same connection
// falls back to the old Server-Sent Events endpoint, /stream, over fetch.

/** A bell: where a message just appeared. */
export type Doorbell = {
  channel: string; ts: string; thread_ts?: string;
  /** The relay app's bot user id, on that bot's own posts only. */
  self?: string;
};

/** First frame of every connection. `seq` is the resume point the relay
 *  starts from; `gap` means bells after the requested seq are gone (expired,
 *  or the relay was reset), so the client must catch up by polling. `epoch`
 *  names the relay's storage: a new one means its numbering restarted. */
export type Hello = {
  seq: number; gap: boolean; retention_sec: number; epoch?: string;
  /** Client-side: which transport this connection uses. */
  via?: Transport;
};

export type Transport = "websocket" | "sse";

/** Where to resume: the last seq taken, in the numbering of `epoch`. */
export type Cursor = { seq: number; epoch?: string };

export type RelayHandlers = {
  hello(h: Hello): void;
  bell(seq: number, b: Doorbell): void;
};

/** Subscribe from `after` (undefined = from now). Resolves when the server
 *  closes the stream; rejects on HTTP errors, network errors and silence
 *  longer than `idleMs` (the relay sends a keepalive every 25 s). */
export type Subscribe = (after: Cursor | undefined, signal: AbortSignal, on: RelayHandlers) => Promise<void>;

export class RelayAuthError extends Error {}

/** Parse SSE frames out of a growing buffer; returns the unparsed tail. */
export function parseSse(buf: string, emit: (event: string, data: string, id: string | undefined) => void): string {
  let i: number;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue; // keepalive / comment
      const c = line.indexOf(":");
      const field = c < 0 ? line : line.slice(0, c);
      const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length) emit(event, data.join("\n"), id);
  }
  return buf;
}

/** The subprotocol the relay's /ws speaks; it echoes this one back. */
export const WS_PROTOCOL = "slack-term-relay.v1";

/** The subprotocol that carries the bearer token: subprotocols must be HTTP
 *  tokens, so the token is base64url-encoded. */
export function bearerProtocol(token: string): string {
  return `bearer.${Buffer.from(token, "utf8").toString("base64url")}`;
}

/** The slice of the WHATWG WebSocket this client uses (bun's and node's). */
export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
};
export type WebSocketCtor = new (url: string, protocols: string[]) => WebSocketLike;

export type RelayOptions = {
  /** "auto" (default): WebSocket, falling back to SSE when it cannot open. */
  transport?: "auto" | Transport;
  /** Defaults to the runtime's global WebSocket; null means none. */
  WebSocket?: WebSocketCtor | null;
  /** Keepalive ping interval; the relay answers without waking up. */
  pingMs?: number;
  /** How long a received bell may wait for its ack (acks are batched). */
  ackDelayMs?: number;
};

/** SLACK_RELAY_TRANSPORT: "websocket" or "sse" pins one; anything else is "auto". */
export function relayTransport(v: string | undefined): "auto" | Transport {
  return v === "websocket" || v === "sse" ? v : "auto";
}

/** Received-but-unacked bells that trigger an ack at once. The relay cuts a
 *  client off at 64 unacked live bells, and replays its backlog one batch
 *  per ack. */
const ACK_EVERY = 32;

function resumeQuery(after: Cursor | undefined): string {
  return after === undefined ? "" : `?after=${after.seq}${after.epoch ? `&epoch=${encodeURIComponent(after.epoch)}` : ""}`;
}

export function relaySubscriber(baseUrl: string, token: string, idleMs = 70_000, opts: RelayOptions = {}): Subscribe {
  const base = baseUrl.replace(/\/+$/, "");
  const transport = opts.transport ?? "auto";
  const sse = sseSubscriber(base, token, idleMs);
  return async (after, signal, on) => {
    const WS = opts.WebSocket === undefined ? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket : opts.WebSocket;
    if (transport !== "sse") {
      if (!WS) {
        if (transport === "websocket") throw new Error("relay: this runtime has no WebSocket");
      } else {
        const opened = await wsSubscribe(WS, base, token, idleMs, opts.pingMs ?? 25_000, opts.ackDelayMs ?? 100, after, signal, on);
        if (opened || signal.aborted) return;
        // Never opened: an old relay, or something in between refusing the
        // upgrade. SSE says which — a 401 from it is a RelayAuthError.
        if (transport === "websocket") throw new Error("relay: WebSocket connection failed");
      }
    }
    return sse(after, signal, on);
  };
}

/** One WebSocket connection. Resolves true once it has been open (closed by
 *  the server normally, or aborted), false if it never opened — the caller
 *  then falls back to SSE. Rejects on an abnormal close or silence. */
function wsSubscribe(
  WS: WebSocketCtor, base: string, token: string, idleMs: number, pingMs: number, ackDelayMs: number,
  after: Cursor | undefined, signal: AbortSignal, on: RelayHandlers,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    if (signal.aborted) return resolve(true);
    let ws: WebSocketLike;
    try {
      ws = new WS(`${base.replace(/^http/i, "ws")}/ws${resumeQuery(after)}`, [WS_PROTOCOL, bearerProtocol(token)]);
    } catch {
      return resolve(false);
    }
    let opened = false;
    let done = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let last = 0; // highest seq received
    let acked = 0; // highest seq acked
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(ackTimer);
      clearInterval(ping);
      signal.removeEventListener("abort", onAbort);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(1000); } catch { /* already closing */ }
      if (err) reject(err);
      else resolve(opened || signal.aborted);
    };
    const onAbort = (): void => finish();
    signal.addEventListener("abort", onAbort, { once: true });
    const arm = (): void => {
      clearTimeout(idle);
      // Silence before the open is a handshake that hangs: fall back.
      idle = setTimeout(() => finish(opened ? new Error(`relay: no data for ${Math.round(idleMs / 1000)}s`) : undefined), idleMs);
    };
    const ack = (): void => {
      clearTimeout(ackTimer);
      ackTimer = undefined;
      if (last <= acked) return;
      acked = last;
      try { ws.send(JSON.stringify({ type: "ack", seq: last })); } catch { /* the close event reports it */ }
    };
    arm();
    ws.onopen = () => {
      opened = true;
      arm();
      ping = setInterval(() => { try { ws.send("ping"); } catch { /* the close event reports it */ } }, pingMs);
    };
    ws.onmessage = (ev) => {
      arm();
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let m: { type?: unknown; seq?: unknown; bell?: unknown };
      try {
        m = JSON.parse(ev.data) as typeof m;
      } catch (e) {
        return finish(e as Error);
      }
      if (m.type === "hello") {
        const { type: _, ...h } = m as Hello & { type: string };
        last = acked = h.seq;
        on.hello({ ...h, via: "websocket" });
      } else if (m.type === "bell" && typeof m.seq === "number") {
        on.bell(m.seq, m.bell as Doorbell);
        if (done) return; // the handler hung up
        last = Math.max(last, m.seq);
        if (last - acked >= ACK_EVERY) ack();
        else ackTimer ??= setTimeout(ack, ackDelayMs);
      }
    };
    ws.onerror = () => { /* a close event follows */ };
    ws.onclose = (ev) => {
      if (!opened || ev.code === 1000) return finish();
      finish(new Error(`relay: WebSocket closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`));
    };
  });
}

/** The Server-Sent Events transport (GET /stream). */
function sseSubscriber(base: string, token: string, idleMs: number): Subscribe {
  return async (after, signal, on) => {
    const ac = new AbortController();
    const stop = (): void => ac.abort();
    signal.addEventListener("abort", stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    let silent = false;
    const arm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => { silent = true; ac.abort(); }, idleMs);
    };
    try {
      arm();
      const res = await fetch(`${base}/stream${resumeQuery(after)}`, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: ac.signal,
      });
      if (res.status === 401) throw new RelayAuthError("relay rejected the token (401)");
      if (!res.ok || !res.body) throw new Error(`relay: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        arm();
        // CRLF is normalised on the whole buffer: a \r\n pair can straddle chunks.
        buf = parseSse((buf + dec.decode(value, { stream: true })).replace(/\r\n/g, "\n"), (event, data, id) => {
          const j = JSON.parse(data) as unknown;
          if (event === "hello") on.hello({ ...j as Hello, via: "sse" });
          else if (event === "bell" && id !== undefined) on.bell(Number(id), j as Doorbell);
        });
      }
    } catch (e) {
      if (signal.aborted) return;
      if (silent) throw new Error(`relay: no data for ${Math.round(idleMs / 1000)}s`);
      throw e;
    } finally {
      clearTimeout(idle);
      signal.removeEventListener("abort", stop);
    }
  };
}
