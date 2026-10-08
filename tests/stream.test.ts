import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "./harness.ts";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _internals, acquireLock, humanLine, loadState, matchText, permalink, phiDelay, runStream, webClient,
  type ChannelRef, type Page, type StreamClient, type StreamOpts, type StreamMatch, type StreamState,
} from "../ts/stream.ts";
import { RelayAuthError, type Doorbell, type RelayHandlers, type Subscribe } from "../ts/relay.ts";
import { RateLimitError, type Json } from "../ts/slack.ts";
import { startMock, type MockHandle } from "./mock.ts";

type Msg = Record<string, Json>;

const SELF = "U00000099"; // the streaming identity (a bot user)
const SELF_BOT = "B00000099";
const T0 = 1_700_000_000; // fake "now" at the start of each test, in seconds

/** An in-memory workspace: history() returns top-level posts and broadcasts
 *  with thread metadata computed from the replies, paged 2 at a time so every
 *  test also walks pagination. */
class FakeSlack implements StreamClient {
  channels: ChannelRef[] = [{ id: "C00000001", name: "dev", isIm: false }];
  msgs = new Map<string, Msg[]>();
  calls: string[] = [];
  failNext: unknown[] = [];
  failChannel = new Map<string, unknown>();

  post(channel: string, m: Msg): void {
    const list = this.msgs.get(channel) ?? [];
    list.push(m);
    this.msgs.set(channel, list);
  }
  private maybeFail(channel?: string): void {
    if (channel && this.failChannel.has(channel)) throw this.failChannel.get(channel);
    const e = this.failNext.shift();
    if (e !== undefined) throw e;
  }
  async listChannels(): Promise<ChannelRef[]> {
    this.calls.push("list");
    this.maybeFail();
    return this.channels;
  }
  async history(channel: string, oldest: string, cursor?: string): Promise<Page> {
    this.calls.push(`history ${channel}`);
    this.maybeFail(channel);
    const all = this.msgs.get(channel) ?? [];
    const top = all
      .filter((m) => Number(m.ts) > Number(oldest))
      .filter((m) => !m.thread_ts || m.thread_ts === m.ts || m.subtype === "thread_broadcast")
      .map((m) => {
        const reps = all.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts);
        return reps.length && m.thread_ts !== undefined && m.thread_ts === m.ts
          ? { ...m, reply_count: reps.length, latest_reply: reps[reps.length - 1]!.ts! }
          : m;
      })
      .sort((a, b) => Number(b.ts) - Number(a.ts)); // newest first, like Slack
    const start = cursor ? Number(cursor) : 0;
    const slice = top.slice(start, start + 2);
    return start + 2 < top.length ? { messages: slice, nextCursor: String(start + 2) } : { messages: slice };
  }
  async replies(channel: string, threadTs: string, oldest: string, cursor?: string): Promise<Page> {
    this.calls.push(`replies ${channel} ${threadTs}`);
    this.maybeFail(channel);
    const all = this.msgs.get(channel) ?? [];
    const parent = all.find((m) => m.ts === threadTs)!;
    const reps = all.filter((r) => r.thread_ts === threadTs && r.ts !== threadTs && Number(r.ts) > Number(oldest));
    const start = cursor ? Number(cursor) : 0;
    const slice = [parent, ...reps.slice(start, start + 2)];
    return start + 2 < reps.length ? { messages: slice, nextCursor: String(start + 2) } : { messages: slice };
  }
  async userName(id: string): Promise<string> {
    this.calls.push(`user ${id}`);
    return ({ U00000001: "alice", U00000002: "bob" } as Record<string, string>)[id] ?? id;
  }
}

let dir: string;
let now: number;
let out: string[];
let err: string[];
let onSleep: ((ms: number) => void) | undefined;
const saved = { ..._internals };

function opts(extra: Partial<StreamOpts> = {}): StreamOpts {
  return {
    grep: /<@U00000099>|@mybot/,
    selfUsers: new Set([SELF]),
    selfBots: new Set([SELF_BOT]),
    json: true,
    once: true,
    intervalMs: 30_000,
    threadWindowSec: 3 * 86400,
    statePath: join(dir, "state.json"),
    teamUrl: "https://acme.slack.com/",
    identity: SELF,
    backoffBaseMs: 1000,
    ...extra,
  };
}
const ts = (offset: number): string => (T0 + offset).toFixed(6);
const emitted = (): StreamMatch[] => out.map((l) => JSON.parse(l) as StreamMatch);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stream-test-"));
  now = T0 * 1000;
  out = [];
  err = [];
  onSleep = undefined;
  _internals.now = () => now;
  _internals.sleep = async (ms: number) => { now += ms; onSleep?.(ms); };
  _internals.out = (l) => { out.push(l); };
  _internals.err = (l) => { err.push(l); };
});
afterEach(() => {
  Object.assign(_internals, saved);
  rmSync(dir, { recursive: true, force: true });
});

describe("runStream — grep", () => {
  test("emits a matching message and never prints a non-matching one", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "hey <@U00000099> &lt;please&gt; look" });
    s.post("C00000001", { ts: ts(-50), user: "U00000002", text: "secret unrelated chatter" });
    const code = await runStream(s, opts({ sinceSec: 120 }));
    expect(code).toBe(0);
    expect(emitted()).toEqual([{
      type: "message",
      channel: { id: "C00000001", name: "#dev" },
      ts: ts(-60),
      thread_ts: null,
      user: { id: "U00000001", name: "alice" },
      text: "hey <@U00000099> <please> look",
      permalink: `https://acme.slack.com/archives/C00000001/p${ts(-60).replace(".", "")}`,
    }]);
    const everything = [...out, ...err].join("\n");
    expect(everything).not.toContain("secret");
    // The non-matching sender's name was never even looked up.
    expect(s.calls).not.toContain("user U00000002");
  });

  test("--once with no match exits 2 and says so on stderr", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "nothing to see" });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("no matches in 1 channel(s)");
  });

  test("matches text inside legacy attachments", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "", attachments: [{ text: "ping @mybot" }] });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    expect(emitted()).toHaveLength(1);
  });

  test("a /g regex matches every message, not every other one", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot one" });
    s.post("C00000001", { ts: ts(-50), user: "U00000001", text: "@mybot two" });
    await runStream(s, opts({ sinceSec: 120, grep: /@mybot/g }));
    expect(emitted()).toHaveLength(2);
  });

  test("human output names channel, sender and permalink", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot line1\nline2" });
    await runStream(s, opts({ sinceSec: 120, json: false }));
    expect(out[0]).toContain("#dev  @alice: @mybot line1\n    line2");
    expect(out[0]).toContain("https://acme.slack.com/archives/C00000001/p");
  });
});

describe("runStream — self-echo exclusion (by sender id, both directions)", () => {
  test("own user-id and own bot-id posts never appear; another person's identical text does", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-90), user: SELF, text: "[cto] ping @mybot" });
    s.post("C00000001", { ts: ts(-80), bot_id: SELF_BOT, username: "mybot", text: "[cto] ping @mybot" });
    s.post("C00000001", { ts: ts(-70), user: "U00000002", text: "[cto] ping @mybot" });
    s.post("C00000001", { ts: ts(-60), bot_id: "B00000005", username: "other-bot", text: "ping @mybot" });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    expect(emitted().map((m) => m.user)).toEqual([
      { id: "U00000002", name: "bob" },
      { id: "B00000005", name: "other-bot" },
    ]);
  });

  test("housekeeping subtypes are skipped", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", subtype: "channel_join", text: "<@U00000001> has joined @mybot" });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(2);
  });
});

describe("runStream — threads", () => {
  test("replies are emitted (also to an old parent inside the window); a broadcast only once", async () => {
    const s = new FakeSlack();
    // Parent from yesterday — before --since, but inside the 3-day window.
    s.post("C00000001", { ts: ts(-86400), user: "U00000001", text: "old topic", thread_ts: ts(-86400) });
    s.post("C00000001", { ts: ts(-86000), user: "U00000002", text: "@mybot stale reply", thread_ts: ts(-86400) });
    s.post("C00000001", { ts: ts(-60), user: "U00000002", text: "@mybot new reply", thread_ts: ts(-86400) });
    s.post("C00000001", { ts: ts(-55), user: SELF, text: "@mybot my own reply", thread_ts: ts(-86400) });
    s.post("C00000001", { ts: ts(-50), user: "U00000001", text: "@mybot broadcast", thread_ts: ts(-86400), subtype: "thread_broadcast" });
    s.post("C00000001", { ts: ts(-40), user: "U00000001", text: "@mybot third", thread_ts: ts(-86400) });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    const got = emitted();
    expect(got.map((m) => m.text)).toEqual(["@mybot broadcast", "@mybot new reply", "@mybot third"]);
    expect(got.every((m) => m.type === "reply" && m.thread_ts === ts(-86400))).toBe(true);
    expect(got[1]!.permalink).toBe(
      `https://acme.slack.com/archives/C00000001/p${ts(-60).replace(".", "")}?thread_ts=${ts(-86400)}&cid=C00000001`,
    );
  });

  test("a thread whose parent left the window is not read", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-5 * 86400), user: "U00000001", text: "ancient", thread_ts: ts(-5 * 86400) });
    s.post("C00000001", { ts: ts(-60), user: "U00000002", text: "@mybot late", thread_ts: ts(-5 * 86400) });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(2);
    expect(s.calls.some((c) => c.startsWith("replies"))).toBe(false);
  });

  test("a group DM is named without a # prefix", async () => {
    const s = new FakeSlack();
    s.channels = [{ id: "G00000001", name: "mpdm-alice--bob-1", isIm: false, isMpim: true }];
    s.post("G00000001", { ts: ts(-60), user: "U00000001", text: "@mybot hi" });
    await runStream(s, opts({ sinceSec: 120 }));
    expect(emitted()[0]!.channel).toEqual({ id: "G00000001", name: "mpdm-alice--bob-1" });
  });

  test("DM channel names resolve to the other person", async () => {
    const s = new FakeSlack();
    s.channels = [{ id: "D00000001", name: "D00000001", isIm: true, user: "U00000001" }];
    s.post("D00000001", { ts: ts(-60), user: "U00000001", text: "@mybot hi" });
    await runStream(s, opts({ sinceSec: 120 }));
    expect(emitted()[0]!.channel).toEqual({ id: "D00000001", name: "@alice" });
  });
});

describe("runStream — cursor", () => {
  test("a restart resumes: nothing lost, nothing repeated", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot first" });
    s.post("C00000001", { ts: ts(-59), user: "U00000001", text: "topic", thread_ts: ts(-59) });
    s.post("C00000001", { ts: ts(-58), user: "U00000001", text: "@mybot r1", thread_ts: ts(-59) });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot first", "@mybot r1"]);

    // Down for 10 minutes; meanwhile a post and a reply arrive.
    now += 600_000;
    s.post("C00000001", { ts: ts(100), user: "U00000002", text: "@mybot while down" });
    s.post("C00000001", { ts: ts(200), user: "U00000002", text: "@mybot r2", thread_ts: ts(-59) });
    out = [];
    expect(await runStream(s, opts())).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot while down", "@mybot r2"]);

    out = [];
    expect(await runStream(s, opts())).toBe(2);
    expect(out).toEqual([]);
  });

  test("first run without --since starts now: history is not replayed", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot before we started" });
    expect(await runStream(s, opts())).toBe(2);
  });

  test("--since replays even when a cursor is saved", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot x" });
    await runStream(s, opts({ sinceSec: 120 }));
    out = [];
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    expect(emitted()).toHaveLength(1);
  });

  test("a message younger than the settle delay waits for the next scan", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-2), user: "U00000001", text: "@mybot just now" });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(2);
    now += 10_000;
    expect(await runStream(s, opts())).toBe(0);
    expect(emitted()).toHaveLength(1);
  });

  test("a state file from another identity, or a corrupt one, is refused (exit 3)", async () => {
    const s = new FakeSlack();
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, identity: "U00000005", channels: {} }));
    expect(await runStream(s, opts())).toBe(3);
    expect(err.join("\n")).toContain("belongs to identity U00000005");
    writeFileSync(join(dir, "state.json"), "{not json");
    expect(await runStream(s, opts())).toBe(3);
    expect(err.join("\n")).toContain("unreadable");
  });

  test("a state file of the wrong shape is refused (exit 3)", async () => {
    const s = new FakeSlack();
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, identity: SELF, channels: { C00000001: { cursor: "1" } } }));
    expect(await runStream(s, opts())).toBe(3);
    expect(err.join("\n")).toContain("not a slack stream state");
  });

  test("threads that slid out of the window are forgotten", async () => {
    const s = new FakeSlack();
    s.post("C00000001", { ts: ts(-59), user: "U00000001", text: "topic", thread_ts: ts(-59) });
    s.post("C00000001", { ts: ts(-58), user: "U00000001", text: "r", thread_ts: ts(-59) });
    await runStream(s, opts({ sinceSec: 120 }));
    const st1 = loadState(join(dir, "state.json"), SELF);
    expect(Object.keys(st1.channels.C00000001!.threads)).toEqual([ts(-59)]);
    now += 4 * 86400_000;
    await runStream(s, opts());
    const st2 = loadState(join(dir, "state.json"), SELF);
    expect(st2.channels.C00000001!.threads).toEqual({});
  });
});

describe("runStream — channels", () => {
  test("--channel restricts the scan; an unknown one is fatal", async () => {
    const s = new FakeSlack();
    s.channels.push({ id: "C00000002", name: "random", isIm: false });
    s.post("C00000002", { ts: ts(-60), user: "U00000001", text: "@mybot elsewhere" });
    expect(await runStream(s, opts({ sinceSec: 120, channels: ["C00000001"] }))).toBe(2);
    expect(s.calls.filter((c) => c.startsWith("history"))).toEqual(["history C00000001"]);
    expect(await runStream(s, opts({ channels: ["C00000003"] }))).toBe(3);
    expect(err.join("\n")).toContain("--channel C00000003");
  });

  test("a channel-scoped error skips that channel loudly; the rest still stream", async () => {
    const s = new FakeSlack();
    s.channels.push({ id: "D00000002", name: "D00000002", isIm: true });
    s.failChannel.set("D00000002", new Error("Slack error on conversations.history: channel_not_found"));
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot ok" });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    expect(err.join("\n")).toContain("skipping D00000002");
  });

  test("when every channel fails, the stream fails (exit 3), not 'no matches'", async () => {
    const s = new FakeSlack();
    s.failChannel.set("C00000001", new Error("Slack error on conversations.history: not_in_channel"));
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(3);
    expect(err.join("\n")).toContain("every channel failed — nothing left to watch (last: Slack error on conversations.history: not_in_channel)");
  });

  test("a channel joined mid-run is scanned from the previous refresh", async () => {
    const s = new FakeSlack();
    const ac = new AbortController();
    let sleeps = 0;
    onSleep = () => {
      sleeps++;
      if (sleeps === 1) {
        s.channels.push({ id: "C00000002", name: "new", isIm: false });
        // Posted between the first refresh and the second.
        s.post("C00000002", { ts: ts(20), user: "U00000001", text: "@mybot welcome" });
      }
      if (sleeps === 3) ac.abort();
    };
    const code = await runStream(s, opts({ once: false, refreshEvery: 2, signal: ac.signal }));
    expect(code).toBe(0);
    expect(emitted().map((m) => m.channel.name)).toEqual(["#new"]);
  });

  test("with --since, a channel discovered mid-run is replayed from the --since point too", async () => {
    const s = new FakeSlack();
    const ac = new AbortController();
    let sleeps = 0;
    onSleep = () => {
      sleeps++;
      if (sleeps === 1) {
        s.channels.push({ id: "C00000002", name: "new", isIm: false });
        s.post("C00000002", { ts: ts(-100), user: "U00000001", text: "@mybot from before the run" });
      }
      if (sleeps === 2) ac.abort();
    };
    await runStream(s, opts({ once: false, refreshEvery: 1, sinceSec: 300, signal: ac.signal }));
    expect(emitted().map((m) => m.text)).toEqual(["@mybot from before the run"]);
  });
});

describe("runStream — failures", () => {
  test("transient errors reconnect with φ backoff, one stderr line each, then recover", async () => {
    const s = new FakeSlack();
    s.failNext = [new Error("fetch failed"), new Error("fetch failed")];
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot x" });
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    const lines = err.filter((l) => l.includes("reconnecting"));
    expect(lines).toEqual([
      "slack stream: fetch failed — reconnecting in 1.0s (attempt 1/3)",
      "slack stream: fetch failed — reconnecting in 1.6s (attempt 2/3)",
    ]);
    expect(err.join("\n")).toContain("recovered after 2 failed attempt(s)");
  });

  test("gives up after maxFailures consecutive failures (exit 3)", async () => {
    const s = new FakeSlack();
    s.failNext = [new Error("fetch failed"), new Error("fetch failed"), new Error("fetch failed")];
    expect(await runStream(s, opts())).toBe(3);
    expect(err.at(-1)).toContain("giving up after 3 consecutive failures");
  });

  test("auth errors are fatal at once (exit 3), no retry", async () => {
    const s = new FakeSlack();
    s.failNext = [new Error("Slack error on users.conversations: token_revoked")];
    expect(await runStream(s, opts())).toBe(3);
    expect(err).toEqual(["slack stream: fatal: Slack error on users.conversations: token_revoked"]);
  });

  test("a transient error inside a channel scan is retried with backoff", async () => {
    const s = new FakeSlack();
    s.failChannel.set("C00000001", new Error("fetch failed"));
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot x" });
    onSleep = () => s.failChannel.delete("C00000001");
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    expect(err[0]).toContain("fetch failed — reconnecting in 1.0s (attempt 1/3)");
    expect(emitted()).toHaveLength(1);
  });

  test("a rate limit waits Retry-After and retries the same channel", async () => {
    const s = new FakeSlack();
    s.failChannel.set("C00000001", new RateLimitError(7));
    s.post("C00000001", { ts: ts(-60), user: "U00000001", text: "@mybot x" });
    onSleep = () => s.failChannel.delete("C00000001");
    expect(await runStream(s, opts({ sinceSec: 120 }))).toBe(0);
    expect(err).toContain("slack stream: rate limited — waiting 7s");
  });

  test("a long-running stream stops cleanly on abort (exit 0) and releases its lock", async () => {
    const s = new FakeSlack();
    const ac = new AbortController();
    onSleep = () => ac.abort();
    expect(await runStream(s, opts({ once: false, signal: ac.signal }))).toBe(0);
    expect(existsSync(join(dir, "state.json.lock"))).toBe(false);
  });
});

describe("lock", () => {
  test("a second stream on the same state is refused; a stale lock is reclaimed", async () => {
    const path = join(dir, "s.json");
    writeFileSync(`${path}.lock`, "4242");
    _internals.pidAlive = () => true;
    expect(() => acquireLock(path)).toThrow("pid 4242");
    _internals.pidAlive = () => false;
    const release = acquireLock(path);
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(`${path}.lock`)).toBe(false);
    release(); // idempotent
  });

  test("release leaves a lock that another stream has taken over", () => {
    const path = join(dir, "s.json");
    const release = acquireLock(path);
    writeFileSync(`${path}.lock`, "4242"); // reclaimed by someone else
    release();
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("4242");
  });

  test("the real pidAlive sees this process", () => {
    expect(saved.pidAlive(process.pid)).toBe(true);
    expect(saved.pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe("helpers", () => {
  test("phiDelay grows by φ and is capped", () => {
    expect(phiDelay(1, 2000, 300_000)).toBe(2000);
    expect(phiDelay(2, 2000, 300_000)).toBe(3236);
    expect(phiDelay(3, 2000, 300_000)).toBe(5236);
    expect(phiDelay(20, 2000, 300_000)).toBe(300_000);
  });
  test("permalink with and without a thread; teamUrl without trailing slash", () => {
    expect(permalink("https://acme.slack.com", "C00000001", "1.000002")).toBe("https://acme.slack.com/archives/C00000001/p1000002");
    expect(permalink("https://acme.slack.com/", "C00000001", "1.000002", "1.000002")).toBe("https://acme.slack.com/archives/C00000001/p1000002");
  });
  test("matchText joins text and attachment fields", () => {
    expect(matchText({ text: "a", attachments: [{ pretext: "b", fallback: "c" }, "junk", null] as Json })).toBe("a\nb\nc");
  });
  test("humanLine marks replies", () => {
    expect(humanLine({
      type: "reply", channel: { id: "C1", name: "#dev" }, ts: "1700000000.000100", thread_ts: "1", user: { id: "U1", name: "a" }, text: "t", permalink: "p",
    })).toBe("2023-11-14T22:13:20Z  #dev  ↳ @a: t\n    p");
  });
  test("the real now/out/err seams", () => {
    expect(Math.abs(saved.now() - Date.now())).toBeLessThan(1000);
    const writes: string[] = [];
    const o = process.stdout.write, e = process.stderr.write;
    process.stdout.write = ((c: string) => { writes.push(`o:${c}`); return true; }) as typeof o;
    process.stderr.write = ((c: string) => { writes.push(`e:${c}`); return true; }) as typeof e;
    try { saved.out("x"); saved.err("y"); } finally { process.stdout.write = o; process.stderr.write = e; }
    expect(writes).toEqual(["o:x\n", "e:y\n"]);
  });
  test("the real sleep resolves, and returns at once when aborted", async () => {
    await saved.sleep(1);
    const ac = new AbortController();
    ac.abort();
    await saved.sleep(60_000, ac.signal);
    const ac2 = new AbortController();
    const p = saved.sleep(60_000, ac2.signal);
    ac2.abort();
    await p;
  });
});

describe("webClient (against the mock Slack API)", () => {
  let mock: MockHandle;
  beforeAll(async () => {
    mock = await startMock({
      inline: {
        "users.conversations__exclude_archived=true&limit=200&types=public_channel_private_channel_im_mpim": {
          ok: true,
          channels: [
            { id: "C00000001", name: "dev" },
            { id: "D00000001", is_im: true, user: "U00000001" },
            { id: "G00000001", name: "mpdm-alice--bob-1", is_mpim: true },
            { name: "no-id" },
          ],
          response_metadata: { next_cursor: "" },
        },
        "conversations.history__channel=C00000001&limit=200&oldest=1.000000": {
          ok: true, has_more: true, messages: [{ ts: "2.000000", text: "a" }, "junk"],
          response_metadata: { next_cursor: "n1" },
        },
        "conversations.history__channel=C00000001&cursor=n1&limit=200&oldest=1.000000": {
          ok: true, has_more: false, messages: [{ ts: "3.000000", text: "b" }],
        },
        "conversations.replies__channel=C00000001&limit=200&oldest=1.000000&ts=2.000000": {
          ok: true, messages: [{ ts: "2.000000" }, { ts: "2.500000", thread_ts: "2.000000" }],
        },
        "conversations.replies__channel=C00000001&cursor=c2&limit=200&oldest=1.000000&ts=2.000000": {
          ok: true, messages: [{ ts: "2.000000" }],
        },
        "users.info__user=U00000001": { ok: true, user: { id: "U00000001", name: "alice", profile: { display_name: "Alice" } } },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });
  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("lists, pages history and replies, names users", async () => {
    const c = webClient("xoxb-fake");
    expect(await c.listChannels()).toEqual([
      { id: "C00000001", name: "dev", isIm: false },
      { id: "D00000001", name: "D00000001", isIm: true, user: "U00000001" },
      { id: "G00000001", name: "mpdm-alice--bob-1", isIm: false, isMpim: true },
    ]);
    const p1 = await c.history("C00000001", "1.000000");
    expect(p1).toEqual({ messages: [{ ts: "2.000000", text: "a" }], nextCursor: "n1" });
    expect(await c.history("C00000001", "1.000000", "n1")).toEqual({ messages: [{ ts: "3.000000", text: "b" }] });
    expect((await c.replies("C00000001", "2.000000", "1.000000")).messages).toHaveLength(2);
    expect((await c.replies("C00000001", "2.000000", "1.000000", "c2")).messages).toHaveLength(1);
    expect(await c.userName("U00000001")).toBe("Alice");
  });
});

// ---------------------------------------------------------------------------
// Relay: doorbells from the Cloudflare Worker (worker/).

/** A relay the test drives: connect() records the resume point and says
 *  hello; ring() delivers a bell; the subscription lives until aborted. */
class FakeRelay {
  afters: (number | undefined)[] = [];
  on: RelayHandlers | undefined;
  /** Reject the next connections with these errors. */
  fail: unknown[] = [];
  gap = false;
  latest = 0;
  epoch = "e1";
  subscribe: Subscribe = (after, signal, on) => {
    this.afters.push(after?.seq);
    const e = this.fail.shift();
    if (e !== undefined) return Promise.reject(e);
    this.on = on;
    // Like the Worker: a resume seq past the end means storage was reset —
    // report a gap and replay everything kept.
    const reset = after !== undefined && (after.seq > this.latest || (after.epoch !== undefined && after.epoch !== this.epoch));
    // A retention gap still replays whatever survives after the cursor.
    const from = reset ? 0 : (after?.seq ?? this.latest);
    on.hello({ seq: from, gap: this.gap || reset, retention_sec: 3600, epoch: this.epoch });
    // Like the Worker: replay what is kept after the resume point.
    for (const [seq, bell] of this.log) if (seq > from) on.bell(seq, bell);
    return new Promise((res) => {
      this.end = res;
      signal.addEventListener("abort", () => res(), { once: true });
    });
  };
  /** The server closes the stream. */
  end: () => void = () => {};
  log: [number, Doorbell][] = [];
  ring(seq: number, bell: Doorbell): void {
    this.latest = seq;
    this.log.push([seq, bell]);
    this.on!.bell(seq, bell);
  }
}

describe("runStream — relay", () => {
  /** Sleeps advance the clock by 1 s (not the full interval), so a bell can be
   *  handled long before the next poll is due. `step(n)` runs at the n-th sleep. */
  function stepper(steps: Record<number, () => void>, stop: AbortController, cap = 200): number[] {
    const sleeps: number[] = [];
    _internals.sleep = async (ms: number) => {
      sleeps.push(ms);
      now += Math.min(ms, 1000);
      steps[sleeps.length]?.();
      if (sleeps.length > cap) stop.abort();
    };
    return sleeps;
  }
  const relayOpts = (r: FakeRelay, ac: AbortController, extra: Partial<StreamOpts> = {}): StreamOpts =>
    opts({ once: false, signal: ac.signal, relay: { url: "https://relay.example", subscribe: r.subscribe, reconcileMs: 300_000 }, ...extra });
  const historyCalls = (s: FakeSlack): number => s.calls.filter((c) => c.startsWith("history")).length;

  test("a bell emits the message at once; the next poll does not repeat it", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    let pollsAtBell = 0;
    const sleeps = stepper({
      1: () => {
        s.post("C00000001", { ts: (now / 1000 - 0.5).toFixed(6), user: "U00000001", text: "hi @mybot" });
        pollsAtBell = historyCalls(s);
        r.ring(1, { channel: "C00000001", ts: (now / 1000 - 0.5).toFixed(6) });
      },
      2: () => { now += 300_000; }, // jump to the safety-net poll
      4: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]!.text).toBe("hi @mybot");
    // Relay up: the poll waits reconcileMs, not --interval.
    expect(sleeps[0]).toBe(300_000);
    // The bell cost exactly one read; the safety-net poll then ran and stayed quiet.
    expect(historyCalls(s)).toBeGreaterThan(pollsAtBell);
    expect(s.calls.filter((c) => c.startsWith("replies"))).toEqual([`replies C00000001 ${emitted()[0]!.ts}`]);
    expect(err.some((l) => l.includes("relay connected — polling every 300s"))).toBe(true);
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay).toEqual({ url: "https://relay.example", seq: 1, epoch: "e1" });
  });

  test("a reply bell reads the thread, even one whose parent is outside the window", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const parent = ts(-10 * 86400);
    s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
    stepper({
      1: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, thread_ts: parent, user: "U00000001", text: "<@U00000099> ping" });
        r.ring(1, { channel: "C00000001", ts: t, thread_ts: parent });
      },
      3: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => [m.type, m.thread_ts])).toEqual([["reply", parent]]);
  });

  test("bells for other channels, own posts and non-matches print nothing", async () => {
    const s = new FakeSlack();
    s.channels.push({ id: "C00000002", name: "random", isIm: false });
    const r = new FakeRelay();
    const ac = new AbortController();
    stepper({
      1: () => {
        const t = (n: number): string => (now / 1000 - n).toFixed(6);
        s.post("C00000002", { ts: t(1), user: "U00000001", text: "@mybot elsewhere" });
        s.post("C00000001", { ts: t(2), user: SELF, text: "@mybot self" });
        s.post("C00000001", { ts: t(3), user: "U00000001", text: "nothing" });
        r.ring(1, { channel: "C00000002", ts: t(1) });
        r.ring(2, { channel: "C00000001", ts: t(2) });
        r.ring(3, { channel: "C00000001", ts: t(3) });
      },
      3: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac, { channels: ["C00000001"] }))).toBe(0);
    expect(out).toEqual([]);
  });

  test("a bell for a message not visible yet is retried once, then left to the poll", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    let t = "";
    const sleeps = stepper({
      1: () => {
        t = (now / 1000).toFixed(6);
        r.ring(1, { channel: "C00000001", ts: t });
      },
      2: () => s.post("C00000001", { ts: t, user: "U00000001", text: "late @mybot" }), // during the 1.5 s retry wait
      4: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(sleeps[1]).toBe(1500);
    expect(emitted()).toHaveLength(1);
  });

  test("a bell from an unknown channel re-lists channels and polls", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    stepper({
      1: () => {
        now += 60_000; // re-listing is throttled to once a minute
        s.channels.push({ id: "C00000003", name: "new", isIm: false });
        const t = (now / 1000 - 10).toFixed(6);
        s.post("C00000003", { ts: t, user: "U00000001", text: "@mybot welcome" });
        r.ring(1, { channel: "C00000003", ts: t });
      },
      3: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(s.calls.filter((c) => c === "list")).toHaveLength(2);
    expect(emitted().map((m) => m.channel.id)).toEqual(["C00000003"]);
  });

  test("relay down: --interval polling, one stderr line, then it reconnects", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    r.fail.push(new Error("relay: HTTP 502"));
    const ac = new AbortController();
    const sleeps = stepper({ 6: () => ac.abort() }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(err.filter((l) => l.includes("relay unavailable (relay: HTTP 502) — polling every 30s"))).toHaveLength(1);
    expect(sleeps).toContain(2000); // the relay's own reconnect backoff
    expect(err.some((l) => l.includes("relay connected"))).toBe(true);
    expect(r.afters).toEqual([0, 0]); // never connected: still everything the relay keeps
  });

  test("a restart resumes the relay from the saved seq; a gap there forces a catch-up poll", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    let ac = new AbortController();
    stepper({
      1: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot one" });
        r.ring(7, { channel: "C00000001", ts: t });
      },
      3: () => ac.abort(),
    }, ac);
    await runStream(s, relayOpts(r, ac));
    expect(emitted()).toHaveLength(1);

    ac = new AbortController();
    r.gap = true;
    r.latest = 9;
    const before = historyCalls(s);
    stepper({ 2: () => ac.abort() }, ac);
    await runStream(s, relayOpts(r, ac));
    expect(r.afters.at(-1)).toBe(7);
    // The startup poll is the catch-up for bells lost in the gap.
    expect(historyCalls(s)).toBeGreaterThan(before);
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay?.seq).toBe(7); // nothing after 7 survived the gap
    expect(emitted()).toHaveLength(1);
  });

  test("a dropped stream reconnects from the last seq; a gap there forces a catch-up poll", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    let polls = 0;
    stepper({
      1: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot one" });
        r.ring(3, { channel: "C00000001", ts: t });
      },
      2: () => {
        r.gap = true;
        r.latest = 8;
        polls = historyCalls(s);
        r.end();
      },
      6: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(r.afters).toEqual([0, 3]);
    expect(historyCalls(s)).toBeGreaterThan(polls); // caught up long before reconcileMs
    expect(err.filter((l) => l.includes("relay unavailable (stream closed)"))).toHaveLength(1);
  });

  test("a rejected token disables the relay for the run; polling carries on", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    r.fail.push(new RelayAuthError("relay rejected the token (401)"));
    const ac = new AbortController();
    const sleeps = stepper({ 3: () => ac.abort() }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(r.afters).toHaveLength(1);
    expect(sleeps[0]).toBe(30_000);
    expect(err.some((l) => l.includes("relay disabled for this run"))).toBe(true);
  });

  test("a rate-limited bell waits Retry-After; a failing one is retried until it works", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    stepper({
      1: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot rl" });
        s.failNext.push(new RateLimitError(3));
        r.ring(1, { channel: "C00000001", ts: t });
      },
      2: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot flaky" });
        s.failNext.push(new Error("socket hang up"));
        r.ring(2, { channel: "C00000001", ts: t });
      },
      20: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => m.text).sort()).toEqual(["@mybot flaky", "@mybot rl"]);
    expect(err).toContain("slack stream: rate limited — waiting 3s");
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay?.seq).toBe(2);
  });

  test("an unreadable bell holds the resume point back while it is retried, then is abandoned loudly", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const seqs: number[] = [];
    const parent = ts(-10 * 86400); // outside the window: the poll could never find this reply
    stepper({
      1: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot ok" });
        r.ring(1, { channel: "C00000001", ts: (now / 1000 - 0.5).toFixed(6), thread_ts: parent }); // never visible
        r.ring(2, { channel: "C00000001", ts: t });
      },
      2: () => seqs.push((JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState).relay!.seq),
      150: () => ac.abort(),
    }, ac);
    s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
    s.post("C00000001", { ts: ts(-10 * 86400 + 1), thread_ts: parent, user: "U00000002", text: "x" });
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot ok"]);
    expect(seqs).toEqual([0]); // bell 2 is done, but bell 1 is still pending
    expect(err.filter((l) => l.includes("relay bell for C00000001 abandoned after 8 tries (not visible yet)"))).toHaveLength(1);
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay?.seq).toBe(2);
  });

  test("a burst of bells is handled in slices of 25 and the poll still runs on time", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const order: string[] = [];
    // Bells are read with conversations.replies, polls with .history.
    const realHistory = s.history.bind(s);
    const realReplies = s.replies.bind(s);
    s.history = async (c, oldest, cursor) => { order.push("poll"); return realHistory(c, oldest, cursor); };
    s.replies = async (c, t, oldest, cursor) => { order.push("bell"); return realReplies(c, t, oldest, cursor); };
    stepper({
      1: () => {
        now += 300_000; // the safety-net poll is due as the burst arrives
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot burst" });
        for (let i = 1; i <= 60; i++) r.ring(i, { channel: "C00000001", ts: t });
      },
      3: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted()).toHaveLength(1);
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay?.seq).toBe(60);
    // The due poll runs after the first slice of 25, not after all 60.
    const firstPollAfterBells = order.indexOf("poll", order.indexOf("bell"));
    expect(firstPollAfterBells).toBeGreaterThan(0);
    expect(order.slice(0, firstPollAfterBells).filter((o) => o === "bell").length).toBeLessThanOrEqual(25);
  });

  test("an overflowing backlog pauses the relay; it resumes from storage once drained", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const parent = ts(-10 * 86400); // replies under an old parent: only bells can find them
    s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
    stepper({
      1: () => {
        for (let i = 1; i <= 2005; i++) {
          const t = (T0 + i / 10000).toFixed(6);
          if (i === 1 || i === 2003) s.post("C00000001", { ts: t, thread_ts: parent, user: "U00000001", text: `@mybot ${i}` });
          r.ring(i, { channel: "C00000001", ts: t, thread_ts: parent });
        }
      },
      4000: () => ac.abort(),
    }, ac, 5000);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(err.filter((l) => l.includes("relay backlog over 2000 — pausing the relay until it drains"))).toHaveLength(1);
    expect(r.afters).toEqual([0, 2000]); // came back for the 5 it did not take
    expect(emitted().map((m) => m.text)).toEqual(["@mybot 1", "@mybot 2003"]);
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay?.seq).toBe(2005);
  });

  test("a backlog dropped while a bell is being read loses neither that bell nor the next one", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const t1 = (T0 + 0.5).toFixed(6);
    const t2 = (T0 + 0.7).toFixed(6);
    let flooded = false;
    const realReplies = s.replies.bind(s);
    s.replies = async (c, threadTs, oldest, cursor) => {
      if (oldest === (T0 + 0.5 - 1).toFixed(6) && !flooded) {
        flooded = true; // while bell 1 is in flight: 2000 more overflow the queue, then one more
        for (let i = 2; i <= 2001; i++) r.ring(i, { channel: "C00000001", ts: t1 });
        // A reply under an old parent: only its bell can find it.
        const parent = ts(-10 * 86400);
        s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
        s.post("C00000001", { ts: t2, thread_ts: parent, user: "U00000002", text: "@mybot after" });
        r.ring(2002, { channel: "C00000001", ts: t2, thread_ts: parent });
      }
      return realReplies(c, threadTs, oldest, cursor);
    };
    stepper({
      1: () => {
        s.post("C00000001", { ts: t1, user: "U00000001", text: "@mybot first" });
        r.ring(1, { channel: "C00000001", ts: t1 });
      },
      4000: () => ac.abort(),
    }, ac, 5000);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot first", "@mybot after"]);
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay?.seq).toBe(2002);
  });

  test("Retry-After from a bell read pauses bells and polls alike, then both resume", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const calls: [string, number][] = [];
    let limited = true;
    let t = "";
    const realHistory = s.history.bind(s);
    const realReplies = s.replies.bind(s);
    s.history = async (c, oldest, cursor) => {
      calls.push([oldest, now]);
      return realHistory(c, oldest, cursor);
    };
    s.replies = async (c, threadTs, oldest, cursor) => {
      calls.push([oldest, now]);
      if (limited && oldest === (Number(t) - 1).toFixed(6)) {
        limited = false;
        throw new RateLimitError(60);
      }
      return realReplies(c, threadTs, oldest, cursor);
    };
    let limitedAt = 0;
    stepper({
      1: () => {
        now += 300_000; // a safety-net poll is due, too
        t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, thread_ts: ts(-10 * 86400), user: "U00000001", text: "@mybot later" });
        s.post("C00000001", { ts: ts(-10 * 86400), thread_ts: ts(-10 * 86400), user: "U00000002", text: "old" });
        r.ring(1, { channel: "C00000001", ts: t });
        r.ring(2, { channel: "C00000001", ts: t });
      },
      2: () => { limitedAt = calls.length; },
      100: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(err).toContain("slack stream: rate limited — waiting 60s");
    // Nothing touched the API inside the 60 s after the 429.
    const hit = calls.findIndex(([o]) => o === (Number(t) - 1).toFixed(6));
    const after429 = calls.slice(hit + 1);
    expect(after429.length).toBeGreaterThan(0);
    expect(after429.every(([, at]) => at >= calls[hit]![1] + 60_000)).toBe(true);
    expect(limitedAt).toBeGreaterThan(0);
  });

  test("a bell from a channel joined seconds after a re-list waits for the next one", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    let t = "";
    stepper({
      1: () => {
        s.channels.push({ id: "C00000003", name: "new", isIm: false });
        t = (now / 1000).toFixed(6);
        const parent = ts(-10 * 86400); // a reply only the bell can find
        s.post("C00000003", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
        s.post("C00000003", { ts: t, thread_ts: parent, user: "U00000001", text: "@mybot in new" });
        r.ring(1, { channel: "C00000003", ts: t, thread_ts: parent });
      },
      120: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot in new"]);
  });

  test("an abort during a scan stops at once, not after another full interval", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const realHistory = s.history.bind(s);
    s.history = async (c, oldest, cursor) => {
      ac.abort();
      return realHistory(c, oldest, cursor);
    };
    const sleeps = stepper({}, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(sleeps).toEqual([]);
  });

  test("a relay whose storage was reset replays what it kept, in its new numbering", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const parent = ts(-10 * 86400); // replies only a bell can find
    s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
    stepper({
      1: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot before reset" });
        r.ring(100, { channel: "C00000001", ts: t });
      },
      2: () => {
        // The relay lost its storage and counts again from 1; while we were
        // away it stored two bells.
        r.end();
        r.on = { hello: () => {}, bell: () => {} };
        r.latest = 0;
        r.log = [];
        for (const i of [1, 2]) {
          const t = (now / 1000 + i / 10).toFixed(6);
          s.post("C00000001", { ts: t, thread_ts: parent, user: "U00000001", text: `@mybot after reset ${i}` });
          r.ring(i, { channel: "C00000001", ts: t, thread_ts: parent });
        }
      },
      10: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(r.afters).toEqual([0, 100]);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot before reset", "@mybot after reset 1", "@mybot after reset 2"]);
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay?.seq).toBe(2);
  });

  test("a relay reset is caught by its epoch even after its numbers pass ours", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const parent = ts(-10 * 86400);
    s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
    stepper({
      1: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot first" });
        r.ring(5, { channel: "C00000001", ts: t });
      },
      2: () => {
        r.end();
        r.on = { hello: () => {}, bell: () => {} };
        r.epoch = "e2"; // new storage, which has already counted past 5
        r.log = [];
        for (let i = 1; i <= 8; i++) {
          const t = (now / 1000 + i / 10).toFixed(6);
          s.post("C00000001", { ts: t, thread_ts: parent, user: "U00000001", text: i === 3 ? "@mybot seq 3 of e2" : "chat" });
          r.ring(i, { channel: "C00000001", ts: t, thread_ts: parent });
        }
      },
      10: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot first", "@mybot seq 3 of e2"]);
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StreamState;
    expect(st.relay).toMatchObject({ seq: 8, epoch: "e2" });
  });

  test("--since replays the relay's kept bells inside the window, consumed or not, with or without state", async () => {
    for (const saved of [true, false]) {
      rmSync(join(dir, "state.json"), { force: true });
      out = [];
      const s = new FakeSlack();
      const r = new FakeRelay();
      const parent = ts(-10 * 86400); // only a bell can find these replies
      s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
      for (const [i, ago] of [[1, 1800], [2, 120]] as const) {
        s.post("C00000001", { ts: ts(-ago), thread_ts: parent, user: "U00000001", text: `@mybot ${ago}s ago` });
        r.log.push([i, { channel: "C00000001", ts: ts(-ago), thread_ts: parent }]);
      }
      r.latest = 2;
      if (saved) {
        // Both bells were already consumed by an earlier run.
        writeFileSync(join(dir, "state.json"), JSON.stringify({
          version: 1, identity: SELF, channels: {}, relay: { url: "https://relay.example", seq: 2, epoch: "e1" },
        }));
      }
      const ac = new AbortController();
      stepper({ 3: () => ac.abort() }, ac);
      expect(await runStream(s, relayOpts(r, ac, { sinceSec: 300 }))).toBe(0);
      expect(r.afters).toEqual([0]);
      expect(emitted().map((m) => m.text)).toEqual(["@mybot 120s ago"]);
    }
  });

  test("bells from before --since (or before the first run) are not replayed", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const parent = ts(-10 * 86400);
    s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
    // Retained by the relay from a long downtime: 30 min and 2 min ago.
    for (const [i, ago] of [[1, 1800], [2, 120]] as const) {
      s.post("C00000001", { ts: ts(-ago), thread_ts: parent, user: "U00000001", text: `@mybot ${ago}s ago` });
      r.log.push([i, { channel: "C00000001", ts: ts(-ago), thread_ts: parent }]);
    }
    r.latest = 2;
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1, identity: SELF, channels: {}, relay: { url: "https://relay.example", seq: 0, epoch: "e1" },
    }));
    const ac = new AbortController();
    stepper({ 3: () => ac.abort() }, ac);
    expect(await runStream(s, relayOpts(r, ac, { sinceSec: 300 }))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot 120s ago"]);
  });

  test("a bell whose message is on a later page of its thread is still found", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    const parent = ts(-10 * 86400);
    s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
    stepper({
      1: () => {
        const base = now / 1000;
        // Three replies in the same second before ours: the fake pages 2 at a time.
        for (let i = 1; i <= 3; i++) s.post("C00000001", { ts: (base + i / 1000).toFixed(6), thread_ts: parent, user: "U00000002", text: `chat ${i}` });
        const t = (base + 0.5).toFixed(6);
        s.post("C00000001", { ts: t, thread_ts: parent, user: "U00000001", text: "@mybot page two" });
        r.ring(1, { channel: "C00000001", ts: t, thread_ts: parent });
      },
      3: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot page two"]);
    expect(err.some((l) => l.includes("abandoned"))).toBe(false);
  });

  test("a replayed bell finds its message however many posts came after it", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    stepper({
      1: () => {
        const t = (now / 1000).toFixed(6);
        s.post("C00000001", { ts: t, user: "U00000001", text: "@mybot buried" });
        for (let i = 1; i <= 9; i++) s.post("C00000001", { ts: (now / 1000 + i / 100).toFixed(6), user: "U00000002", text: `chat ${i}` });
        r.ring(1, { channel: "C00000001", ts: t });
      },
      3: () => ac.abort(),
    }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot buried"]);
    expect(s.calls.filter((c) => c.startsWith("replies"))).toHaveLength(1);
  });

  test("a bell that rang before the first connection succeeded is still delivered", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    r.fail.push(new Error("relay: HTTP 502"));
    const parent = ts(-10 * 86400); // only the bell can find this reply
    s.post("C00000001", { ts: parent, thread_ts: parent, user: "U00000002", text: "old" });
    const t = ts(1);
    s.post("C00000001", { ts: t, thread_ts: parent, user: "U00000001", text: "@mybot while connecting" });
    r.log.push([1, { channel: "C00000001", ts: t, thread_ts: parent }]); // stored by the relay meanwhile
    r.latest = 1;
    const ac = new AbortController();
    stepper({ 8: () => ac.abort() }, ac);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(emitted().map((m) => m.text)).toEqual(["@mybot while connecting"]);
  });

  test("while paused for its backlog, the relay counts as down: polling is back to --interval", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    const ac = new AbortController();
    let stalled = true;
    const realReplies = s.replies.bind(s);
    s.replies = async (c, tt, oldest, cursor) => {
      if (stalled) throw new Error("socket hang up"); // keeps the backlog from draining
      return realReplies(c, tt, oldest, cursor);
    };
    const sleeps = stepper({
      1: () => { for (let i = 1; i <= 2001; i++) r.ring(i, { channel: "C00000001", ts: (now / 1000).toFixed(6) }); },
      2: () => { stalled = false; },
      4000: () => ac.abort(),
    }, ac, 5000);
    expect(await runStream(s, relayOpts(r, ac))).toBe(0);
    expect(err).toContain("slack stream: relay unavailable (paused while its backlog drains) — polling every 30s");
    expect(sleeps[1]).toBeLessThanOrEqual(30_000);
    expect(err.filter((l) => l.includes("relay connected"))).toHaveLength(2); // and back once drained
  });

  test("--once ignores the relay", async () => {
    const s = new FakeSlack();
    const r = new FakeRelay();
    expect(await runStream(s, opts({ relay: { url: "https://relay.example", subscribe: r.subscribe, reconcileMs: 1 } }))).toBe(2);
    expect(r.afters).toHaveLength(0);
  });
});
