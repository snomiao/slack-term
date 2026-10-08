// Pinlog — a pinned status board in a Slack channel.
//
//   - The pinned TOP-LEVEL message is the current state (HEAD). It is edited in
//     place, so it is always the whole truth and never needs scrolling.
//   - Every change ALSO gets one short thread reply under it: the log.
//   - Edits are silent; replies notify. So people are pinged once per real
//     change, and the board itself never adds noise.
//
// This module is the part that needs no Slack: the footer marker that makes a
// message recognisable as a pinlog HEAD, and the JST stamp in it. Stateless by
// design: a board IS its message — addressed by permalink / C…:ts, found by
// its footer — so nothing about boards is kept on this machine. The commands themselves live in cli.ts beside send/edit,
// because they share its confirm gate.

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The words every HEAD ends with. `list` finds boards by this, and `update`
 *  refuses a message without it — editing an arbitrary message into a "board"
 *  by passing the wrong ts is the mistake this guards against. */
export const PINLOG_MARKER = "Pinlog · 最終更新";

/** `2026-10-08 15:10 JST`. Always JST: the board is read by one team in Japan,
 *  and a stamp whose zone depends on whichever machine last updated it would
 *  make two consecutive updates disagree about what time it is. */
export function formatJst(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const p = (t: string): string => parts.find((x) => x.type === t)?.value ?? "??";
  // en-GB renders midnight as "24" in some engines; normalise to 00.
  const hour = p("hour") === "24" ? "00" : p("hour");
  return `${p("year")}-${p("month")}-${p("day")} ${hour}:${p("minute")} JST`;
}

export function pinlogFooter(now: Date): string {
  return `_${PINLOG_MARKER} ${formatJst(now)} · 更新はスレッドに_`;
}

// The footer is the whole LAST line, exactly as `pinlogFooter` writes it — the
// underscores optional, since a human hand-editing the board in the Slack
// client may drop them. Anything looser (no line start, no timestamp) matches
// ordinary text that merely mentions the marker, and `stripPinlogFooter` would
// then cut that text off mid-sentence.
const FOOTER_RE = new RegExp(
  `(^|\\n+)_?${PINLOG_MARKER} \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} JST · 更新はスレッドに_?[ \\t]*\\n*$`,
);

/** True when `text` is a pinlog HEAD (carries the footer marker). */
export function isPinlogHead(text: string): boolean {
  return FOOTER_RE.test(text);
}

/** The state without its footer — what the owner wrote. */
export function stripPinlogFooter(text: string): string {
  return text.replace(FOOTER_RE, "");
}

/** The full HEAD text: the state, a blank line, the footer. A state that
 *  already carries a footer (copied from `show`) has it replaced, not doubled. */
export function composeHead(state: string, now: Date): string {
  return `${stripPinlogFooter(state).trimEnd()}\n\n${pinlogFooter(now)}`;
}

/** The "last updated" stamp in a HEAD's footer, or null when there is none. */
export function headUpdatedAt(text: string): string | null {
  const m = text.match(new RegExp(`${PINLOG_MARKER} (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} JST)`));
  return m ? m[1]! : null;
}

// --- lock: one writer per board on this machine -------------------------------

export class LockBusyError extends Error {
  constructor(public holder: string) {
    super(`locked by ${holder}`);
    this.name = "LockBusyError";
  }
}

export function lockDir(): string {
  return join(process.env.HOME || homedir(), ".config", "slack-cli", "locks");
}

/** Is the process that wrote a lock still running? Unknown → assume yes. */
function holderAlive(content: string): boolean {
  const m = content.match(/^pid=(\d+)/);
  if (!m) return true;
  try {
    process.kill(Number(m[1]), 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}

/** Remove `path` only if it still holds `deadContent`. Read-compare-unlink is not
 *  atomic, so two breakers could both judge the same dead lock, and the slower
 *  one's unlink would then delete the lock the faster one just took. Every
 *  non-owner unlink therefore happens under a second O_EXCL file (`.break`):
 *  the re-read and the unlink are serialised, and a breaker that comes second
 *  re-reads the NEW owner's content and leaves it alone. (Owners unlink their
 *  own lock without it: nobody breaks a live owner's lock.) */
export function breakStaleLock(path: string, deadContent: string): void {
  const mutex = `${path}.break`;
  let fd: number;
  try {
    fd = openSync(mutex, "wx");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // Another breaker is at it. A mutex left by a breaker that died mid-break
    // (a window of microseconds) is cleared after 10 s.
    try {
      if (Date.now() - statSync(mutex).mtimeMs > 10_000) unlinkSync(mutex);
    } catch { /* gone */ }
    return;
  }
  try {
    if (readFileSync(path, "utf8") === deadContent) unlinkSync(path);
  } catch { /* already gone */ } finally {
    closeSync(fd);
    try { unlinkSync(mutex); } catch { /* gone */ }
  }
}

/** Take an exclusive lock (O_EXCL file) or throw LockBusyError.
 *
 *  A lock is broken only when its holder is provably DEAD (no such pid) — age
 *  alone is not enough: a slow but live holder whose lock is broken would then
 *  run concurrently with the breaker, which is the race this exists to stop. A
 *  lock whose content cannot be parsed is broken after `staleMs`.
 *
 *  Each lock carries a unique nonce, and release unlinks only while the file
 *  still carries OURS — so a holder whose lock was (wrongly) broken can never
 *  delete its successor's lock on the way out. Release is idempotent and also
 *  runs on process exit, because the confirm gate leaves via `process.exit`.
 *
 *  Slack has no compare-and-swap on chat.update, so this is the only thing that
 *  keeps two confirmed updates from interleaving fetch → edit → log. It covers
 *  writers on THIS machine (the fleet runs on one); writers elsewhere are not
 *  serialised. */
export function acquireLock(key: string, opts: { dir?: string; staleMs?: number } = {}): () => void {
  const dir = opts.dir ?? lockDir();
  const staleMs = opts.staleMs ?? 120_000;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
  const content = `pid=${process.pid} since=${new Date().toISOString()} nonce=${Math.random().toString(36).slice(2)}${Date.now()}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, content);
      closeSync(fd);
      let held = true;
      const release = (): void => {
        if (!held) return;
        held = false;
        try {
          if (readFileSync(path, "utf8") === content) unlinkSync(path);
        } catch { /* already gone */ }
      };
      process.once("exit", release);
      return release;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let existing: string;
      let age: number;
      try {
        existing = readFileSync(path, "utf8");
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // vanished between open and read — just retry
      }
      const parsable = /^pid=\d+/.test(existing);
      const dead = parsable ? !holderAlive(existing) : age > staleMs;
      if (dead) {
        breakStaleLock(path, existing);
        continue;
      }
      throw new LockBusyError(existing.trim().replace(/ nonce=\S+/, "") || "another process");
    }
  }
  throw new LockBusyError("another process");
}

/** The id `create` prints and every other subcommand accepts. */
export function pinlogId(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

/** `C00000001:1700000000.000100` → parts; anything else → null (the caller then
 *  tries #chan:ts / permalink). */
export function parsePinlogId(s: string): { channel: string; ts: string } | null {
  const m = s.match(/^([CDG][A-Z0-9]{8,}):(\d{10}\.\d{6})$/);
  return m ? { channel: m[1]!, ts: m[2]! } : null;
}
