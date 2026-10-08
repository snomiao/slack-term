// Pinlog — a pinned status board in a Slack channel.
//
//   - The pinned TOP-LEVEL message is the current state (HEAD). It is edited in
//     place, so it is always the whole truth and never needs scrolling.
//   - Every change ALSO gets one short thread reply under it: the log.
//   - Edits are silent; replies notify. So people are pinged once per real
//     change, and the board itself never adds noise.
//
// This module is the part that needs no Slack: the footer marker that makes a
// message recognisable as a pinlog HEAD, the JST stamp in it, and the local
// name → id registry. The commands themselves live in cli.ts beside send/edit,
// because they share its confirm gate.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

// --- registry: --name → channel:ts -------------------------------------------

export type PinlogEntry = { channel: string; ts: string; team?: string; createdAt: string };
export type PinlogRegistry = Record<string, PinlogEntry>;

export function registryPath(): string {
  return join(process.env.HOME || homedir(), ".config", "slack-cli", "pinlogs.json");
}

/** Names are typed on a command line and used as the key of a JSON file. */
export function validPinlogName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** Load the registry. A missing file is an empty registry; an UNREADABLE one is
 *  an error, not an empty registry — answering "no such board" for a name that
 *  exists in a file we could not parse would send the caller off to create a
 *  duplicate board. */
export function loadRegistry(path = registryPath()): PinlogRegistry {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: unknown) {
    throw new Error(`pinlog registry ${path} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`pinlog registry ${path} is not a JSON object`);
  }
  return raw as PinlogRegistry;
}

/** Add `name` → `entry`. Locked read-modify-write plus an atomic rename, so two
 *  processes registering different names cannot drop each other's, and a
 *  reader never sees a half-written file. A name already bound to a DIFFERENT
 *  board is refused here too, not only in the caller's earlier check — two
 *  concurrent `create --name x` both pass that check. */
export function saveRegistryEntry(name: string, entry: PinlogEntry, path = registryPath()): void {
  const release = acquireLock("registry", { dir: join(dirname(path), "locks") });
  try {
    const reg = loadRegistry(path);
    const prev = reg[name];
    if (prev && (prev.channel !== entry.channel || prev.ts !== entry.ts)) {
      throw new Error(`name "${name}" already points at ${pinlogId(prev.channel, prev.ts)}`);
    }
    reg[name] = entry;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
    renameSync(tmp, path);
  } finally {
    release();
  }
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

/** Take an exclusive lock (O_EXCL file) or throw LockBusyError. A lock older
 *  than `staleMs` is from a process that died holding it and is broken. The
 *  returned release is idempotent and also runs on process exit, because the
 *  confirm gate leaves through `process.exit`.
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, `pid=${process.pid} since=${new Date().toISOString()}\n`);
      closeSync(fd);
      let held = true;
      const release = (): void => {
        if (!held) return;
        held = false;
        try { unlinkSync(path); } catch { /* already gone */ }
      };
      process.once("exit", release);
      return release;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age = 0;
      let holder = "another process";
      try {
        age = Date.now() - statSync(path).mtimeMs;
        holder = readFileSync(path, "utf8").trim() || holder;
      } catch {
        continue; // vanished between open and stat — just retry
      }
      if (age > staleMs && attempt === 0) {
        try { unlinkSync(path); } catch { /* raced with another breaker */ }
        continue;
      }
      throw new LockBusyError(holder);
    }
  }
  throw new LockBusyError("another process");
}

/** The id `create` prints and every other subcommand accepts. */
export function pinlogId(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

/** `C00000001:1700000000.000100` → parts; anything else → null (the caller then
 *  tries a registry name, then a #chan:ts / permalink). */
export function parsePinlogId(s: string): { channel: string; ts: string } | null {
  const m = s.match(/^([CDG][A-Z0-9]{8,}):(\d{10}\.\d{6})$/);
  return m ? { channel: m[1]!, ts: m[2]! } : null;
}
