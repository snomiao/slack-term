// The Worker is the only thing between the public internet and the relay, so its
// signature check is the gate; the stream client must authenticate before it is
// sent anything and survive the server going away.
import { describe, test, expect } from "./harness.ts";
import { createHmac } from "node:crypto";
import { verifySlackSignature, wakeFromEvent } from "../relay-worker/src/verify.ts";
import { connectRelayStream, wakeableSleep, type WakeFrame } from "../ts/relayStream.ts";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const sign = (ts: string, body: string, secret = SECRET): string =>
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

describe("verifySlackSignature", () => {
  const now = 1700000000;
  const body = '{"type":"event_callback"}';
  test("accepts a valid signature", async () => {
    expect(await verifySlackSignature(SECRET, String(now), sign(String(now), body), body, now)).toBe(true);
  });
  test("rejects a wrong secret, a tampered body, a stale timestamp, missing headers", async () => {
    expect(await verifySlackSignature(SECRET, String(now), sign(String(now), body, "other"), body, now)).toBe(false);
    expect(await verifySlackSignature(SECRET, String(now), sign(String(now), body), body + " ", now)).toBe(false);
    expect(await verifySlackSignature(SECRET, String(now - 301), sign(String(now - 301), body), body, now)).toBe(false);
    expect(await verifySlackSignature(SECRET, null, sign(String(now), body), body, now)).toBe(false);
    expect(await verifySlackSignature("", String(now), sign(String(now), body, ""), body, now)).toBe(false);
  });
});

describe("wakeFromEvent", () => {
  test("keeps only channel / ts / thread_ts", () => {
    const w = wakeFromEvent({ type: "event_callback", event: { type: "message", channel: "C00000001", ts: "1.2", thread_ts: "1.1", user: "U00000001", text: "secret stuff" } });
    expect(w).toEqual({ channel: "C00000001", ts: "1.2", thread_ts: "1.1" });
  });
  test("ignores other payloads", () => {
    expect(wakeFromEvent({ type: "url_verification", challenge: "x" })).toBeUndefined();
    expect(wakeFromEvent({ type: "event_callback", event: { type: "reaction_added", channel: "C00000001", ts: "1" } })).toBeUndefined();
  });
});

describe("relay stream client", () => {
  test("authenticates first, receives wakes, reconnects after a drop", { timeout: 30_000 }, async () => {
    const KEY = "k-test";
    const authed: string[] = [];
    let conns = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: {
        open() { conns++; },
        message(ws, msg) {
          if (msg === "ping") return;
          const { auth } = JSON.parse(String(msg)) as { auth?: string };
          if (auth !== KEY) { ws.close(4001, "unauthorized"); return; }
          authed.push(auth);
          ws.send(JSON.stringify({ type: "hello" }));
          ws.send(JSON.stringify({ type: "wake", channel: "C00000001", ts: `${conns}.0` }));
          if (conns === 1) setTimeout(() => ws.close(1012, "restart"), 50);
        },
      },
    });
    const wakes: WakeFrame[] = [];
    const states: string[] = [];
    const stop = connectRelayStream({ url: `ws://127.0.0.1:${server.port}/stream`, key: KEY, onWake: (w) => wakes.push(w), onState: (s) => states.push(s), maxBackoffMs: 200 });
    const t0 = Date.now();
    while (wakes.length < 2 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    stop();
    server.stop(true);
    expect(authed).toEqual([KEY, KEY]);
    expect(wakes.map((w) => w.ts)).toEqual(["1.0", "2.0"]);
    expect(states.slice(0, 3)).toEqual(["open", "closed", "open"]);
  });

  test("wakeableSleep ends early on wake", async () => {
    const s = wakeableSleep();
    const t0 = Date.now();
    setTimeout(s.wake, 30);
    await s.sleep(5_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("a socket that stops answering pings is replaced", { timeout: 30_000 }, async () => {
    let conns = 0;
    let mute = true; // the first connection goes silent after hello
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: {
        open() { conns++; },
        message(ws, msg) {
          if (msg === "ping") { if (!mute) ws.send("pong"); return; }
          ws.send(JSON.stringify({ type: "hello" }));
          if (conns > 1) mute = false;
        },
      },
    });
    const states: string[] = [];
    const stop = connectRelayStream({ url: `ws://127.0.0.1:${server.port}/stream`, key: "k", onWake: () => {}, onState: (s, w) => states.push(`${s}${w ? ":" + w : ""}`), pingMs: 100 });
    const t0 = Date.now();
    while (conns < 2 && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 20));
    stop();
    server.stop(true);
    expect(conns).toBe(2);
    expect(states).toContain("closed:no pong — reconnecting");
  });
});
