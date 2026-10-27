import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  bearerProtocol, relaySubscriber, relayTransport, WS_PROTOCOL,
  type Doorbell, type Hello, type RelayHandlers, type WebSocketCtor, type WebSocketLike,
} from "../ts/relay.ts";
import { base64url, PROTOCOL, protocolAuthorized } from "../worker/src/hub.ts";

/** An in-memory WebSocket the test drives from the "server" side. */
class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  static throwOnNew = false;
  readyState = 0;
  sent: string[] = [];
  closed: number | undefined;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onerror: WebSocketLike["onerror"] = null;
  onclose: WebSocketLike["onclose"] = null;
  constructor(readonly url: string, readonly protocols: string[]) {
    if (FakeWs.throwOnNew) throw new SyntaxError("bad url");
    FakeWs.all.push(this);
  }
  send(d: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(d);
  }
  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
  // server side
  open(): void { this.readyState = 1; this.onopen?.({}); }
  push(m: unknown): void { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  fail(): void { this.onerror?.({}); this.readyState = 3; this.onclose?.({ code: 1006, reason: "" }); }
  shut(code: number, reason = ""): void { this.readyState = 3; this.onclose?.({ code, reason }); }
  acks(): number[] { return this.sent.filter((s) => s !== "ping").map((s) => (JSON.parse(s) as { seq: number }).seq); }
}
const Fake = FakeWs as unknown as WebSocketCtor;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const last = (): FakeWs => FakeWs.all.at(-1)!;
const rec = (): RelayHandlers & { hellos: Hello[]; bells: [number, Doorbell][] } => {
  const r = { hellos: [] as Hello[], bells: [] as [number, Doorbell][] };
  return { ...r, hello: (h) => r.hellos.push(h), bell: (s, b) => r.bells.push([s, b]) };
};
const bell = (seq: number): unknown => ({ type: "bell", seq, bell: { channel: "C00000001", ts: `${seq}.000001` } });

describe("relay WebSocket auth scheme", () => {
  test("the bearer rides base64url-encoded in a subprotocol, and client and worker agree on it", () => {
    expect(WS_PROTOCOL).toBe(PROTOCOL);
    for (const t of ["tok-1", "a+b/c=d", "トークン", "x".repeat(200)]) {
      expect(bearerProtocol(t)).toBe(`bearer.${base64url(t)}`);
      expect(bearerProtocol(t)).toMatch(/^bearer\.[A-Za-z0-9_-]+$/);
      expect(protocolAuthorized(`${PROTOCOL}, ${bearerProtocol(t)}`, t)).toBe(true);
    }
  });
  test("protocolAuthorized rejects a wrong or missing token, or a missing protocol", () => {
    expect(protocolAuthorized(`${PROTOCOL}, ${bearerProtocol("tok-2")}`, "tok-1")).toBe(false);
    expect(protocolAuthorized(bearerProtocol("tok-1"), "tok-1")).toBe(false);
    expect(protocolAuthorized(PROTOCOL, "tok-1")).toBe(false);
    expect(protocolAuthorized(null, "tok-1")).toBe(false);
    expect(protocolAuthorized(`${PROTOCOL}, bearer.`, "")).toBe(false);
  });
  test("relayTransport reads SLACK_RELAY_TRANSPORT", () => {
    expect(relayTransport("sse")).toBe("sse");
    expect(relayTransport("websocket")).toBe("websocket");
    expect(relayTransport(undefined)).toBe("auto");
    expect(relayTransport("ws")).toBe("auto");
  });
});

describe("relaySubscriber over WebSocket (fake socket)", () => {
  test("connects to /ws with resume point and token subprotocol; delivers hello and bells; acks in batches", async () => {
    FakeWs.all = [];
    const r = rec();
    const ac = new AbortController();
    const p = relaySubscriber("https://relay.example/", "tok-1", 60_000, { WebSocket: Fake, ackDelayMs: 20 })({ seq: 4, epoch: "e 1" }, ac.signal, r);
    const ws = last();
    expect(ws.url).toBe("wss://relay.example/ws?after=4&epoch=e%201");
    expect(ws.protocols).toEqual([WS_PROTOCOL, bearerProtocol("tok-1")]);
    expect(ws.protocols.join()).not.toContain("tok-1");
    ws.open();
    ws.push({ type: "hello", seq: 4, gap: false, retention_sec: 3600, epoch: "e 1" });
    ws.push("pong");
    ws.onmessage?.({ data: new ArrayBuffer(1) }); // binary: ignored
    ws.push(bell(5));
    ws.push({ type: "bell", seq: 6, bell: { channel: "C00000001", ts: "2.000001", thread_ts: "1.000001" } });
    ws.push({ type: "other" });
    expect(r.hellos).toEqual([{ seq: 4, gap: false, retention_sec: 3600, epoch: "e 1", via: "websocket" }]);
    expect(r.bells).toEqual([
      [5, { channel: "C00000001", ts: "5.000001" }],
      [6, { channel: "C00000001", ts: "2.000001", thread_ts: "1.000001" }],
    ]);
    expect(ws.acks()).toEqual([]); // batched...
    await tick(40);
    expect(ws.acks()).toEqual([6]); // ...one ack for both
    // 32 unacked: acked at once, without waiting for the timer.
    for (let s = 7; s <= 38; s++) ws.push(bell(s));
    expect(ws.acks()).toEqual([6, 38]);
    await tick(40);
    expect(ws.acks()).toEqual([6, 38]); // nothing new to ack
    ac.abort();
    await expect(p).resolves.toBeUndefined();
    expect(ws.closed).toBe(1000);
  });

  test("pings on an interval; a normal close resolves, an abnormal one rejects", async () => {
    FakeWs.all = [];
    const p = relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: Fake, pingMs: 10 })(undefined, new AbortController().signal, rec());
    const ws = last();
    expect(ws.url).toBe("ws://relay.example/ws");
    ws.open();
    await tick(35);
    expect(ws.sent.filter((s) => s === "ping").length).toBeGreaterThanOrEqual(2);
    ws.shut(1000);
    await expect(p).resolves.toBeUndefined();

    const q = relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: Fake })(undefined, new AbortController().signal, rec());
    last().open();
    last().shut(4008, "overflow");
    await expect(q).rejects.toThrow("relay: WebSocket closed (4008 overflow)");
    const q2 = relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: Fake })(undefined, new AbortController().signal, rec());
    last().open();
    last().shut(1006);
    await expect(q2).rejects.toThrow("relay: WebSocket closed (1006)");
  });

  test("a send on a dead socket is left to the close event", async () => {
    FakeWs.all = [];
    const ac = new AbortController();
    const p = relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: Fake, pingMs: 5, ackDelayMs: 5 })(undefined, ac.signal, rec());
    const ws = last();
    ws.open();
    ws.push({ type: "hello", seq: 0, gap: false, retention_sec: 3600 });
    ws.push(bell(1));
    ws.readyState = 2; // closing: send throws
    await tick(20);
    expect(ws.sent).toEqual([]);
    ac.abort();
    await p;
  });

  test("silence past idleMs after the open is an error", async () => {
    FakeWs.all = [];
    const p = relaySubscriber("http://relay.example", "t", 50, { WebSocket: Fake })(undefined, new AbortController().signal, rec());
    last().open();
    await expect(p).rejects.toThrow("relay: no data for 0s");
  });

  test("a malformed message is an error", async () => {
    FakeWs.all = [];
    const p = relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: Fake })(undefined, new AbortController().signal, rec());
    last().open();
    last().push("{not json");
    await expect(p).rejects.toThrow();
  });

  test("a handler that hangs up mid-bell (the stream's backlog pause) sends no ack", async () => {
    FakeWs.all = [];
    const ac = new AbortController();
    const p = relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: Fake, ackDelayMs: 1 })(undefined, ac.signal, {
      hello: () => {}, bell: () => ac.abort(),
    });
    const ws = last();
    ws.open();
    ws.push({ type: "hello", seq: 0, gap: false, retention_sec: 3600 });
    ws.push(bell(1));
    await expect(p).resolves.toBeUndefined();
    await tick(5);
    expect(ws.acks()).toEqual([]);
    expect(ws.closed).toBe(1000);
  });

  test("already aborted: no socket at all", async () => {
    FakeWs.all = [];
    const ac = new AbortController();
    ac.abort();
    await relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: Fake })(undefined, ac.signal, rec());
    expect(FakeWs.all).toEqual([]);
  });

  test("transport websocket: no fallback", async () => {
    FakeWs.all = [];
    const s = relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: Fake, transport: "websocket" });
    const p = s(undefined, new AbortController().signal, rec());
    last().fail();
    await expect(p).rejects.toThrow("relay: WebSocket connection failed");
    await expect(relaySubscriber("http://relay.example", "t", 60_000, { WebSocket: null, transport: "websocket" })(undefined, new AbortController().signal, rec()))
      .rejects.toThrow("relay: this runtime has no WebSocket");
  });

  test("an abort during the handshake resolves without falling back", async () => {
    FakeWs.all = [];
    const ac = new AbortController();
    const p = relaySubscriber("http://127.0.0.1:1", "t", 60_000, { WebSocket: Fake })(undefined, ac.signal, rec());
    ac.abort();
    await expect(p).resolves.toBeUndefined();
  });
});

describe("relaySubscriber falls back to SSE when the socket cannot open", () => {
  let server: Server;
  let base: string;
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((req, r) => {
      seen.push(req.url!);
      if (req.headers.authorization !== "Bearer tok-1") { r.writeHead(401).end(); return; }
      r.writeHead(200, { "content-type": "text/event-stream" });
      r.end("event: hello\ndata: {\"seq\":2,\"gap\":false,\"retention_sec\":3600}\n\nid: 3\nevent: bell\ndata: {\"channel\":\"C00000001\",\"ts\":\"1.000001\"}\n\n");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
  });

  test("a refused upgrade (an old relay) — the same call continues over SSE", async () => {
    FakeWs.all = [];
    const r = rec();
    const p = relaySubscriber(base, "tok-1", 60_000, { WebSocket: Fake })({ seq: 2 }, new AbortController().signal, r);
    last().fail();
    await p;
    expect(seen.at(-1)).toBe("/stream?after=2");
    expect(r.hellos).toEqual([{ seq: 2, gap: false, retention_sec: 3600, via: "sse" }]);
    expect(r.bells).toEqual([[3, { channel: "C00000001", ts: "1.000001" }]]);
  });

  test("a hanging handshake falls back after idleMs; a constructor that throws falls back at once", async () => {
    FakeWs.all = [];
    const r = rec();
    await relaySubscriber(base, "tok-1", 50, { WebSocket: Fake })(undefined, new AbortController().signal, r);
    expect(r.hellos.map((h) => h.via)).toEqual(["sse"]);
    FakeWs.throwOnNew = true;
    try {
      const r2 = rec();
      await relaySubscriber(base, "tok-1", 60_000, { WebSocket: Fake })(undefined, new AbortController().signal, r2);
      expect(r2.hellos.map((h) => h.via)).toEqual(["sse"]);
    } finally {
      FakeWs.throwOnNew = false;
    }
  });

  test("a bad token surfaces as SSE's 401; no WebSocket in the runtime goes straight to SSE", async () => {
    FakeWs.all = [];
    const p = relaySubscriber(base, "bad", 60_000, { WebSocket: Fake })(undefined, new AbortController().signal, rec());
    last().fail();
    await expect(p).rejects.toThrow("401");
    const r = rec();
    await relaySubscriber(base, "tok-1", 60_000, { WebSocket: null })(undefined, new AbortController().signal, r);
    expect(r.hellos.map((h) => h.via)).toEqual(["sse"]);
  });

  test("defaults to the runtime's own WebSocket", async () => {
    // bun and node >= 22 have one: the refused upgrade falls back; node 20 has none.
    const r = rec();
    await relaySubscriber(base, "tok-1", 5_000)(undefined, new AbortController().signal, r);
    expect(r.hellos.map((h) => h.via)).toEqual(["sse"]);
  });
});

describe.skipIf(typeof Bun === "undefined")("relaySubscriber against a real WebSocket server (bun)", () => {
  test("handshake with the token subprotocol, hello, bells, acks", async () => {
    const got: { protocol: string | null; url: string; msgs: string[] } = { protocol: null, url: "", msgs: [] };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        got.protocol = req.headers.get("sec-websocket-protocol");
        got.url = new URL(req.url).pathname + new URL(req.url).search;
        if (!protocolAuthorized(got.protocol, "tok-1")) return new Response("unauthorized", { status: 401 });
        return srv.upgrade(req, { headers: { "sec-websocket-protocol": PROTOCOL } }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "hello", seq: 7, gap: true, retention_sec: 3600, epoch: "e" }));
          ws.send(JSON.stringify(bell(8)));
        },
        message(ws, m) {
          got.msgs.push(String(m));
          if (String(m) === "ping") ws.send("pong");
          else ws.close(1000, "done");
        },
      },
    });
    try {
      const r = rec();
      await relaySubscriber(`http://127.0.0.1:${server.port}`, "tok-1", 5_000, { ackDelayMs: 1 })({ seq: 7, epoch: "e" }, new AbortController().signal, r);
      expect(got.url).toBe("/ws?after=7&epoch=e");
      expect(got.protocol).toBe(`${PROTOCOL}, ${bearerProtocol("tok-1")}`);
      expect(r.hellos).toEqual([{ seq: 7, gap: true, retention_sec: 3600, epoch: "e", via: "websocket" }]);
      expect(r.bells).toEqual([[8, { channel: "C00000001", ts: "8.000001" }]]);
      expect(got.msgs).toEqual([JSON.stringify({ type: "ack", seq: 8 })]);
    } finally {
      void server.stop(true);
    }
  });
});
