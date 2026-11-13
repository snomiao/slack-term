// .slack-hub/ scope: discovery, init, aliases in settings(.local).yml, the
// reply prefix rule and the wrong-thread check. Bun-only (Bun.YAML).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPrefix, findScope, initScope, listAliases, lookupAlias, readSettings, setAlias, threadMismatch, unsetAlias, validAliasName, withFileLock,
} from "../ts/scope.ts";

let root: string;
let home: string;
const prevHome = process.env.SLACK_HUB_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scope-"));
  home = join(root, "home");
  process.env.SLACK_HUB_HOME = home;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.SLACK_HUB_HOME;
  else process.env.SLACK_HUB_HOME = prevHome;
});

describe("findScope", () => {
  test("the nearest .slack-hub/ walking up, like .git", () => {
    initScope(join(root, "repo"));
    mkdirSync(join(root, "repo", "a", "b"), { recursive: true });
    expect(findScope(join(root, "repo", "a", "b"))).toEqual({ dir: join(root, "repo", ".slack-hub"), global: false });
  });
  test("a nested one wins over the outer one", () => {
    initScope(join(root, "repo"));
    initScope(join(root, "repo", "tree", "design"));
    expect(findScope(join(root, "repo", "tree", "design")).dir).toBe(join(root, "repo", "tree", "design", ".slack-hub"));
  });
  test("none above: the global dir", () => {
    mkdirSync(join(root, "bare"));
    expect(findScope(join(root, "bare"))).toEqual({ dir: home, global: true });
  });
});

describe("initScope", () => {
  test("creates README, .gitignore '*', settings.yml and the four dirs", () => {
    const { dir, created } = initScope(root, { prefix: "[design]" });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("slack alias set");
    for (const d of ["inbox", "archived", "outbox", "sent"]) expect(existsSync(join(dir, d))).toBe(true);
    expect(created).toContain("settings.yml");
    expect(readSettings(findScope(root)).prefix).toBe("[design]");
  });
  test("is idempotent and never overwrites", () => {
    const { dir } = initScope(root);
    writeFileSync(join(dir, "settings.yml"), 'prefix: "[mine]"\n');
    expect(initScope(root).created).toEqual([]);
    expect(readSettings(findScope(root)).prefix).toBe("[mine]");
  });
});

describe("settings", () => {
  test("an unquoted [lane] prefix (a YAML list) still reads as the prefix", () => {
    const { dir } = initScope(root);
    writeFileSync(join(dir, "settings.yml"), "prefix: [design]\nas_bot: true\n");
    expect(readSettings(findScope(root))).toEqual({ prefix: "[design]", as_bot: true });
  });
  test("settings.local.yml wins; subscriptions merge by name", () => {
    const { dir } = initScope(root);
    writeFileSync(join(dir, "settings.yml"), 'prefix: "[a]"\nsubscriptions:\n  x:\n    channel: C00000001\n  y:\n    channel: C00000002\n');
    writeFileSync(join(dir, "settings.local.yml"), 'prefix: "[b]"\nsubscriptions:\n  y:\n    channel: C00000003\n');
    const s = readSettings(findScope(root));
    expect(s.prefix).toBe("[b]");
    expect(s.subscriptions).toEqual({ x: { channel: "C00000001" }, y: { channel: "C00000003" } });
  });
  test("an unquoted thread_ts (a float, trailing zeros lost) is dropped, not mangled", () => {
    const { dir } = initScope(root);
    writeFileSync(join(dir, "settings.yml"), "subscriptions:\n  x:\n    channel: C00000001\n    thread_ts: 1700000000.000100\n");
    expect(readSettings(findScope(root)).subscriptions).toEqual({ x: { channel: "C00000001" } });
  });
});

describe("aliases", () => {
  test("set / list / lookup / unset round trip through settings.local.yml", () => {
    initScope(root);
    const scope = findScope(root);
    expect(setAlias(scope, "board", { channel: "C00000001", thread_ts: "1700000000.000100" })).toBeUndefined();
    const text = readFileSync(join(scope.dir, "settings.local.yml"), "utf8");
    expect(text).toContain('thread_ts: "1700000000.000100"');
    expect(listAliases(scope).map((a) => [a.name, a.channel, a.thread_ts, a.file])).toEqual([["board", "C00000001", "1700000000.000100", "settings.local.yml"]]);
    expect(lookupAlias("board", root)?.thread_ts).toBe("1700000000.000100");
    expect(setAlias(scope, "board", { channel: "C00000001", thread_ts: "1700000000.000200" })?.thread_ts).toBe("1700000000.000100");
    expect(unsetAlias(scope, "board")).toBe("removed");
    expect(unsetAlias(scope, "board")).toBe("absent");
    expect(lookupAlias("board", root)).toBeUndefined();
  });
  test("an alias in settings.yml is not removed by unset", () => {
    const { dir } = initScope(root);
    writeFileSync(join(dir, "settings.yml"), "subscriptions:\n  x:\n    channel: C00000001\n");
    expect(unsetAlias(findScope(root), "x")).toBe("in-settings.yml");
  });
  test("lookup falls back from the nearest scope to the global one", () => {
    initScope(join(root, "repo"));
    setAlias({ dir: home, global: true }, "shared", { channel: "C00000009" });
    expect(lookupAlias("shared", join(root, "repo"))?.channel).toBe("C00000009");
  });
  test("names: lowercase, digits, . _ -; never a bare ts or a #/@ target", () => {
    for (const ok of ["board", "design-1", "a.b_c"]) expect(validAliasName(ok)).toBe(true);
    for (const bad of ["Board", "#general", "@alice", "1700000000.000100", "", "a:b", "x".repeat(65)]) expect(validAliasName(bad)).toBe(false);
  });
});

describe("withFileLock", () => {
  test("a stale lock (crashed writer) is taken over", () => {
    const p = join(root, "f.yml");
    writeFileSync(`${p}.lock`, "");
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${p}.lock`, old, old);
    expect(withFileLock(p, () => 42)).toBe(42);
    expect(existsSync(`${p}.lock`)).toBe(false);
  });
  test("a live lock makes the second writer wait, then fail", () => {
    const p = join(root, "g.yml");
    writeFileSync(`${p}.lock`, "");
    expect(() => withFileLock(p, () => 1, 60_000, 100)).toThrow(/held by another writer/);
  });
});

describe("applyPrefix (never '[lane] [lane]')", () => {
  for (const [given, want] of [
    ["hi", "[guide] hi"],
    ["[guide] hi", "[guide] hi"],
    ["[guide@host1]  hi", "[guide] hi"],
    ["  [guide] hi", "[guide] hi"],
    ["[guidex] hi", "[guide] [guidex] hi"],
    ["hi [guide]", "[guide] hi [guide]"],
    ["[shr] hi", "[guide] [shr] hi"],
    ["[guide]", ""],
  ] as const) {
    test(`${JSON.stringify(given)} → ${JSON.stringify(want)}`, () => expect(applyPrefix(given, "[guide]")).toBe(want));
  }
  test("no prefix: the text as given", () => expect(applyPrefix("[x] hi", undefined)).toBe("[x] hi"));
  test("a non-bracket prefix is not doubled either", () => expect(applyPrefix("🎨 hi", "🎨")).toBe("🎨 hi"));
});

describe("threadMismatch", () => {
  const answered = { channel: "C00000001", ts: "1700000000.000200", root: "1700000000.000100" };
  test("same channel and root: fine", () => expect(threadMismatch({ channel: "C00000001", threadTs: "1700000000.000100" }, answered)).toBeUndefined());
  test("another root: names both threads", () => {
    const why = threadMismatch({ channel: "C00000001", threadTs: "1700000000.000900" }, answered);
    expect(why).toContain("C00000001 thread 1700000000.000100");
    expect(why).toContain("C00000001 thread 1700000000.000900");
  });
  test("another channel, or top level: refused", () => {
    expect(threadMismatch({ channel: "C00000002", threadTs: "1700000000.000100" }, answered)).toBeDefined();
    expect(threadMismatch({ channel: "C00000001" }, answered)).toContain("(top level)");
  });
});
