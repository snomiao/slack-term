import { describe, test, expect } from "./harness.ts";
import * as hub from "../worker/src/hub.ts";

/** A hibernatable socket as the Durable Object sees it. */
class FakeSock implements hub.Sock {
  out: string[] = [];
  closed: [number, string] | undefined;
  att: hub.Attachment | null = null;
  ping: number | null = null;
  broken = false;
  send(d: string): void {
    if (this.broken) throw new Error("closed");
    this.out.push(d);
  }
  close(code: number, reason: string): void { this.closed ??= [code, reason]; }
  attachment(): hub.Attachment | null { return this.att && { ...this.att }; } // a copy, like deserializeAttachment
  setAttachment(a: hub.Attachment): void { this.att = { ...a }; }
  lastPing(): number | null { return this.ping; }
  msgs(): { type: string; seq?: number }[] { return this.out.map((s) => JSON.parse(s) as { type: string; seq?: number }); }
  seqs(): number[] { return this.msgs().filter((m) => m.type === "bell").map((m) => m.seq!); }
}

/** The bells table. */
class FakeStore implements hub.Store {
  rows: hub.Row[] = [];
  add(seq: number): void { this.rows.push({ seq, channel: "C00000001", ts: `${seq}.000001`, thread_ts: null, self: null }); }
  rowsAfter(seq: number, limit: number): hub.Row[] { return this.rows.filter((r) => r.seq > seq).slice(0, limit); }
}

const hello = (seq: number): hub.Hello => ({ seq, gap: false, retention_sec: 3600, epoch: "e" });
const ack = (seq: unknown): string => JSON.stringify({ type: "ack", seq });

describe("hub.resumePoint (shared by /ws and /stream)", () => {
  test("from now, resume, expired, reset by epoch, reset by a number from the future", () => {
    expect(hub.resumePoint(null, null, "e", 5, 10)).toEqual({ from: 10, gap: false });
    expect(hub.resumePoint("x", null, "e", 5, 10)).toEqual({ from: 10, gap: false });
    expect(hub.resumePoint("7", "e", "e", 5, 10)).toEqual({ from: 7, gap: false });
    expect(hub.resumePoint("4", "e", "e", 5, 10)).toEqual({ from: 4, gap: false }); // oldest-1: nothing missed
    expect(hub.resumePoint("3", "e", "e", 5, 10)).toEqual({ from: 3, gap: true });
    expect(hub.resumePoint("7", "old", "e", 5, 10)).toEqual({ from: 0, gap: true });
    expect(hub.resumePoint("11", null, "e", 5, 10)).toEqual({ from: 0, gap: true });
    // Everything expired: only `latest` itself is a seamless resume.
    expect(hub.resumePoint("10", null, "e", null, 10)).toEqual({ from: 10, gap: false });
    expect(hub.resumePoint("9", null, "e", null, 10)).toEqual({ from: 9, gap: true });
  });
  test("bellOf keeps thread_ts and self only when set", () => {
    expect(hub.bellOf({ seq: 1, channel: "C00000001", ts: "1.1", thread_ts: null, self: null })).toEqual({ channel: "C00000001", ts: "1.1" });
    expect(hub.bellOf({ seq: 1, channel: "C00000001", ts: "1.2", thread_ts: "1.1", self: "U00000001" }))
      .toEqual({ channel: "C00000001", ts: "1.2", thread_ts: "1.1", self: "U00000001" });
  });
});

describe("hub: replay, then live", () => {
  test("nothing kept: hello, then live at once", () => {
    const s = new FakeSock();
    hub.open(s, 10, hello(10), new FakeStore(), 1000);
    expect(s.msgs()).toEqual([{ type: "hello", seq: 10, gap: false, retention_sec: 3600, epoch: "e" }]);
    expect(s.att).toEqual({ sent: 10, acked: 10, replaying: false, waitSince: 0, lastSeen: 1000 });
    hub.deliver([s], 11, { channel: "C00000001", ts: "11.000001" }, 2000);
    expect(s.seqs()).toEqual([11]);
    expect(s.att).toMatchObject({ sent: 11, acked: 10, waitSince: 2000 });
  });

  test("a backlog goes one batch per ack; a bell rung mid-replay comes from storage, never twice, never lost", () => {
    const st = new FakeStore();
    for (let i = 1; i <= 250; i++) st.add(i);
    const s = new FakeSock();
    hub.open(s, 0, hello(0), st, 5);
    expect(s.seqs()).toEqual(Array.from({ length: hub.REPLAY_BATCH }, (_, i) => i + 1));
    expect(s.att).toMatchObject({ sent: 100, acked: 0, replaying: true, waitSince: 5 });
    // A live bell while replaying: skipped live, stored.
    st.add(251);
    hub.deliver([s], 251, { channel: "C00000001", ts: "251.000001" }, 10);
    expect(s.seqs().length).toBe(100);
    // A partial ack does not release the next batch.
    hub.message(s, ack(50), st, 20);
    expect(s.seqs().length).toBe(100);
    hub.message(s, ack(100), st, 30);
    expect(s.seqs().at(-1)).toBe(200);
    hub.message(s, ack(200), st, 40);
    expect(s.seqs().at(-1)).toBe(251);
    expect(s.att!.replaying).toBe(true); // not live until a read comes back empty
    hub.message(s, ack(251), st, 50);
    expect(s.att).toMatchObject({ replaying: false, sent: 251, acked: 251, waitSince: 0 });
    hub.deliver([s], 252, { channel: "C00000001", ts: "252.000001" }, 60);
    const seqs = s.seqs();
    expect(seqs).toEqual(Array.from({ length: 252 }, (_, i) => i + 1));
  });

  test("acks are clamped to what was sent; junk, binary and oversized messages only count as a sign of life", () => {
    const st = new FakeStore();
    const s = new FakeSock();
    hub.open(s, 5, hello(5), st, 0);
    hub.deliver([s], 6, { channel: "C00000001", ts: "6.000001" }, 1);
    hub.message(s, ack(999), st, 2);
    expect(s.att).toMatchObject({ acked: 6, waitSince: 0, lastSeen: 2 });
    hub.deliver([s], 7, { channel: "C00000001", ts: "7.000001" }, 3);
    for (const m of ["nope", "{}", ack("7"), ack(1.5), JSON.stringify({ type: "ack", seq: 7, pad: "x".repeat(300) })]) hub.message(s, m, st, 4);
    hub.message(s, new ArrayBuffer(4), st, 5);
    expect(s.att).toMatchObject({ acked: 6, sent: 7, waitSince: 3, lastSeen: 5 });
    expect(s.closed).toBeUndefined();
  });

  test("a bell at or below what a client was already sent is not sent again", () => {
    const s = new FakeSock();
    hub.open(s, 10, hello(10), new FakeStore(), 0);
    hub.deliver([s], 9, { channel: "C00000001", ts: "9.000001" }, 1);
    expect(s.seqs()).toEqual([]);
  });
});

describe("hub: flow control and liveness", () => {
  test("a client past MAX_PENDING unacked live bells is cut off (it resumes from storage)", () => {
    const s = new FakeSock();
    hub.open(s, 0, hello(0), new FakeStore(), 0);
    for (let i = 1; i <= hub.MAX_PENDING; i++) hub.deliver([s], i, { channel: "C00000001", ts: `${i}.000001` }, 1);
    expect(s.closed).toBeUndefined();
    hub.deliver([s], hub.MAX_PENDING + 1, { channel: "C00000001", ts: "1.000001" }, 1);
    expect(s.closed).toEqual([hub.CLOSE_OVERFLOW, "overflow"]);
    expect(s.seqs().length).toBe(hub.MAX_PENDING);
  });

  test("acks keep a busy client under the limit, and acks that lag but progress are no stall", () => {
    const st = new FakeStore();
    const s = new FakeSock();
    hub.open(s, 0, hello(0), st, 1);
    // A bell every second for 10 minutes; the client acks every 10th, one behind.
    for (let i = 1; i <= 600; i++) {
      hub.deliver([s], i, { channel: "C00000001", ts: `${i}.000001` }, i * 1000);
      if (i % 10 === 0) hub.message(s, ack(i - 1), st, i * 1000);
    }
    expect(s.closed).toBeUndefined();
    expect(s.att).toMatchObject({ sent: 600, acked: 599, waitSince: 600_000 });
  });

  test("an unacked send older than STALL_MS (a stalled replay, too) frees the slot", () => {
    const st = new FakeStore();
    st.add(1);
    const s = new FakeSock();
    hub.open(s, 0, hello(0), st, 1000);
    expect(s.att!.waitSince).toBe(1000);
    expect(hub.sweep([s], 1000 + hub.STALL_MS)).toEqual([s]);
    expect(hub.sweep([s], 1001 + hub.STALL_MS)).toEqual([]);
    expect(s.closed).toEqual([hub.CLOSE_STALLED, "stalled"]);
  });

  test("a client that neither pings nor acks for DEAD_MS is closed; pings keep it", () => {
    const a = new FakeSock();
    const b = new FakeSock();
    hub.open(a, 0, hello(0), new FakeStore(), 0);
    hub.open(b, 0, hello(0), new FakeStore(), 0);
    b.ping = hub.DEAD_MS;
    expect(hub.sweep([a, b], hub.DEAD_MS + 1)).toEqual([b]);
    expect(a.closed).toEqual([hub.CLOSE_GONE, "silent"]);
    // deliver sweeps too
    hub.deliver([b], 1, { channel: "C00000001", ts: "1.000001" }, 2 * hub.DEAD_MS + 1);
    expect(b.closed).toEqual([hub.CLOSE_GONE, "silent"]);
  });

  test("a socket without a session, or one whose send throws, is closed", () => {
    const s = new FakeSock();
    hub.message(s, ack(1), new FakeStore(), 0);
    expect(s.closed).toEqual([1011, "no session"]);
    const t = new FakeSock();
    expect(hub.sweep([t], 0)).toEqual([]);
    expect(t.closed).toEqual([1011, "no session"]);

    const u = new FakeSock();
    u.broken = true;
    hub.open(u, 0, hello(0), new FakeStore(), 0);
    expect(u.closed).toEqual([1011, "send failed"]);
    const st = new FakeStore();
    st.add(1);
    const v = new FakeSock();
    hub.open(v, 0, hello(0), new FakeStore(), 0);
    v.broken = true;
    hub.deliver([v], 1, { channel: "C00000001", ts: "1.000001" }, 1);
    expect(v.closed).toEqual([1011, "send failed"]);
    const w = new FakeSock();
    hub.open(w, 0, hello(0), new FakeStore(), 0);
    w.broken = true;
    w.att!.replaying = true;
    hub.message(w, ack(0), st, 1); // the replay step's send fails
    expect(w.closed).toEqual([1011, "send failed"]);
  });
});
