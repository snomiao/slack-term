// Unit tests for the Slack-free half of `slack pinlog` (ts/pinlog.ts): the
// footer marker that makes a message a board, its JST stamp, and the local
// name registry. The commands themselves are covered in pinlog-cli.test.ts.

import { describe, test, expect, afterAll } from "./harness.ts";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeArg, unescapeArg } from "../ts/escapes.ts";
import {
  LockBusyError,
  PINLOG_MARKER,
  acquireLock,
  composeHead,
  formatJst,
  headUpdatedAt,
  isPinlogHead,
  loadRegistry,
  parsePinlogId,
  pinlogFooter,
  pinlogId,
  saveRegistryEntry,
  stripPinlogFooter,
  validPinlogName,
} from "../ts/pinlog.ts";

const dir = mkdtempSync(join(tmpdir(), "slack-pinlog-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("formatJst", () => {
  test("renders the JST wall clock, not the machine's", () => {
    // 06:10 UTC = 15:10 JST
    expect(formatJst(new Date("2026-10-08T06:10:00Z"))).toBe("2026-10-08 15:10 JST");
  });
  test("rolls the date over at JST midnight, with hour 00 (never 24)", () => {
    expect(formatJst(new Date("2026-10-08T15:00:00Z"))).toBe("2026-10-09 00:00 JST");
  });
});

describe("footer marker", () => {
  const now = new Date("2026-10-08T06:10:00Z");

  test("composeHead appends the footer after a blank line", () => {
    const head = composeHead("状態: 青", now);
    expect(head).toBe(`状態: 青\n\n_${PINLOG_MARKER} 2026-10-08 15:10 JST · 更新はスレッドに_`);
    expect(isPinlogHead(head)).toBe(true);
  });

  test("strip(compose(x)) gives x back", () => {
    const state = "1. 見積\n2. 契約\n   - 法務確認待ち";
    expect(stripPinlogFooter(composeHead(state, now))).toBe(state);
  });

  test("a state that already has a footer gets it replaced, not doubled", () => {
    const once = composeHead("A", now);
    const twice = composeHead(once, new Date("2026-10-08T07:00:00Z"));
    expect(twice.split(PINLOG_MARKER).length).toBe(2);
    expect(headUpdatedAt(twice)).toBe("2026-10-08 16:00 JST");
  });

  test("an ordinary message is not a HEAD", () => {
    expect(isPinlogHead("hello")).toBe(false);
    expect(headUpdatedAt("hello")).toBeNull();
  });

  test("quoting the marker mid-message does not make it a HEAD", () => {
    expect(isPinlogHead(`${pinlogFooter(now)}\nand then more text below`)).toBe(false);
  });

  // Codex review: the first regex needed neither a line start nor the
  // timestamp, so ordinary text mentioning the marker counted as a board and
  // strip() cut it off mid-sentence.
  test("text that merely MENTIONS the marker is neither a HEAD nor truncated", () => {
    const s = `Please explain ${PINLOG_MARKER} tomorrow`;
    expect(isPinlogHead(s)).toBe(false);
    expect(stripPinlogFooter(s)).toBe(s);
    const s2 = `a\n${PINLOG_MARKER} soon`;
    expect(isPinlogHead(s2)).toBe(false);
    expect(stripPinlogFooter(s2)).toBe(s2);
    expect(composeHead(s, now).startsWith(s)).toBe(true);
  });

  test("a footer whose italics a human removed still counts", () => {
    expect(isPinlogHead(`state\n\n${PINLOG_MARKER} 2026-10-08 15:10 JST · 更新はスレッドに`)).toBe(true);
  });
});

describe("ids and names", () => {
  test("parsePinlogId round-trips pinlogId", () => {
    expect(parsePinlogId(pinlogId("C00000001", "1700000000.000100"))).toEqual({ channel: "C00000001", ts: "1700000000.000100" });
  });
  test("parsePinlogId rejects names, #chan:ts and short ts", () => {
    expect(parsePinlogId("gtm-blockers")).toBeNull();
    expect(parsePinlogId("#gtm:1700000000.000100")).toBeNull();
    expect(parsePinlogId("C00000001:1700000000")).toBeNull();
  });
  test("validPinlogName", () => {
    expect(validPinlogName("gtm-blockers")).toBe(true);
    expect(validPinlogName("release.v2_1")).toBe(true);
    expect(validPinlogName("-x")).toBe(false);
    expect(validPinlogName("has space")).toBe(false);
    expect(validPinlogName("")).toBe(false);
  });
});

describe("escapeArg (for printed retry commands)", () => {
  test("unescapeArg(escapeArg(x)) === x, including literal escapes and yen", () => {
    for (const x of ["plain", "a\\nb", "real\nnewline", "tab\there", "¥1000", "¥n literal", "\\\\", "mix \\t ¥¥ \n end"]) {
      expect(unescapeArg(escapeArg(x))).toBe(x);
    }
  });
  test("the escaped form is one line", () => {
    expect(escapeArg("a\nb")).not.toContain("\n");
  });
});

describe("lock", () => {
  const ldir = join(dir, "locks");
  test("a second acquire is refused while the first holds it; release frees it", () => {
    const release = acquireLock("k1", { dir: ldir });
    expect(() => acquireLock("k1", { dir: ldir })).toThrow(LockBusyError);
    release();
    const again = acquireLock("k1", { dir: ldir });
    again();
    again(); // idempotent
  });
  test("a stale lock (dead holder) is broken", () => {
    const release = acquireLock("k2", { dir: ldir });
    const p = join(ldir, "k2.lock");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(p, old, old);
    const mine = acquireLock("k2", { dir: ldir, staleMs: 60_000 });
    mine();
    release(); // the original holder's release must not throw
  });
});

describe("registry", () => {
  test("a missing file is an empty registry", () => {
    expect(loadRegistry(join(dir, "none.json"))).toEqual({});
  });

  test("save then load", () => {
    const p = join(dir, "sub", "pinlogs.json");
    saveRegistryEntry("a", { channel: "C00000001", ts: "1700000000.000100", createdAt: "x" }, p);
    saveRegistryEntry("b", { channel: "C00000002", ts: "1700000000.000200", createdAt: "y" }, p);
    expect(Object.keys(loadRegistry(p)).sort()).toEqual(["a", "b"]);
    expect(loadRegistry(p).b!.channel).toBe("C00000002");
  });

  test("writes atomically (no temp file left) and refuses rebinding a name to another board", () => {
    const p = join(dir, "atomic", "pinlogs.json");
    saveRegistryEntry("x", { channel: "C00000001", ts: "1700000000.000100", createdAt: "a" }, p);
    // same board again is fine
    saveRegistryEntry("x", { channel: "C00000001", ts: "1700000000.000100", createdAt: "b" }, p);
    expect(() => saveRegistryEntry("x", { channel: "C00000002", ts: "1700000000.000200", createdAt: "c" }, p)).toThrow(/already points at/);
    expect(loadRegistry(p).x!.channel).toBe("C00000001");
    expect(readdirSync(join(dir, "atomic")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(dir, "atomic", "locks", "registry.lock"))).toBe(false);
  });

  // Fail-vs-absent: "no such name" for a file we could not read would send the
  // caller off to create a duplicate board.
  test("an unreadable file is an ERROR, not an empty registry", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    expect(() => loadRegistry(p)).toThrow(/unreadable/);
    writeFileSync(p, "[1,2]");
    expect(() => loadRegistry(p)).toThrow(/not a JSON object/);
  });
});
