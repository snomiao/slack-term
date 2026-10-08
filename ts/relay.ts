// Client for the slack-term relay (worker/): a Cloudflare Worker that receives
// Slack's Events API and serves "doorbells" — {channel, ts, thread_ts}, never
// message text — as a resumable Server-Sent Events stream. `slack stream` uses
// it to scan the one channel a bell names within a second of the post, instead
// of waiting for its next poll.
//
// SSE over fetch (not WebSocket) so the bearer token travels in a header on
// both bun and node, and never in a URL.

/** A bell: where a message just appeared. */
export type Doorbell = { channel: string; ts: string; thread_ts?: string };

/** First frame of every connection. `seq` is the resume point the relay
 *  starts from; `gap` means bells after the requested seq are gone (expired,
 *  or the relay was reset), so the client must catch up by polling. */
export type Hello = { seq: number; gap: boolean; retention_sec: number };

export type RelayHandlers = {
  hello(h: Hello): void;
  bell(seq: number, b: Doorbell): void;
};

/** Subscribe from `after` (undefined = from now). Resolves when the server
 *  closes the stream; rejects on HTTP errors, network errors and silence
 *  longer than `idleMs` (the relay sends a keepalive every 25 s). */
export type Subscribe = (after: number | undefined, signal: AbortSignal, on: RelayHandlers) => Promise<void>;

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

export function relaySubscriber(baseUrl: string, token: string, idleMs = 70_000): Subscribe {
  const base = baseUrl.replace(/\/+$/, "");
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
      const res = await fetch(`${base}/stream${after !== undefined ? `?after=${after}` : ""}`, {
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
        buf = parseSse(buf + dec.decode(value, { stream: true }).replace(/\r\n/g, "\n"), (event, data, id) => {
          const j = JSON.parse(data) as unknown;
          if (event === "hello") on.hello(j as Hello);
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
