import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { parseSince, pollCycle, cmdTail, _internals } from "../ts/tail.ts";
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
    const origWrite = process.stdout.write.bind(process.stdout);
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
    // Pin Date.now() so cursor = 1700000600 - 600 = 1700000000.000000 (matches fixture)
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000600000));
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
      process.env.SLACK_API_BASE = origBase;
      await mock2.stop();
      vi.useRealTimers();
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
    // Pin Date.now() so empty-seed cursor = 1700000000.000000 (matches fixture)
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
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
      process.env.SLACK_API_BASE = origBase;
      await mock4.stop();
      vi.useRealTimers();
    }
    expect(output.join("")).toContain("first ever");
  });
});
