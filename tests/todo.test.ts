import { describe, test, expect, vi, mockModule, beforeEach, afterEach } from "./harness.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


// The whole point of these tests is that no write ever reaches a real workspace:
// every Slack call is a spy, and the call ORDER is what's asserted.
const calls: string[] = [];
const behaviour = {
  reactionsGet: [] as { name: string; users: string[] }[],
  addFails: undefined as Error | undefined,
  authFails: undefined as Error | undefined,
  removeFails: new Set<string>(),
  addRateLimits: 0,
  historyPages: [] as unknown[],
  teamId: "T_ONE",
};

mockModule("../ts/slack.ts", () => {
  // Keep the mock synchronous: an async factory awaits the real module, and on
  // GitHub's Node 24 worker that dynamic import can deadlock when an earlier
  // test file in the same worker already imported ts/slack.ts. Re-declaring the
  // one class under test avoids that import entirely.
  class RateLimitError extends Error {
    retryAfter: number;
    constructor(retryAfter: number) {
      super(`Slack rate limited — retry after ${retryAfter}s`);
      this.name = "RateLimitError";
      this.retryAfter = retryAfter;
    }
  }
  return {
    RateLimitError,
    authTest: vi.fn(async () => {
      calls.push("auth.test");
      if (behaviour.authFails) throw behaviour.authFails;
      return { team: "t", teamId: behaviour.teamId, url: "", user: "me", userId: "U_ME" };
    }),
    reactionsGet: vi.fn(async () => {
      calls.push("get");
      return behaviour.reactionsGet;
    }),
    reactionAdd: vi.fn(async (_t: string, _c: string, _ts: string, name: string) => {
      if (behaviour.addRateLimits > 0) {
        behaviour.addRateLimits--;
        calls.push(`add:${name}:429`);
        throw new RateLimitError(7);
      }
      calls.push(`add:${name}`);
      if (behaviour.addFails) throw behaviour.addFails;
    }),
    reactionRemove: vi.fn(async (_t: string, _c: string, _ts: string, name: string) => {
      calls.push(`remove:${name}:start`);
      // Yield to the microtask queue: if removes were fired with Promise.all,
      // the interleaved starts/ends would show up in `calls`.
      await new Promise((r) => setTimeout(r, 0));
      if (behaviour.removeFails.has(name)) throw new Error(`Slack error on reactions.remove: no_reaction`);
      calls.push(`remove:${name}:end`);
    }),
    history: vi.fn(async () => {
      calls.push("history");
      return behaviour.historyPages.shift() ?? { messages: [] };
    }),
  };
});

const { RateLimitError } = await import("../ts/slack.ts");
const {
  DEFAULT_TODO_CONFIG,
  userHandleCached,
  userTzCached,
  buildTodoQuery,
  loadTodoConfig,
  todoSet,
  todoFlag,
  todoDoctor,
  withRateLimitRetry,
  resolveChannelCached,
  resetSelfIdForTests,
  _internals,
} = await import("../ts/todo.ts");
const cacheMod = await import("../ts/cache.ts");

const cfg = DEFAULT_TODO_CONFIG;

// NOTHING in this file may sleep for real. Almost every helper here reaches
// `withRateLimitRetry` (via cacheScope → identity), which backs off in wall-clock
// seconds when a call 429s or auth.test fails. Individual describes stubbed
// `_internals.sleep` and then called `spy.mockRestore()`, which handed the REAL
// sleep to every later block — and a later test that makes auth.test fail then
// parked the whole file until the CI job timeout.
//
// That was the hang: `todo.test.ts` alone burned 60s+ on GitHub's runner while
// every other file finished in under 2s, and it never reproduced locally (Node
// v26 here vs v24 there). A file-wide default is the fix rather than a stub per
// describe: "no real sleeping" is a property of the file, and per-block stubs
// are exactly what let it regress once already.
beforeEach(() => {
  vi.spyOn(_internals, "sleep").mockResolvedValue(undefined);
});

beforeEach(() => {
  calls.length = 0;
  behaviour.reactionsGet = [];
  behaviour.addFails = undefined;
  behaviour.removeFails = new Set();
  behaviour.addRateLimits = 0;
  behaviour.historyPages = [];
  behaviour.teamId = "T_ONE";
  resetSelfIdForTests();
  cacheMod.resetCacheForTests();
  cacheMod.setCacheEnabled(false); // opt in per-test
});

// ──────────────────────────────────────────────────────────
// (f) query building — defaults to hasmy:
// ──────────────────────────────────────────────────────────

describe("buildTodoQuery", () => {
  test("defaults to hasmy: (only my reactions), never has:", () => {
    for (const state of ["open", "untriaged", "pending", "doing", "done", "dropped", "stuck"] as const) {
      const q = buildTodoQuery(state, cfg);
      expect(q).toContain("hasmy:");
      expect(q.replace(/hasmy:/g, "")).not.toContain("has:");
    }
  });

  test("--shared switches every term to has:", () => {
    const q = buildTodoQuery("doing", cfg, { shared: true });
    expect(q).toBe("has::eyes: -has::white_check_mark: -has::no_entry_sign:");
    expect(q).not.toContain("hasmy:");
  });

  test("progress states negate every higher-priority emoji", () => {
    expect(buildTodoQuery("done", cfg)).toBe("hasmy::white_check_mark:");
    expect(buildTodoQuery("dropped", cfg)).toBe("hasmy::no_entry_sign: -hasmy::white_check_mark:");
    expect(buildTodoQuery("doing", cfg)).toBe(
      "hasmy::eyes: -hasmy::white_check_mark: -hasmy::no_entry_sign:",
    );
    expect(buildTodoQuery("pending", cfg)).toBe(
      "hasmy::hourglass_flowing_sand: -hasmy::white_check_mark: -hasmy::no_entry_sign: -hasmy::eyes:",
    );
  });

  test("untriaged = marker with no progress emoji", () => {
    expect(buildTodoQuery("untriaged", cfg)).toBe(
      "hasmy::pushpin: -hasmy::white_check_mark: -hasmy::no_entry_sign: -hasmy::eyes: -hasmy::hourglass_flowing_sand:",
    );
  });

  test("stuck = unfinished AND any reason flag (waiting included), in a single query", () => {
    const q = buildTodoQuery("stuck", cfg);
    expect(q).toBe(
      "hasmy::pushpin: -hasmy::white_check_mark: -hasmy::no_entry_sign: " +
      "(hasmy::exclamation: OR hasmy::thinking_face: OR hasmy::speech_balloon: OR hasmy::lock:)",
    );
    expect(q).toContain("hasmy::speech_balloon:");
  });

  test("--from adds a from: term, supplying the missing @", () => {
    expect(buildTodoQuery("open", cfg, { from: "@alice" })).toContain("from:@alice");
    expect(buildTodoQuery("open", cfg, { from: "alice" })).toContain("from:@alice");
  });

  test("--from me stays the bare `me` keyword", () => {
    const q = buildTodoQuery("open", cfg, { from: "me" });
    expect(q).toContain("from:me");
    expect(q).not.toContain("from:@me");
  });

  test("--in and --from combine on one query", () => {
    const q = buildTodoQuery("stuck", cfg, { in: "eng", from: "alice" });
    expect(q).toContain("in:#eng");
    expect(q).toContain("from:@alice");
  });

  test("--in adds an in: term, tolerating a missing #", () => {
    expect(buildTodoQuery("open", cfg, { in: "#general" })).toContain("in:#general");
    expect(buildTodoQuery("open", cfg, { in: "general" })).toContain("in:#general");
  });

  test("honours a custom emoji map", () => {
    const custom = { ...cfg, progress: { ...cfg.progress, doing: "construction" } };
    expect(buildTodoQuery("doing", custom)).toContain("hasmy::construction:");
  });

  test("a custom waiting emoji flows into the stuck OR clause", () => {
    const custom = { ...cfg, flags: { ...cfg.flags, waiting: "raising_hand" } };
    const q = buildTodoQuery("stuck", custom);
    expect(q).toContain("hasmy::raising_hand:");
    expect(q).not.toContain("hasmy::speech_balloon:");
    expect(q).toContain("hasmy::lock:"); // blocked untouched
  });
});

describe("loadTodoConfig", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "todocfg-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("missing file → defaults", () => {
    expect(loadTodoConfig(join(dir, "nope.json"))).toEqual(DEFAULT_TODO_CONFIG);
  });
  test("corrupt file → defaults (never throws)", () => {
    const p = join(dir, "todo.json");
    writeFileSync(p, "{not json");
    expect(loadTodoConfig(p)).toEqual(DEFAULT_TODO_CONFIG);
  });
  test("partial override merges over defaults and strips colons", () => {
    const p = join(dir, "todo.json");
    writeFileSync(p, JSON.stringify({ marker: ":round_pushpin:", progress: { doing: "construction" } }));
    const c = loadTodoConfig(p);
    expect(c.marker).toBe("round_pushpin");
    expect(c.progress.doing).toBe("construction");
    expect(c.progress.done).toBe("white_check_mark");
    expect(c.flags.blocked).toBe("lock");
    expect(c.flags.waiting).toBe("speech_balloon");
  });

  test("waiting can be overridden independently of blocked", () => {
    const p = join(dir, "todo.json");
    writeFileSync(p, JSON.stringify({ flags: { waiting: ":eyes:" } }));
    const c = loadTodoConfig(p);
    expect(c.flags.waiting).toBe("eyes");
    expect(c.flags.blocked).toBe("lock");
  });
});

// ──────────────────────────────────────────────────────────
// (a)(b) todoSet — add BEFORE remove, removes serial
// ──────────────────────────────────────────────────────────

describe("todoSet", () => {
  test("(a) adds the new reaction before removing any old one", async () => {
    behaviour.reactionsGet = [{ name: "hourglass_flowing_sand", users: ["U_ME"] }];
    const res = await todoSet("tok", "C1", "1.1", "doing", cfg);
    const addIdx = calls.indexOf("add:eyes");
    const removeIdx = calls.findIndex((c) => c.startsWith("remove:"));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(addIdx);
    expect(res.removed).toEqual(["hourglass_flowing_sand"]);
    expect(res.leftover).toEqual([]);
  });

  test("(b) removes are awaited serially, never Promise.all", async () => {
    behaviour.reactionsGet = [
      { name: "hourglass_flowing_sand", users: ["U_ME"] },
      { name: "eyes", users: ["U_ME"] },
      { name: "no_entry_sign", users: ["U_ME"] },
    ];
    await todoSet("tok", "C1", "1.1", "done", cfg);
    const removes = calls.filter((c) => c.startsWith("remove:"));
    // Serial ⇒ every start is immediately followed by its own end.
    for (let i = 0; i < removes.length; i += 2) {
      const name = removes[i]!.split(":")[1];
      expect(removes[i]).toBe(`remove:${name}:start`);
      expect(removes[i + 1]).toBe(`remove:${name}:end`);
    }
    // Priority order: dropped before doing before pending.
    expect(removes.filter((c) => c.endsWith(":start"))).toEqual([
      "remove:no_entry_sign:start", "remove:eyes:start", "remove:hourglass_flowing_sand:start",
    ]);
  });

  test("only considers MY reactions, not other people's", async () => {
    behaviour.reactionsGet = [
      { name: "hourglass_flowing_sand", users: ["U_OTHER"] },
      { name: "eyes", users: ["U_ME"] },
    ];
    const res = await todoSet("tok", "C1", "1.1", "done", cfg);
    expect(res.removed).toEqual(["eyes"]);
    expect(calls).not.toContain("remove:hourglass_flowing_sand:start");
  });

  test("no-op when already exactly in the target state (no add, no remove)", async () => {
    behaviour.reactionsGet = [{ name: "eyes", users: ["U_ME"] }];
    const res = await todoSet("tok", "C1", "1.1", "doing", cfg);
    expect(res.noop).toBe(true);
    expect(calls.filter((c) => c.startsWith("add:") || c.startsWith("remove:"))).toEqual([]);
  });

  test("a failing remove is swallowed and reported as leftover", async () => {
    behaviour.reactionsGet = [
      { name: "hourglass_flowing_sand", users: ["U_ME"] },
      { name: "eyes", users: ["U_ME"] },
    ];
    behaviour.removeFails = new Set(["eyes"]);
    const res = await todoSet("tok", "C1", "1.1", "done", cfg);
    expect(res.leftover).toEqual(["eyes"]);
    expect(res.removed).toEqual(["hourglass_flowing_sand"]); // kept going after the failure
  });

  test("skips the add when the target reaction is already present alongside a stale one", async () => {
    behaviour.reactionsGet = [
      { name: "eyes", users: ["U_ME"] },
      { name: "white_check_mark", users: ["U_ME"] },
    ];
    const res = await todoSet("tok", "C1", "1.1", "done", cfg);
    expect(calls).not.toContain("add:white_check_mark");
    expect(res.removed).toEqual(["eyes"]);
  });
});

describe("todoFlag", () => {
  test("adds a reason flag", async () => {
    await todoFlag("tok", "C1", "1.1", "blocked", cfg, false);
    expect(calls).toEqual(["add:lock"]);
  });
  test("waiting and blocked are distinct flags, and stack", async () => {
    await todoFlag("tok", "C1", "1.1", "waiting", cfg, false);
    expect(calls).toEqual(["add:speech_balloon"]);
    await todoFlag("tok", "C1", "1.1", "blocked", cfg, false);
    expect(calls).toEqual(["add:speech_balloon", "add:lock"]);
    // Clearing one leaves the other alone — no implicit exclusivity.
    await todoFlag("tok", "C1", "1.1", "waiting", cfg, true);
    expect(calls).toEqual([
      "add:speech_balloon", "add:lock",
      "remove:speech_balloon:start", "remove:speech_balloon:end",
    ]);
  });
  test("a reason flag never touches progress reactions", async () => {
    await todoFlag("tok", "C1", "1.1", "waiting", cfg, false);
    expect(calls.some((c) => /white_check_mark|no_entry_sign|eyes|hourglass/.test(c))).toBe(false);
  });
  test("removes a reason flag", async () => {
    await todoFlag("tok", "C1", "1.1", "alert", cfg, true);
    expect(calls).toEqual(["remove:exclamation:start", "remove:exclamation:end"]);
  });
});

// ──────────────────────────────────────────────────────────
// (c) rate-limit retry — sleeps retryAfter, never real time
// ──────────────────────────────────────────────────────────

describe("withRateLimitRetry", () => {
  test("waits retryAfter seconds and retries", async () => {
    const slept: number[] = [];
    const spy = vi.spyOn(_internals, "sleep").mockImplementation(async (ms: number) => { slept.push(ms); });
    let n = 0;
    const out = await withRateLimitRetry("t", async () => {
      if (n++ < 2) throw new RateLimitError(3);
      return "ok";
    });
    expect(out).toBe("ok");
    expect(slept).toEqual([3000, 3000]);
    spy.mockRestore();
  });

  test("gives up loudly after the retry cap", async () => {
    const spy = vi.spyOn(_internals, "sleep").mockResolvedValue(undefined);
    await expect(
      withRateLimitRetry("search.messages", async () => { throw new RateLimitError(1); }, 2),
    ).rejects.toThrow(/gave up after 2 retries/);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test("non-429 errors pass straight through without sleeping", async () => {
    const spy = vi.spyOn(_internals, "sleep").mockResolvedValue(undefined);
    await expect(withRateLimitRetry("t", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("todoSet retries a rate-limited reactions.add without losing add→remove order", async () => {
    const spy = vi.spyOn(_internals, "sleep").mockResolvedValue(undefined);
    behaviour.reactionsGet = [{ name: "hourglass_flowing_sand", users: ["U_ME"] }];
    behaviour.addRateLimits = 1;
    await todoSet("tok", "C1", "1.1", "doing", cfg);
    expect(calls).toEqual([
      "auth.test", "get", "add:eyes:429", "add:eyes",
      "remove:hourglass_flowing_sand:start", "remove:hourglass_flowing_sand:end",
    ]);
    spy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────
// (d) cache — TTL expiry and corrupt-file fallback
// ──────────────────────────────────────────────────────────

// The rate-limit backoff must never wait real time under a test runner, and a
// spy is not enough to guarantee that: any nested `vi.restoreAllMocks()` undoes
// the stub, and the next test then sleeps for real. That is what wedged CI —
// this file consumed the entire job budget in the retry path while every other
// file finished in under two seconds.
describe("the backoff cannot sleep for real under a test runner", () => {
  test("a multi-second sleep returns immediately", async () => {
    // Deliberately NOT stubbed: this asserts the built-in guard, so it must
    // survive a restoreAllMocks that removed the file-wide spy.
    vi.restoreAllMocks();
    const t0 = Date.now();
    await _internals.sleep(3000);
    expect(Date.now() - t0).toBeLessThan(250);
  });
});

describe("cache", () => {
  let dir: string;
  let now = 1_000_000;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "todocache-"));
    now = 1_000_000;
    cacheMod.resetCacheForTests();
    vi.spyOn(cacheMod._internals, "path").mockReturnValue(join(dir, "cache.json"));
    vi.spyOn(cacheMod._internals, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips through the file and expires after the TTL", () => {
    cacheMod.cacheSet("channels", "T_ONE", "#general", "C123");
    expect(cacheMod.cacheGet("channels", "T_ONE", "#general")).toBe("C123");
    cacheMod.resetCacheForTests(); // force a re-read from disk
    expect(cacheMod.cacheGet("channels", "T_ONE", "#general")).toBe("C123");

    now += cacheMod.CACHE_TTL_MS + 1;
    expect(cacheMod.cacheGet("channels", "T_ONE", "#general")).toBeUndefined();
  });

  test("corrupt cache.json falls back to no cache instead of throwing", () => {
    writeFileSync(join(dir, "cache.json"), "{{{ not json");
    expect(() => cacheMod.cacheGet("users", "T_ONE", "U1")).not.toThrow();
    expect(cacheMod.cacheGet("users", "T_ONE", "U1")).toBeUndefined();
    // Still writable afterwards.
    cacheMod.cacheSet("users", "T_ONE", "U1", "sno");
    expect(cacheMod.cacheGet("users", "T_ONE", "U1")).toBe("sno");
  });

  test("an unwritable cache path is swallowed", () => {
    vi.spyOn(cacheMod._internals, "path").mockReturnValue("/proc/definitely/not/writable/cache.json");
    cacheMod.resetCacheForTests();
    expect(() => cacheMod.cacheSet("channels", "T_ONE", "#x", "C1")).not.toThrow();
  });

  test("--no-cache makes every lookup a miss", async () => {
    cacheMod.cacheSet("channels", "T_ONE", "#general", "C123");
    cacheMod.setCacheEnabled(false);
    expect(cacheMod.cacheGet("channels", "T_ONE", "#general")).toBeUndefined();
    let resolves = 0;
    const resolve = async () => { resolves++; return "C999"; };
    expect(await resolveChannelCached("tok", "#general", resolve)).toBe("C999");
    expect(await resolveChannelCached("tok", "#general", resolve)).toBe("C999");
    expect(resolves).toBe(2);
    cacheMod.setCacheEnabled(true);
  });

  test("resolveChannelCached resolves once, then serves from cache", async () => {
    cacheMod.setCacheEnabled(true);
    let resolves = 0;
    const resolve = async () => { resolves++; return "C123"; };
    expect(await resolveChannelCached("tok", "#general", resolve)).toBe("C123");
    expect(await resolveChannelCached("tok", "#general", resolve)).toBe("C123");
    expect(resolves).toBe(1);
  });

  test("entries are namespaced per workspace — same channel name, different team, no hit", async () => {
    cacheMod.setCacheEnabled(true);
    let resolves = 0;
    const resolve = async () => { resolves++; return resolves === 1 ? "C_ONE" : "C_TWO"; };

    // Workspace A caches #general → C_ONE.
    behaviour.teamId = "T_ONE";
    expect(await resolveChannelCached("tokA", "#general", resolve)).toBe("C_ONE");
    expect(await resolveChannelCached("tokA", "#general", resolve)).toBe("C_ONE");
    expect(resolves).toBe(1);

    // Workspace B must NOT be served A's ID — #general is a different channel there.
    behaviour.teamId = "T_TWO";
    expect(await resolveChannelCached("tokB", "#general", resolve)).toBe("C_TWO");
    expect(resolves).toBe(2);
    // …and A's entry is still intact and still A's.
    expect(cacheMod.cacheGet("channels", "T_ONE", "#general")).toBe("C_ONE");
    expect(cacheMod.cacheGet("channels", "T_TWO", "#general")).toBe("C_TWO");
  });

  test("user IDs are namespaced per workspace too", () => {
    cacheMod.setCacheEnabled(true);
    cacheMod.cacheSet("users", "T_ONE", "U1", "alice");
    expect(cacheMod.cacheGet("users", "T_TWO", "U1")).toBeUndefined();
    expect(cacheMod.cacheGet("users", "T_ONE", "U1")).toBe("alice");
  });

  test("an unknown workspace (empty scope) is always a miss, never a cross-workspace hit", () => {
    cacheMod.setCacheEnabled(true);
    cacheMod.cacheSet("channels", "", "#general", "C_ONE");
    expect(cacheMod.cacheGet("channels", "", "#general")).toBeUndefined();
  });

  test("cacheScope returns \"\" when auth.test fails, so lookups run uncached", async () => {
    cacheMod.setCacheEnabled(true);
    // Driven through the factory's own state rather than a spy on the mocked
    // module: bun cannot restore a spy installed on a mocked module's namespace,
    // and the un-restored stub then returns undefined for every later test.
    behaviour.authFails = new Error("invalid_auth");
    resetSelfIdForTests();
    let resolves = 0;
    const resolve = async () => { resolves++; return "C1"; };
    expect(await resolveChannelCached("tok", "#general", resolve)).toBe("C1");
    expect(await resolveChannelCached("tok", "#general", resolve)).toBe("C1");
    expect(resolves).toBe(2); // nothing was cached
    behaviour.authFails = undefined;
  });

  test("userHandleCached resolves once, then serves from cache", async () => {
    cacheMod.setCacheEnabled(true);
    let lookups = 0;
    const lookup = async () => { lookups++; return "alice"; };
    expect(await userHandleCached("tok", "U1", lookup)).toBe("alice");
    expect(await userHandleCached("tok", "U1", lookup)).toBe("alice");
    expect(lookups).toBe(1);
    expect(cacheMod.cacheGet("users", "T_ONE", "U1")).toBe("alice");
  });

  test("userHandleCached does not persist a failed resolution (handle === raw ID)", async () => {
    cacheMod.setCacheEnabled(true);
    let lookups = 0;
    const lookup = async () => { lookups++; return "U1"; }; // users.info fell back to the ID
    expect(await userHandleCached("tok", "U1", lookup)).toBe("U1");
    expect(cacheMod.cacheGet("users", "T_ONE", "U1")).toBeUndefined();
    await userHandleCached("tok", "U1", lookup);
    expect(lookups).toBe(2);
  });

  // A bot's timezone is a false signal: Slack hands out America/Los_Angeles by
  // default (12 of this workspace's 14 bots report it), and a bot has no phone
  // to buzz. Warning "it's the middle of the night in California" for a bot DM
  // is noise, and noise is what stops a warning from being read.
  test("userTzCached treats a bot's timezone as unknown", async () => {
    cacheMod.setCacheEnabled(true);
    const lookup = async () => ({ user: { is_bot: true, tz: "America/Los_Angeles" } });
    expect(await userTzCached("tok", "U_BOT", lookup)).toBe(null);
  });

  // USLACKBOT is the one account where the flag and the reality disagree: it
  // reports is_bot=false while carrying the same default zone. An is_bot-only
  // guard sails straight past it.
  test("userTzCached treats USLACKBOT as unknown despite is_bot=false", async () => {
    cacheMod.setCacheEnabled(true);
    const lookup = async () => ({ user: { is_bot: false, tz: "America/Los_Angeles" } });
    expect(await userTzCached("tok", "USLACKBOT", lookup)).toBe(null);
  });

  test("userTzCached returns a real person's zone and caches it", async () => {
    cacheMod.setCacheEnabled(true);
    let lookups = 0;
    const lookup = async () => { lookups++; return { user: { is_bot: false, tz: "Asia/Tokyo" } }; };
    expect(await userTzCached("tok", "U_HUMAN", lookup)).toBe("Asia/Tokyo");
    expect(await userTzCached("tok", "U_HUMAN", lookup)).toBe("Asia/Tokyo");
    expect(lookups).toBe(1);
  });

  // Slack Connect counterparts have no `tz` KEY at all. Caching that as "?" is
  // what stops us re-asking on every single send for people who will never have
  // one — and they are the majority of external DMs.
  test("userTzCached caches a missing timezone so it is not re-asked", async () => {
    cacheMod.setCacheEnabled(true);
    let lookups = 0;
    const lookup = async () => { lookups++; return { user: { is_bot: false } }; };
    expect(await userTzCached("tok", "U_EXT", lookup)).toBe(null);
    expect(await userTzCached("tok", "U_EXT", lookup)).toBe(null);
    expect(lookups).toBe(1);
  });

  // A missing users:read scope must degrade the clock label, never block a send.
  test("userTzCached swallows a lookup failure", async () => {
    cacheMod.setCacheEnabled(true);
    const lookup = async () => { throw new Error("missing_scope"); };
    expect(await userTzCached("tok", "U_ERR", lookup)).toBe(null);
  });

  test("raw IDs and permalinks bypass the cache entirely", async () => {
    cacheMod.setCacheEnabled(true);
    let resolves = 0;
    const resolve = async () => { resolves++; return "C123"; };
    await resolveChannelCached("tok", "C00000001", resolve);
    await resolveChannelCached("tok", "C00000001", resolve);
    expect(resolves).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────
// (e) doctor — detection, add→remove repair, no silent truncation
// ──────────────────────────────────────────────────────────

describe("todoDoctor", () => {
  test("reports messages carrying two or more of my progress reactions", async () => {
    behaviour.historyPages = [{
      messages: [
        { ts: "1.1", text: "two states", reactions: [
          { name: "eyes", users: ["U_ME"] }, { name: "white_check_mark", users: ["U_ME"] },
        ] },
        { ts: "2.2", text: "clean", reactions: [{ name: "eyes", users: ["U_ME"] }] },
        { ts: "3.3", text: "others only", reactions: [
          { name: "eyes", users: ["U_OTHER"] }, { name: "hourglass_flowing_sand", users: ["U_OTHER"] },
        ] },
      ],
    }];
    const r = await todoDoctor("tok", "C1", cfg);
    expect(r.findings.map((f) => f.ts)).toEqual(["1.1"]);
    expect(r.findings[0]!.keep).toBe("white_check_mark"); // highest priority wins
    expect(r.findings[0]!.emoji).toEqual(["white_check_mark", "eyes"]);
    expect(r.truncated).toBe(false);
    expect(calls.filter((c) => c.startsWith("add:") || c.startsWith("remove:"))).toEqual([]);
  });

  test("(e) --fix re-asserts the winner BEFORE removing losers, serially", async () => {
    behaviour.historyPages = [{
      messages: [{ ts: "1.1", text: "x", reactions: [
        { name: "eyes", users: ["U_ME"] },
        { name: "hourglass_flowing_sand", users: ["U_ME"] },
        { name: "white_check_mark", users: ["U_ME"] },
      ] }],
    }];
    behaviour.addFails = new Error("Slack error on reactions.add: already_reacted");
    const r = await todoDoctor("tok", "C1", cfg, { fix: true });
    expect(r.findings[0]!.fixed).toBe(true);
    const mutations = calls.filter((c) => c.startsWith("add:") || c.startsWith("remove:"));
    expect(mutations).toEqual([
      "add:white_check_mark",
      "remove:eyes:start", "remove:eyes:end",
      "remove:hourglass_flowing_sand:start", "remove:hourglass_flowing_sand:end",
    ]);
  });

  test("--fix surfaces a failed repair instead of claiming success", async () => {
    behaviour.historyPages = [{
      messages: [{ ts: "1.1", text: "x", reactions: [
        { name: "eyes", users: ["U_ME"] }, { name: "white_check_mark", users: ["U_ME"] },
      ] }],
    }];
    behaviour.addFails = new Error("Slack error on reactions.add: missing_scope");
    const r = await todoDoctor("tok", "C1", cfg, { fix: true });
    expect(r.findings[0]!.fixed).toBe(false);
    expect(r.findings[0]!.error).toMatch(/missing_scope/);
  });

  test("pages sequentially and flags truncation at the scan limit", async () => {
    const page = (ts: string) => ({
      messages: [{ ts, text: "x", reactions: [] }],
      response_metadata: { next_cursor: "more" },
    });
    behaviour.historyPages = [page("1.1"), page("2.2"), page("3.3")];
    const r = await todoDoctor("tok", "C1", cfg, { limit: 2 });
    expect(r.scanned).toBe(2);
    expect(r.truncated).toBe(true);
    expect(calls.filter((c) => c === "history").length).toBe(2);
  });

  test("an empty page with a cursor terminates instead of spinning", async () => {
    behaviour.historyPages = [{ messages: [], response_metadata: { next_cursor: "more" } }];
    const r = await todoDoctor("tok", "C1", cfg, { limit: 100 });
    expect(r.scanned).toBe(0);
    expect(calls.filter((c) => c === "history").length).toBe(1);
  });

  test("stops cleanly (untruncated) when history runs out", async () => {
    behaviour.historyPages = [{ messages: [{ ts: "1.1", text: "x", reactions: [] }] }];
    const r = await todoDoctor("tok", "C1", cfg, { limit: 100 });
    expect(r.scanned).toBe(1);
    expect(r.truncated).toBe(false);
  });
});
