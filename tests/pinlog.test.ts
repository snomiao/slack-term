// Unit tests for the Slack-free half of `slack pinlog` (ts/pinlog.ts): the
// footer marker that makes a message a board, its JST stamp, and the per-board
// lock. The commands themselves are covered in pinlog-cli.test.ts.

import { describe, test, expect, afterAll } from "./harness.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeArg, unescapeArg } from "../ts/escapes.ts";
import {
  LockBusyError,
  PINLOG_MARKER,
  acquireLock,
  breakStaleLock,
  composeHead,
  formatJst,
  headUpdatedAt,
  isPinlogHead,
  parsePinlogId,
  pinlogFooter,
  pinlogId,
  stripPinlogFooter,
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

describe("headUpdatedAt", () => {
  test("reads the trailing footer, not an older footer quoted in the state", () => {
    const quoted = "前回: _Pinlog · 最終更新 2026-01-01 09:00 JST · 更新はスレッドに_ のまま";
    const head = composeHead(quoted, new Date("2026-10-08T06:10:00Z"));
    expect(headUpdatedAt(head)).toBe("2026-10-08 15:10 JST");
    expect(headUpdatedAt("no footer")).toBeNull();
  });
});

describe("ids", () => {
  test("parsePinlogId round-trips pinlogId", () => {
    expect(parsePinlogId(pinlogId("C00000001", "1700000000.000100"))).toEqual({ channel: "C00000001", ts: "1700000000.000100" });
  });
  test("parsePinlogId rejects names, #chan:ts and short ts", () => {
    expect(parsePinlogId("gtm-blockers")).toBeNull();
    expect(parsePinlogId("#gtm:1700000000.000100")).toBeNull();
    expect(parsePinlogId("C00000001:1700000000")).toBeNull();
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
  test("a lock whose holder is DEAD is broken", () => {
    mkdirSync(ldir, { recursive: true });
    writeFileSync(join(ldir, "k2.lock"), "pid=2147483646 since=x nonce=n\n");
    const mine = acquireLock("k2", { dir: ldir });
    mine();
  });

  // Codex round 2: breaking by AGE let a slow but live holder run alongside
  // the breaker. A live holder is never broken, however old the file.
  test("a lock whose holder is ALIVE is not broken, however old", () => {
    mkdirSync(ldir, { recursive: true });
    const p = join(ldir, "k3.lock");
    writeFileSync(p, `pid=${process.pid} since=x nonce=n\n`);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(p, old, old);
    expect(() => acquireLock("k3", { dir: ldir, staleMs: 1 })).toThrow(LockBusyError);
    rmSync(p);
  });

  test("release never deletes a SUCCESSOR's lock", () => {
    const a = acquireLock("k4", { dir: ldir });
    const p = join(ldir, "k4.lock");
    // Someone (wrongly) broke A's lock and B took it.
    writeFileSync(p, `pid=${process.pid} since=y nonce=b\n`);
    a();
    expect(readFileSync(p, "utf8")).toContain("nonce=b");
    rmSync(p);
  });

  // Codex final review: two breakers judge the same dead lock; the faster one
  // takes a fresh lock; the slower one's unlink must not delete it.
  test("a late breaker leaves a NEW owner's lock alone", () => {
    mkdirSync(ldir, { recursive: true });
    const p = join(ldir, "k6.lock");
    const dead = "pid=2147483646 since=x nonce=dead\n";
    writeFileSync(p, `pid=${process.pid} since=y nonce=live\n`); // the faster breaker's new lock
    breakStaleLock(p, dead);
    expect(readFileSync(p, "utf8")).toContain("nonce=live");
    rmSync(p);
  });

  test("while another breaker holds the break mutex, acquire reports busy and touches nothing", () => {
    mkdirSync(ldir, { recursive: true });
    const p = join(ldir, "k7.lock");
    writeFileSync(p, "pid=2147483646 since=x nonce=dead\n");
    writeFileSync(`${p}.break`, "");
    expect(() => acquireLock("k7", { dir: ldir })).toThrow(LockBusyError);
    expect(readFileSync(p, "utf8")).toContain("nonce=dead");
    rmSync(`${p}.break`);
    acquireLock("k7", { dir: ldir })(); // mutex gone → the dead lock is broken
  });

  // Codex merge-gate review: clearing the break mutex by AGE let a live breaker
  // paused between compare and unlink lose it, and then delete a successor's
  // live lock. Only a provably dead owner's mutex is cleared.
  test("a live breaker's mutex is never cleared by age; a dead one's is", () => {
    mkdirSync(ldir, { recursive: true });
    const p = join(ldir, "k8.lock");
    const dead = "pid=2147483646 since=x nonce=dead\n";
    writeFileSync(p, dead);
    const old = new Date(Date.now() - 10 * 60_000);
    writeFileSync(`${p}.break`, `pid=${process.pid} nonce=paused\n`); // live, and old
    utimesSync(`${p}.break`, old, old);
    breakStaleLock(p, dead);
    expect(readFileSync(`${p}.break`, "utf8")).toContain("nonce=paused");
    expect(readFileSync(p, "utf8")).toBe(dead);
    writeFileSync(`${p}.break`, "pid=2147483646 nonce=crashed\n"); // dead owner, fresh
    breakStaleLock(p, dead);
    expect(() => readFileSync(`${p}.break`, "utf8")).toThrow();
    breakStaleLock(p, dead); // mutex free → the dead lock goes
    expect(() => readFileSync(p, "utf8")).toThrow();
  });

  test("a breaker releases only its own mutex", () => {
    mkdirSync(ldir, { recursive: true });
    const p = join(ldir, "k9.lock");
    breakStaleLock(p, "pid=2147483646 since=x nonce=dead\n"); // no lock at all: takes and releases the mutex
    expect(() => readFileSync(`${p}.break`, "utf8")).toThrow();
  });

  test("an unparsable lock is broken only after staleMs", () => {
    mkdirSync(ldir, { recursive: true });
    const p = join(ldir, "k5.lock");
    writeFileSync(p, "garbage");
    expect(() => acquireLock("k5", { dir: ldir, staleMs: 60_000 })).toThrow(LockBusyError);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(p, old, old);
    acquireLock("k5", { dir: ldir, staleMs: 60_000 })();
  });
});
