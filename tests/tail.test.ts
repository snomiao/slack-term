import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSince, pollCycle, cmdTail, resolveThreadTs, _internals } from "../ts/tail.ts";
import { startMock, type MockHandle } from "./mock.ts";

// ──────────────────────────────────────────────────────────
// parseSince — pure function
// ──────────────────────────────────────────────────────────

describe("parseSince", () => {
  test("seconds", () => expect(parseSince("30s")).toBe(30));
  test("minutes", () => expect(parseSince("10m")).toBeCloseTo(600));
  test("hours", () => expect(parseSince("2h")).toBeCloseTo(7200));
  test("days", () => expect(parseSince("1d")).toBeCloseTo(86400));
  test("fractional minutes", () => expect(parseSince("1.5m")).toBeCloseTo(90));
  test("throws on bad format", () => {
    expect(() => parseSince("abc")).toThrow("Invalid --since format");
    expect(() => parseSince("10x")).toThrow("Invalid --since format");
    expect(() => parseSince("")).toThrow("Invalid --since format");
  });
  // Cover the actual sleep implementation (called before any mock is installed)
  test("_internals.sleep resolves immediately when called with 0ms", async () => {
    await _internals.sleep(0);
  });
});

// ──────────────────────────────────────────────────────────
// resolveThreadTs — pure function
// ──────────────────────────────────────────────────────────

describe("resolveThreadTs", () => {
  test("passes through a dotted ts", () => {
    expect(resolveThreadTs("1782115333.349709")).toBe("1782115333.349709");
  });
  test("converts a compact 16-digit ts (no dot)", () => {
    expect(resolveThreadTs("1782115333349709")).toBe("1782115333.349709");
  });
  test("extracts ts from a permalink", () => {
    expect(resolveThreadTs("https://acme.slack.com/archives/C00000001/p1782115333349709"))
      .toBe("1782115333.349709");
  });
  test("prefers thread_ts query param from a permalink", () => {
    expect(resolveThreadTs("https://acme.slack.com/archives/C00000001/p1782115333349800?thread_ts=1782115333.349709"))
      .toBe("1782115333.349709");
  });
  test("throws on a permalink without a timestamp", () => {
    expect(() => resolveThreadTs("https://acme.slack.com/archives/C00000001"))
      .toThrow("could not extract a timestamp");
  });
  test("throws on garbage input", () => {
    expect(() => resolveThreadTs("not-a-ts")).toThrow("not a valid ts or permalink");
  });
});

// ──────────────────────────────────────────────────────────
// pollCycle — needs mock server
// ──────────────────────────────────────────────────────────

describe("pollCycle", () => {
  let mock: MockHandle;

  const baseFixtures = {
    "users.info__user=U00000001": {
      ok: true,
      user: { id: "U00000001", name: "alice", profile: { display_name: "Alice" } },
    },
    "auth.test": {
      ok: true,
      user_id: "U00000001",
      user: "alice",
      team: "Acme",
      team_id: "T00000001",
      url: "https://acme.slack.com/",
    },
    "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
      ok: true,
      channels: [{ id: "C00000001", name: "general" }],
    },
    "conversations.list__limit=200&types=public_channel_private_channel&exclude_archived=true": {
      ok: true,
      channels: [{ id: "C00000001", name: "general" }],
    },
  };

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        ...baseFixtures,
        "conversations.history__channel=C00000001&limit=20": {
          ok: true,
          messages: [
            { ts: "1700000003.000000", user: "U00000001", text: "third" },
            { ts: "1700000002.000000", user: "U00000001", text: "second" },
            { ts: "1700000001.000000", user: "U00000001", text: "first" },
          ],
        },
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [
            { ts: "1700000003.000000", user: "U00000001", text: "third" },
            { ts: "1700000002.000000", user: "U00000001", text: "second" },
            { ts: "1700000001.000000", user: "U00000001", text: "first" },
          ],
        },
        "conversations.history__channel=C00000001&limit=1": {
          ok: true,
          messages: [{ ts: "1700000005.000000", user: "U00000001", text: "latest" }],
        },
        "conversations.history__channel=C00000001&limit=1&oldest=1700000000.000000": {
          ok: true,
          messages: [{ ts: "1700000005.000000", user: "U00000001", text: "latest" }],
        },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("returns lines for new messages", async () => {
    const seen = new Set<string>();
    const cache = new Map<string, string>();
    const { lines, newCursor } = await pollCycle(
      "xoxp-fake",
      "C00000001",
      "1700000000.000000",
      {},
      seen,
      cache,
    );
    expect(lines.length).toBeGreaterThan(0);
    // lines are in chronological order (oldest-first)
    expect(lines[0]).toContain("first");
    expect(lines[lines.length - 1]).toContain("third");
    expect(newCursor).toBe("1700000003.000000");
  });

  test("deduplicates already-seen ts", async () => {
    const seen = new Set(["1700000001.000000", "1700000002.000000", "1700000003.000000"]);
    const cache = new Map<string, string>();
    const { lines } = await pollCycle("xoxp-fake", "C00000001", "1700000000.000000", {}, seen, cache);
    expect(lines).toHaveLength(0);
  });

  test("thread filter only emits matching thread messages", async () => {
    const seen = new Set<string>();
    const cache = new Map<string, string>();
    const mock2 = await startMock({
      inline: {
        ...baseFixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [
            { ts: "1700000003.000000", user: "U00000001", text: "reply", thread_ts: "1700000001.000000" },
            { ts: "1700000002.000000", user: "U00000001", text: "other thread", thread_ts: "1700000999.000000" },
            { ts: "1700000001.000000", user: "U00000001", text: "root", thread_ts: "1700000001.000000" },
          ],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mock2.baseUrl}/api`;
    try {
      const { lines } = await pollCycle(
        "xoxp-fake",
        "C00000001",
        "1700000000.000000",
        { thread: "1700000001.000000" },
        seen,
        cache,
      );
      expect(lines).toHaveLength(2);
      expect(lines.some((l) => l.includes("root"))).toBe(true);
      expect(lines.some((l) => l.includes("reply"))).toBe(true);
      expect(lines.some((l) => l.includes("other thread"))).toBe(false);
    } finally {
      process.env.SLACK_API_BASE = origBase;
      await mock2.stop();
    }
  });

  test("watch-thread merges channel top-level with thread replies, drops parent dup and other threads", async () => {
    const seen = new Set<string>();
    const cache = new Map<string, string>();
    const mockWT = await startMock({
      inline: {
        ...baseFixtures,
        "users.info__user=U00000002": {
          ok: true,
          user: { id: "U00000002", name: "bob", profile: { display_name: "Bob" } },
        },
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [
            { ts: "1700000005.000000", user: "U00000002", text: "fresh top-level" },
            { ts: "1700000004.000000", user: "U00000002", text: "other broadcast", thread_ts: "1700000888.000000" },
            { ts: "1700000001.000000", user: "U00000001", text: "root post", thread_ts: "1700000001.000000" },
          ],
        },
        "conversations.replies__channel=C00000001&limit=50&ts=1700000001.000000": {
          ok: true,
          messages: [
            { ts: "1700000001.000000", user: "U00000001", text: "root post", thread_ts: "1700000001.000000" },
            { ts: "1700000003.000000", user: "U00000002", text: "thread reply A", thread_ts: "1700000001.000000" },
          ],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockWT.baseUrl}/api`;
    try {
      const { lines } = await pollCycle(
        "xoxp-fake",
        "C00000001",
        "1700000000.000000",
        { watchThread: "1700000001.000000" },
        seen,
        cache,
      );
      // root post, thread reply A, fresh top-level — sorted ascending by ts
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("root post");
      expect(lines[1]).toContain("thread reply A");
      expect(lines[1]).toContain("↳"); // reply annotation
      expect(lines[2]).toContain("fresh top-level");
      // parent appears once (not duplicated by the replies fetch)
      expect(lines.filter((l) => l.includes("root post"))).toHaveLength(1);
      // a broadcast from a different thread is dropped
      expect(lines.some((l) => l.includes("other broadcast"))).toBe(false);
    } finally {
      process.env.SLACK_API_BASE = origBase;
      await mockWT.stop();
    }
  });

  test("--me filter only emits messages mentioning myUserId", async () => {
    const seen = new Set<string>();
    const cache = new Map<string, string>();
    const mock3 = await startMock({
      inline: {
        ...baseFixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [
            { ts: "1700000002.000000", user: "U00000002", text: "hey <@U00000001> hello" },
            { ts: "1700000001.000000", user: "U00000002", text: "just a message" },
          ],
        },
        "users.info__user=U00000002": {
          ok: true,
          user: { id: "U00000002", name: "bob", profile: { display_name: "Bob" } },
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mock3.baseUrl}/api`;
    try {
      const { lines } = await pollCycle(
        "xoxp-fake",
        "C00000001",
        "1700000000.000000",
        { me: true, myUserId: "U00000001" },
        seen,
        cache,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("hello");
    } finally {
      process.env.SLACK_API_BASE = origBase;
      await mock3.stop();
    }
  });

  test("skips message_changed and message_deleted subtypes", async () => {
    const seen = new Set<string>();
    const cache = new Map<string, string>();
    const mockSub = await startMock({
      inline: {
        ...baseFixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [
            { ts: "1700000003.000000", user: "U00000001", text: "real message" },
            { ts: "1700000002.000000", subtype: "message_changed", user: "U00000001", text: "edited" },
            { ts: "1700000001.000000", subtype: "message_deleted", user: "U00000001", text: "" },
          ],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockSub.baseUrl}/api`;
    try {
      const { lines } = await pollCycle("xoxp-fake", "C00000001", "1700000000.000000", {}, seen, cache);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("real message");
    } finally {
      process.env.SLACK_API_BASE = origBase;
      await mockSub.stop();
    }
  });

  test("multi-line message body indents continuation lines", async () => {
    const seen = new Set<string>();
    const cache = new Map<string, string>();
    const mockMulti = await startMock({
      inline: {
        ...baseFixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [{ ts: "1700000001.000000", user: "U00000001", text: "line1\nline2\nline3" }],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockMulti.baseUrl}/api`;
    try {
      const { lines } = await pollCycle("xoxp-fake", "C00000001", "1700000000.000000", {}, seen, cache);
      expect(lines[0]).toContain("line1");
      expect(lines[0]).toContain("  line2");
    } finally {
      process.env.SLACK_API_BASE = origBase;
      await mockMulti.stop();
    }
  });

  test("bot message uses username field", async () => {
    const seen = new Set<string>();
    const cache = new Map<string, string>();
    const mock4 = await startMock({
      inline: {
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [
            { ts: "1700000001.000000", username: "mybot", text: "bot says hi" },
          ],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mock4.baseUrl}/api`;
    try {
      const { lines } = await pollCycle("xoxp-fake", "C00000001", "1700000000.000000", {}, seen, cache);
      expect(lines[0]).toContain("mybot");
    } finally {
      process.env.SLACK_API_BASE = origBase;
      await mock4.stop();
    }
  });

  test("seen set cap at 1000 evicts oldest", async () => {
    const seen = new Set<string>(Array.from({ length: 1000 }, (_, i) => `${i}.000000`));
    const cache = new Map<string, string>();
    const mock5 = await startMock({
      inline: {
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [{ ts: "1700000001.000000", user: "U00000001", text: "new msg" }],
        },
        ...baseFixtures,
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mock5.baseUrl}/api`;
    try {
      const { lines } = await pollCycle("xoxp-fake", "C00000001", "1700000000.000000", {}, seen, cache);
      expect(lines).toHaveLength(1);
      expect(seen.size).toBe(1000); // evicted one, added one → stays at 1000
    } finally {
      process.env.SLACK_API_BASE = origBase;
      await mock5.stop();
    }
  });
});

// ──────────────────────────────────────────────────────────
// cmdTail — high-level integration
// ──────────────────────────────────────────────────────────

describe("cmdTail", () => {
  let mock: MockHandle;

  const fixtures = {
    "auth.test": {
      ok: true,
      user_id: "U00000001",
      user: "alice",
      team: "Acme",
      team_id: "T00000001",
      url: "https://acme.slack.com/",
    },
    "users.info__user=U00000001": {
      ok: true,
      user: { id: "U00000001", name: "alice", profile: { display_name: "Alice" } },
    },
    "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
      ok: true,
      channels: [{ id: "C00000001", name: "general" }],
    },
    "conversations.list__limit=200&types=public_channel_private_channel&exclude_archived=true": {
      ok: true,
      channels: [{ id: "C00000001", name: "general" }],
    },
    "conversations.info__channel=C00000001": {
      ok: true,
      channel: { id: "C00000001", name: "general", is_member: true, is_archived: false },
    },
    "conversations.history__channel=C00000001&limit=1": {
      ok: true,
      messages: [{ ts: "1700000005.000000", user: "U00000001", text: "seed" }],
    },
    "conversations.history__channel=C00000001&limit=20&oldest=1700000005.000000": {
      ok: true,
      messages: [{ ts: "1700000006.000000", user: "U00000001", text: "new message" }],
    },
  };

  beforeAll(async () => {
    mock = await startMock({ inline: fixtures });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
    vi.spyOn(_internals, "sleep").mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
    vi.restoreAllMocks();
  });

  test("streams new messages after seed point", async () => {
    const ac = new AbortController();
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort(); // stop after first batch
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { interval: 0 }, ac.signal);
    } catch {
      // abort can cause rejection in some paths — ignore
    } finally {
      spy.mockRestore();
    }
    expect(output.join("")).toContain("new message");
  });

  test("backfill with --since prints backfill messages", async () => {
    // Pin _internals.now so cursor = 1700000600 - 600 = 1700000000.000000 (matches fixture)
    const nowSpy = vi.spyOn(_internals, "now").mockReturnValue(1700000600000);
    const mock2 = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [{ ts: "1700000003.000000", user: "U00000001", text: "backfill message" }],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mock2.baseUrl}/api`;
    const ac = new AbortController();
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { since: "10m", interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      spy.mockRestore();
      nowSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mock2.stop();
    }
    expect(output.join("")).toContain("backfill message");
  });

  test("--me filter calls authTest to get myUserId", async () => {
    const mock3 = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000005.000000": {
          ok: true,
          messages: [
            { ts: "1700000006.000000", user: "U00000002", text: "hey <@U00000001> ping" },
            { ts: "1700000007.000000", user: "U00000002", text: "unrelated" },
          ],
        },
        "users.info__user=U00000002": {
          ok: true,
          user: { id: "U00000002", name: "bob", profile: { display_name: "Bob" } },
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mock3.baseUrl}/api`;
    const ac = new AbortController();
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { me: true, interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      spy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mock3.stop();
    }
    // Only the mention message should have been printed
    const joined = output.join("");
    expect(joined).toContain("ping");
    expect(joined).not.toContain("unrelated");
  });

  test("--timeout stops on its own after the deadline (no abort needed)", async () => {
    // First now() call computes the deadline; every later call jumps far past it
    // so the loop returns without hanging.
    let calls = 0;
    const nowSpy = vi.spyOn(_internals, "now").mockImplementation(() => {
      calls++;
      return calls <= 1 ? 1700000000000 : 1700000000000 + 999999;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { timeout: "1s", interval: 0 });
    } finally {
      nowSpy.mockRestore();
    }
    expect(calls).toBeGreaterThan(1); // resolved via deadline, did not hang
  });

  test("--exit-on-message returns when someone else replies", async () => {
    const mockR = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000005.000000": {
          ok: true,
          messages: [{ ts: "1700000006.000000", user: "U00000002", text: "yamada reply" }],
        },
        "users.info__user=U00000002": {
          ok: true,
          user: { id: "U00000002", name: "yamada", profile: { display_name: "Yamada" } },
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockR.baseUrl}/api`;
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      // No abort signal: must return on its own once the reply arrives.
      await cmdTail("xoxp-fake", "#general", { exitOnMessage: true, interval: 0 });
    } finally {
      spy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockR.stop();
    }
    expect(output.join("")).toContain("yamada reply");
  });

  test("--exit-on-message ignores my own posts, exits on someone else's", async () => {
    const mockS = await startMock({
      inline: {
        ...fixtures,
        // cycle 1 after seed: my own message — must NOT trigger exit
        "conversations.history__channel=C00000001&limit=20&oldest=1700000005.000000": {
          ok: true,
          messages: [{ ts: "1700000006.000000", user: "U00000001", text: "my own followup" }],
        },
        // cycle 2: someone else — triggers exit
        "conversations.history__channel=C00000001&limit=20&oldest=1700000006.000000": {
          ok: true,
          messages: [{ ts: "1700000007.000000", user: "U00000002", text: "their reply" }],
        },
        "users.info__user=U00000002": {
          ok: true,
          user: { id: "U00000002", name: "bob", profile: { display_name: "Bob" } },
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockS.baseUrl}/api`;
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { exitOnMessage: true, interval: 0 });
    } finally {
      spy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockS.stop();
    }
    const joined = output.join("");
    expect(joined).toContain("my own followup"); // printed, but did not exit
    expect(joined).toContain("their reply");      // printed, and triggered exit
  });

  test("--watch-thread merges replies through the poll loop", async () => {
    const mockWT = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000005.000000": {
          ok: true,
          messages: [{ ts: "1700000006.000000", user: "U00000001", text: "new message" }],
        },
        "conversations.replies__channel=C00000001&limit=50&ts=1700000005.000000": {
          ok: true,
          messages: [
            { ts: "1700000005.000000", user: "U00000001", text: "seed", thread_ts: "1700000005.000000" },
            { ts: "1700000007.000000", user: "U00000001", text: "watched thread reply", thread_ts: "1700000005.000000" },
          ],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockWT.baseUrl}/api`;
    const ac = new AbortController();
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { watchThread: "1700000005.000000", interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      spy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockWT.stop();
    }
    expect(output.join("")).toContain("watched thread reply");
  });

  test("--watch-thread exits on an invalid ts/permalink", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cmdTail("xoxp-fake", "#general", { watchThread: "garbage", interval: 0 }))
        .rejects.toThrow("process.exit");
      expect(errSpy.mock.calls.flat().join(" ")).toContain("not a valid ts or permalink");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("errors when --me given without target", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cmdTail("xoxp-fake", undefined, { me: true })).rejects.toThrow("process.exit");
      expect(errSpy.mock.calls.join(" ")).toContain("requires a <target>");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("errors when no target given", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cmdTail("xoxp-fake", undefined, {})).rejects.toThrow("process.exit");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("handles empty channel at start (no seed message) then emits new messages", async () => {
    // Pin _internals.now so empty-seed cursor = 1700000000.000000 (matches fixture)
    const nowSpy = vi.spyOn(_internals, "now").mockReturnValue(1700000000000);
    const mock4 = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=1": {
          ok: true,
          messages: [],
        },
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [{ ts: "1700000006.000000", user: "U00000001", text: "first ever" }],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mock4.baseUrl}/api`;
    const ac = new AbortController();
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      spy.mockRestore();
      nowSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mock4.stop();
    }
    expect(output.join("")).toContain("first ever");
  });

  test("preflight: exits on not_in_channel error", async () => {
    const mockPF = await startMock({
      inline: {
        ...fixtures,
        "conversations.info__channel=C00000001": {
          ok: false,
          error: "not_in_channel",
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockPF.baseUrl}/api`;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cmdTail("xoxp-fake", "#general", { interval: 0 })).rejects.toThrow("process.exit");
      expect(errSpy.mock.calls.flat().join(" ")).toContain("not a member");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockPF.stop();
    }
  });

  test("preflight: exits on missing_scope error", async () => {
    const mockPF2 = await startMock({
      inline: {
        ...fixtures,
        "conversations.info__channel=C00000001": {
          ok: false,
          error: "missing_scope",
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockPF2.baseUrl}/api`;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cmdTail("xoxp-fake", "#general", { interval: 0 })).rejects.toThrow("process.exit");
      expect(errSpy.mock.calls.flat().join(" ")).toContain("scope");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockPF2.stop();
    }
  });

  test("--since with no backfill messages emits notice", async () => {
    // Pin _internals.now: cursor = 1700000600 - 600 = 1700000000.000000
    const nowSpy = vi.spyOn(_internals, "now").mockReturnValue(1700000600000);
    const mockEmpty = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockEmpty.baseUrl}/api`;
    const ac = new AbortController();
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort(); // stop after the notice is written
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { since: "10m", interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      spy.mockRestore();
      nowSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockEmpty.stop();
    }
    expect(output.join("")).toContain("no messages in the last 10m");
  });

  test("rate limit: logs warning and sleeps retryAfter on 429", async () => {
    const mockRL = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000005.000000": {
          __status: 429,
          __retryAfter: 5,
          ok: false,
          error: "ratelimited",
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockRL.baseUrl}/api`;
    const ac = new AbortController();
    const errors: string[] = [];
    const sleepCalls: number[] = [];
    const sleepSpy = vi.spyOn(_internals, "sleep").mockImplementation(async (ms) => {
      sleepCalls.push(ms);
      if (ms === 5000) ac.abort(); // abort after the rate-limit backoff sleep
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      await cmdTail("xoxp-fake", "#general", { interval: 60000 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      errSpy.mockRestore();
      sleepSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockRL.stop();
    }
    expect(errors.some((e) => e.toLowerCase().includes("rate limit"))).toBe(true);
    expect(sleepCalls).toContain(5000);
  });

  test("long-sleep gap triggers cursor pagination", async () => {
    const INTERVAL = 60000;
    const mockPag = await startMock({
      inline: {
        ...fixtures,
        // Page 1: no new messages, but has_more with a next cursor
        "conversations.history__channel=C00000001&limit=20&oldest=1700000005.000000": {
          ok: true,
          messages: [],
          has_more: true,
          response_metadata: { next_cursor: "cursor_nc1" },
        },
        // Page 2 (cursor pagination — key sorted: channel, cursor, limit)
        "conversations.history__channel=C00000001&cursor=cursor_nc1&limit=20": {
          ok: true,
          messages: [{ ts: "1700000009.000000", user: "U00000001", text: "paginated message" }],
          has_more: false,
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockPag.baseUrl}/api`;
    const ac = new AbortController();
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });

    // Simulate a long gap: lastPollEndTime=0, then on wake now=INTERVAL*6
    let nowCalls = 0;
    const nowSpy = vi.spyOn(_internals, "now").mockImplementation(() => {
      // First call initialises lastPollEndTime=0; subsequent calls after sleep return INTERVAL*6
      return nowCalls++ === 0 ? 0 : INTERVAL * 6;
    });
    let sleepCount = 0;
    const sleepSpy = vi.spyOn(_internals, "sleep").mockImplementation(async () => {
      sleepCount++;
    });

    try {
      await cmdTail("xoxp-fake", "#general", { interval: INTERVAL }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      writeSpy.mockRestore();
      nowSpy.mockRestore();
      sleepSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockPag.stop();
    }
    expect(output.join("")).toContain("paginated message");
  });

  test("RTM path: calls tailRTM when xoxc token + cookie, no --since", async () => {
    // Track call via local variable — mockRestore() clears mock.calls so we can't read it after.
    let rtmCallCount = 0;
    const origTailRTM = _internals.tailRTM;
    _internals.tailRTM = async () => { rtmCallCount++; };
    const ac = new AbortController();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => { ac.abort(); return true; });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await cmdTail("xoxc-fake", "#general", { cookie: "xoxd-fake", interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      _internals.tailRTM = origTailRTM;
      writeSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(rtmCallCount).toBe(1);
  });

  test("RTM path: skips RTM when noRtm is true, goes straight to polling", async () => {
    let rtmCallCount = 0;
    const origTailRTM = _internals.tailRTM;
    _internals.tailRTM = async () => { rtmCallCount++; };
    const ac = new AbortController();
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });
    try {
      await cmdTail("xoxc-fake", "#general", { cookie: "xoxd-fake", noRtm: true, interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      _internals.tailRTM = origTailRTM;
      writeSpy.mockRestore();
    }
    expect(rtmCallCount).toBe(0);
    expect(output.join("")).toContain("new message"); // polling ran
  });

  test("RTM path: skips RTM when asBot is true", async () => {
    let rtmCallCount = 0;
    const origTailRTM = _internals.tailRTM;
    _internals.tailRTM = async () => { rtmCallCount++; };
    const ac = new AbortController();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => { ac.abort(); return true; });
    try {
      await cmdTail("xoxc-fake", "#general", { cookie: "xoxd-fake", asBot: true, interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      _internals.tailRTM = origTailRTM;
      writeSpy.mockRestore();
    }
    expect(rtmCallCount).toBe(0);
  });

  test("RTM path: skips RTM when token is not xoxc-", async () => {
    let rtmCallCount = 0;
    const origTailRTM = _internals.tailRTM;
    _internals.tailRTM = async () => { rtmCallCount++; };
    const ac = new AbortController();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => { ac.abort(); return true; });
    try {
      await cmdTail("xoxp-fake", "#general", { cookie: "xoxd-fake", interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      _internals.tailRTM = origTailRTM;
      writeSpy.mockRestore();
    }
    expect(rtmCallCount).toBe(0);
  });

  test("RTM path: skips RTM when --since is set", async () => {
    const nowSpy = vi.spyOn(_internals, "now").mockReturnValue(1700000600000);
    let rtmCallCount = 0;
    const origTailRTM = _internals.tailRTM;
    _internals.tailRTM = async () => { rtmCallCount++; };
    const mockSince = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000000.000000": {
          ok: true,
          messages: [{ ts: "1700000003.000000", user: "U00000001", text: "since msg" }],
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockSince.baseUrl}/api`;
    const ac = new AbortController();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => { ac.abort(); return true; });
    try {
      await cmdTail("xoxc-fake", "#general", { cookie: "xoxd-fake", since: "10m", interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      _internals.tailRTM = origTailRTM;
      writeSpy.mockRestore();
      nowSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockSince.stop();
    }
    expect(rtmCallCount).toBe(0);
  });

  test("RTM path: falls back to polling when tailRTM returns without aborting", async () => {
    const errMsgs: string[] = [];
    let rtmCallCount = 0;
    const origTailRTM = _internals.tailRTM;
    _internals.tailRTM = async () => { rtmCallCount++; };
    const ac = new AbortController();
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg) => errMsgs.push(String(msg)));
    try {
      await cmdTail("xoxc-fake", "#general", { cookie: "xoxd-fake", interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      _internals.tailRTM = origTailRTM;
      writeSpy.mockRestore();
      errSpy.mockRestore();
    }
    // RTM returned without abort → "RTM unavailable" logged → polling ran → "new message" emitted
    expect(rtmCallCount).toBe(1);
    expect(errMsgs.join(" ")).toContain("RTM unavailable");
    expect(output.join("")).toContain("new message");
  });

  test("preflight: warns about archived channel but continues", async () => {
    const mockArch = await startMock({
      inline: {
        ...fixtures,
        "conversations.info__channel=C00000001": {
          ok: true,
          channel: { id: "C00000001", name: "general", is_member: true, is_archived: true },
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockArch.baseUrl}/api`;
    const ac = new AbortController();
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      errSpy.mockRestore();
      writeSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockArch.stop();
    }
    expect(errors.some((e) => e.includes("archived"))).toBe(true);
    // cmdTail continued (did not exit) — it emitted a message
    expect(output.join("")).toContain("new message");
  });

  test("preflight: exits on channel_not_found error", async () => {
    const mockPF3 = await startMock({
      inline: {
        ...fixtures,
        "conversations.info__channel=C00000001": { ok: false, error: "channel_not_found" },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockPF3.baseUrl}/api`;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cmdTail("xoxp-fake", "#general", { interval: 0 })).rejects.toThrow("process.exit");
      expect(errSpy.mock.calls.flat().join(" ")).toContain("channel not found");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockPF3.stop();
    }
  });

  test("preflight: warns and continues on generic error", async () => {
    const mockPF4 = await startMock({
      inline: {
        ...fixtures,
        "conversations.info__channel=C00000001": { ok: false, error: "some_transient_error" },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockPF4.baseUrl}/api`;
    const ac = new AbortController();
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });
    try {
      await cmdTail("xoxp-fake", "#general", { interval: 0 }, ac.signal);
    } catch {
      // ignore abort
    } finally {
      errSpy.mockRestore();
      writeSpy.mockRestore();
      process.env.SLACK_API_BASE = origBase;
      await mockPF4.stop();
    }
    expect(errors.some((e) => e.includes("preflight check failed"))).toBe(true);
    // continued despite error
    expect(output.join("")).toContain("new message");
  });

  test("poll loop rethrows non-RateLimitError", async () => {
    const mockRethrow = await startMock({
      inline: {
        ...fixtures,
        "conversations.history__channel=C00000001&limit=20&oldest=1700000005.000000": {
          ok: false,
          error: "fatal_error",
        },
      },
    });
    const origBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${mockRethrow.baseUrl}/api`;
    try {
      await expect(cmdTail("xoxp-fake", "#general", { interval: 0 })).rejects.toThrow(/Slack error/);
    } finally {
      process.env.SLACK_API_BASE = origBase;
      await mockRethrow.stop();
    }
  });
});

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS_ENTRY = join(CLI_ROOT, "ts", "cli.ts");

function runTailCli(
  home: string,
  args: string[],
  baseUrl: string,
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = {
    ...rest,
    HOME: home,
    SLACK_API_BASE: `${baseUrl}/api`,
    ...envOverrides,
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: home, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (exitCode: number | null) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("tail --as-bot (CLI)", { timeout: 30_000 }, () => {
  test("resolves SLACK_BOT_TOKEN without a user profile", async () => {
    const home = mkdtempSync(join(tmpdir(), "slack-tail-bot-"));
    const botMock = await startMock({
      inline: {
        "conversations.info__channel=D0B0W2FGNHH": {
          ok: true,
          channel: { id: "D0B0W2FGNHH", is_im: true },
        },
      },
    });
    try {
      const result = await runTailCli(
        home,
        ["tail", "D0B0W2FGNHH", "--as-bot", "--since=1s", "--timeout=0s"],
        botMock.baseUrl,
        { SLACK_BOT_TOKEN: "xoxb-tail-test" },
      );
      expect(result.exitCode).toBe(0);
      const infoRequest = botMock.requests.find((request) => request.method === "conversations.info");
      expect(infoRequest?.headers.authorization).toBe("Bearer xoxb-tail-test");
    } finally {
      await botMock.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("errors cleanly when no bot token is configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "slack-tail-no-bot-"));
    const botMock = await startMock();
    try {
      const result = await runTailCli(home, ["tail", "D0B0W2FGNHH", "--as-bot"], botMock.baseUrl);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error: --as-bot needs a bot token");
      expect(result.stderr).toContain("Set SLACK_BOT_TOKEN=xoxb-...");
      expect(result.stderr).not.toContain("No Slack token found");
    } finally {
      await botMock.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
