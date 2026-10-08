import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { parseSse, relaySubscriber, RelayAuthError, type Doorbell, type Hello } from "../ts/relay.ts";
import { doorbellOf, safeEqual, verifySlack } from "../worker/src/slack.ts";

describe("parseSse", () => {
  test("frames, ids, multi-line data, comments and a partial tail", () => {
    const got: [string, string, string | undefined][] = [];
    const rest = parseSse(
      ": ka\n\nevent: hello\ndata: {\"seq\":3}\n\nid: 4\nevent: bell\ndata: a\ndata:b\n\nid: 5\nevent: be",
      (e, d, i) => got.push([e, d, i]),
    );
    expect(got).toEqual([["hello", "{\"seq\":3}", undefined], ["bell", "a\nb", "4"]]);
    expect(rest).toBe("id: 5\nevent: be");
  });
  test("a field without a colon, and a frame with no data, are tolerated", () => {
    const got: string[] = [];
    expect(parseSse("data\n\nevent: x\n\n", (e, d) => got.push(`${e}=${d}`))).toBe("");
    expect(got).toEqual(["message="]);
  });
});

describe("relaySubscriber (against a local SSE server)", () => {
  let server: Server;
  let base: string;
  const seen: { auth: string | undefined; url: string | undefined }[] = [];
  let mode: "ok" | "401" | "500" | "silent" | "crlf" = "ok";
  let res: ServerResponse | undefined;
  beforeAll(async () => {
    server = createServer((req, r) => {
      seen.push({ auth: req.headers.authorization, url: req.url });
      if (mode === "401") { r.writeHead(401).end(); return; }
      if (mode === "500") { r.writeHead(500).end(); return; }
      r.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "silent") { res = r; return; }
      if (mode === "crlf") {
        // A \r\n pair split across two network chunks.
        r.write("event: hello\r\ndata: {\"seq\":1,\"gap\":false,\"retention_sec\":3600}\r\n\r");
        setTimeout(() => r.end("\nid: 2\r\nevent: bell\r\ndata: {\"channel\":\"C00000001\",\"ts\":\"1.000001\"}\r\n\r\n"), 30);
        return;
      }
      r.write("event: hello\r\ndata: {\"seq\":4,\"gap\":false,\"retention_sec\":3600}\r\n\r\n: ka\n\n");
      r.write("id: 5\nevent: bell\ndata: {\"channel\":\"C00000001\",\"ts\":\"1.000001\"}\n\nid: 6\nevent: bell\n");
      r.end("data: {\"channel\":\"C00000001\",\"ts\":\"2.000001\",\"thread_ts\":\"1.000001\"}\n\n");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    res?.destroy();
    await new Promise<void>((ok) => server.close(() => ok()));
  });

  test("sends the bearer token in a header, resumes with ?after, delivers hello and bells", async () => {
    mode = "ok";
    const hellos: Hello[] = [];
    const bells: [number, Doorbell][] = [];
    await relaySubscriber(base, "tok-1")({ seq: 4, epoch: "e 1" }, new AbortController().signal, {
      hello: (h) => hellos.push(h), bell: (s, b) => bells.push([s, b]),
    });
    expect(seen.at(-1)).toEqual({ auth: "Bearer tok-1", url: "/stream?after=4&epoch=e%201" });
    expect(hellos).toEqual([{ seq: 4, gap: false, retention_sec: 3600 }]);
    expect(bells).toEqual([
      [5, { channel: "C00000001", ts: "1.000001" }],
      [6, { channel: "C00000001", ts: "2.000001", thread_ts: "1.000001" }],
    ]);
    await relaySubscriber(base, "tok-1")(undefined, new AbortController().signal, { hello: () => {}, bell: () => {} });
    expect(seen.at(-1)!.url).toBe("/stream");
  });

  test("a CRLF pair split across chunks still separates frames", async () => {
    mode = "crlf";
    const got: string[] = [];
    await relaySubscriber(base, "x")(undefined, new AbortController().signal, {
      hello: (h) => got.push(`hello ${h.seq}`), bell: (sq) => got.push(`bell ${sq}`),
    });
    expect(got).toEqual(["hello 1", "bell 2"]);
  });

  test("401 is a RelayAuthError; other statuses are plain errors", async () => {
    mode = "401";
    const noop = { hello: () => {}, bell: () => {} };
    await expect(relaySubscriber(base, "bad")(undefined, new AbortController().signal, noop)).rejects.toBeInstanceOf(RelayAuthError);
    mode = "500";
    await expect(relaySubscriber(base, "x")(undefined, new AbortController().signal, noop)).rejects.toThrow("relay: HTTP 500");
  });

  test("silence past idleMs is an error; an abort resolves quietly", async () => {
    mode = "silent";
    const noop = { hello: () => {}, bell: () => {} };
    await expect(relaySubscriber(base, "x", 150)(undefined, new AbortController().signal, noop)).rejects.toThrow("relay: no data for 0s");
    const ac = new AbortController();
    const p = relaySubscriber(base, "x", 60_000)(undefined, ac.signal, noop);
    setTimeout(() => ac.abort(), 50);
    await expect(p).resolves.toBeUndefined();
  });
});

describe("worker: Slack request signing", () => {
  const secret = "s3cret";
  const sign = (ts: string, body: string): string => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  test("accepts a valid signature; rejects a wrong one, a stale timestamp, or missing headers", async () => {
    const body = "{\"type\":\"event_callback\"}";
    expect(await verifySlack(secret, "1000", sign("1000", body), body, 1100)).toBe(true);
    expect(await verifySlack(secret, "1000", sign("1000", body + " "), body, 1100)).toBe(false);
    expect(await verifySlack(secret, "1000", sign("1000", body), body, 1000 + 301)).toBe(false);
    expect(await verifySlack(secret, "abc", sign("abc", body), body, 1000)).toBe(false);
    expect(await verifySlack(secret, null, sign("1000", body), body, 1000)).toBe(false);
    expect(await verifySlack("", "1000", sign("1000", body), body, 1000)).toBe(false);
  });
  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
  });
});

describe("worker: doorbellOf keeps ids and timestamps only", () => {
  const cb = (event: Record<string, unknown>, team = "T00000001"): unknown => ({ type: "event_callback", team_id: team, event });
  test("a message and a thread reply become bells without text or sender", () => {
    expect(doorbellOf(cb({ type: "message", channel: "C00000001", ts: "1700000000.000100", user: "U00000001", text: "secret" })))
      .toEqual({ channel: "C00000001", ts: "1700000000.000100" });
    expect(doorbellOf(cb({ type: "app_mention", channel: "C00000001", ts: "1700000000.000200", thread_ts: "1700000000.000100", text: "x" })))
      .toEqual({ channel: "C00000001", ts: "1700000000.000200", thread_ts: "1700000000.000100" });
    // A thread parent carries thread_ts == ts: not a reply.
    expect(doorbellOf(cb({ type: "message", channel: "D00000001", ts: "1700000000.000100", thread_ts: "1700000000.000100" })))
      .toEqual({ channel: "D00000001", ts: "1700000000.000100" });
  });
  test("edits, deletes, joins, other event types, other workspaces and junk ring nothing", () => {
    expect(doorbellOf(cb({ type: "message", subtype: "message_changed", channel: "C00000001", ts: "1700000000.000100" }))).toBeNull();
    expect(doorbellOf(cb({ type: "message", subtype: "channel_join", channel: "C00000001", ts: "1700000000.000100" }))).toBeNull();
    expect(doorbellOf(cb({ type: "reaction_added", channel: "C00000001", ts: "1700000000.000100" }))).toBeNull();
    expect(doorbellOf(cb({ type: "message", channel: "C00000001", ts: "1700000000.000100" }, "T00000002"), "T00000001")).toBeNull();
    expect(doorbellOf(cb({ type: "message", channel: "../x", ts: "1700000000.000100" }))).toBeNull();
    expect(doorbellOf(cb({ type: "message", channel: "C00000001", ts: "now" }))).toBeNull();
    expect(doorbellOf({ type: "url_verification" })).toBeNull();
    expect(doorbellOf(null)).toBeNull();
    expect(doorbellOf({ type: "event_callback" })).toBeNull();
  });
  test("thread_broadcast still rings (it is a reply shown in the channel)", () => {
    expect(doorbellOf(cb({ type: "message", subtype: "thread_broadcast", channel: "C00000001", ts: "1700000000.000200", thread_ts: "1700000000.000100" })))
      .toEqual({ channel: "C00000001", ts: "1700000000.000200", thread_ts: "1700000000.000100" });
  });
});
