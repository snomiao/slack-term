// .slack-hub/ inbox and outbox: one file per message, written tmp + rename.
//
// inbox/<channel>-<ts>.yml  a text-only notification (who, where, text,
//   permalink; attachments only counted). Secrets are redacted before it is
//   written — `slack read <permalink>` fetches the real thing live.
//   Handled = moved to archived/: by `slack done`, or by an outbox message
//   sent with in_reply_to: <its ts>.
// outbox/<name>.yml  {to, text, in_reply_to?}. `slack outbox flush` sends
//   them (behind the --code gate) and moves each to sent/ with its ts and
//   permalink; a failure stays in outbox/ with `error` and `attempts`.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.ts";
import { atomicWrite, readSettings, registeredScopes, setAlias, whoSubscribes, type Alias, type Scope } from "./scope.ts";

export type InboxEntry = {
  ts: string;
  channel: string;
  channel_name?: string;
  /** The thread root; absent for a top-level message. */
  thread_ts?: string;
  user: string;
  user_name?: string;
  text: string;
  /** Rule ids of what was redacted from `text`. */
  redacted?: string[];
  /** Attachments are never downloaded, only counted. */
  files?: number;
  permalink: string;
  /** The subscription that routed it here. */
  alias: string;
  received_at: string;
  /** When `slack inbox nudge --eyes` put 👀 on it: never twice. */
  nudged_at?: string;
};

/** What a stream hands over (its StreamMatch, plus the attachment count). */
export type Incoming = {
  channel: { id: string; name: string };
  ts: string;
  thread_ts: string | null;
  user: { id: string; name: string };
  text: string;
  permalink: string;
  files?: number;
};

const TS_RE = /^\d{10}\.\d{6}$/;

export function inboxFileName(channel: string, ts: string): string {
  return `${channel}-${ts}.yml`;
}

function yaml(v: unknown): string {
  return Bun.YAML.stringify(v, null, 2) + "\n";
}

/** Write one entry, redacted. False when it is already there (inbox/ or archived/). */
export function writeInbox(scope: Scope, e: Omit<InboxEntry, "redacted">, known: readonly string[] = []): boolean {
  const name = inboxFileName(e.channel, e.ts);
  if (existsSync(join(scope.dir, "inbox", name)) || existsSync(join(scope.dir, "archived", name))) return false;
  const r = redact(e.text, { known });
  const entry: InboxEntry = { ...e, text: r.text, ...(r.kinds.length ? { redacted: r.kinds } : {}) };
  atomicWrite(join(scope.dir, "inbox", name), yaml(entry));
  return true;
}

/** Fan one incoming message out to every scope that subscribes it. A new
 *  top-level message in an `auto_subscribe` channel nobody subscribes is
 *  first subscribed (as `t-<ts>`) in the scopes that ask for it. Returns the
 *  scope dirs it was written to. */
export function deliver(m: Incoming, scopes = registeredScopes(), now = new Date(), known: readonly string[] = []): string[] {
  const root = m.thread_ts ?? m.ts;
  let subs: Alias[] = whoSubscribes(m.channel.id, root, scopes);
  if (!subs.length && !m.thread_ts) {
    for (const s of scopes) {
      if (!readSettings(s).auto_subscribe?.includes(m.channel.id)) continue;
      // settings.yml: auto_subscribe is the owner's own rule, so it writes as the owner.
      setAlias(s, `t-${m.ts}`, { channel: m.channel.id, thread_ts: m.ts, note: "auto: new top-level message" }, { shared: true, asOwner: true });
    }
    subs = whoSubscribes(m.channel.id, root, scopes);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of subs) {
    if (seen.has(a.scope.dir)) continue; // one file per scope, however many aliases match
    seen.add(a.scope.dir);
    const wrote = writeInbox(a.scope, {
      ts: m.ts, channel: m.channel.id, channel_name: m.channel.name,
      ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
      user: m.user.id, user_name: m.user.name, text: m.text,
      ...(m.files ? { files: m.files } : {}),
      permalink: m.permalink, alias: a.name, received_at: now.toISOString(),
    }, known);
    if (wrote) out.push(a.scope.dir);
  }
  return out;
}

export type Listed<T> = { file: string; entry: T; mtimeMs: number };

function listDir<T>(dir: string, parse: (v: unknown) => T | undefined): Listed<T>[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch {
    return [];
  }
  const out: Listed<T>[] = [];
  for (const f of names.sort()) {
    const p = join(dir, f);
    try {
      const entry = parse(Bun.YAML.parse(readFileSync(p, "utf8")));
      if (entry) out.push({ file: p, entry, mtimeMs: statSync(p).mtimeMs });
    } catch { /* half-moved or hand-broken: skip */ }
  }
  return out;
}

function asInbox(v: unknown): InboxEntry | undefined {
  const o = v as Partial<InboxEntry> | null;
  return o && typeof o.ts === "string" && typeof o.channel === "string" && typeof o.text === "string" ? (o as InboxEntry) : undefined;
}

export function listInbox(scope: Scope): Listed<InboxEntry>[] {
  return listDir(join(scope.dir, "inbox"), asInbox).sort((a, b) => Number(a.entry.ts) - Number(b.entry.ts));
}

/** Move an inbox entry to archived/: by file name/path, or by message ts. */
export function markDone(scope: Scope, ref: string): string | undefined {
  const items = listInbox(scope);
  const hit = TS_RE.test(ref)
    ? items.find((i) => i.entry.ts === ref)
    : items.find((i) => i.file === ref || i.file.endsWith(`/${ref}`) || i.file.endsWith(`/${ref}.yml`));
  if (!hit) return undefined;
  const to = join(scope.dir, "archived", hit.file.slice(hit.file.lastIndexOf("/") + 1));
  renameSync(hit.file, to);
  return to;
}

// --- outbox ---

export type OutboxEntry = {
  /** alias | permalink | #chan:<ts> | C…:<ts> */
  to: string;
  text: string;
  /** ts of the inbox message this answers: archived once this is sent. */
  in_reply_to?: string;
  attempts?: number;
  error?: string;
};

function asOutbox(v: unknown): OutboxEntry | undefined {
  const o = v as Partial<OutboxEntry> | null;
  return o && typeof o.to === "string" && typeof o.text === "string" ? (o as OutboxEntry) : undefined;
}

export function listOutbox(scope: Scope): Listed<OutboxEntry>[] {
  return listDir(join(scope.dir, "outbox"), asOutbox);
}

/** Queue one message. The file name sorts by time, so flush keeps the order. */
export function addOutbox(scope: Scope, e: OutboxEntry, now = new Date()): { file: string; redacted: string[] } {
  const p = join(scope.dir, "outbox", `${now.toISOString().replace(/[:.]/g, "-")}-${process.pid}.yml`);
  // Redacted before it is written, like the inbox: a secret never reaches
  // the disk — nor, then, Slack.
  const r = redact(e.text);
  atomicWrite(p, yaml({ ...e, text: r.text }));
  return { file: p, redacted: r.kinds };
}

/** After Slack returned a ts: the sent/ record (text redacted), the outbox
 *  file gone, and the answered inbox entry archived. */
export function recordSent(scope: Scope, item: Listed<OutboxEntry>, sent: { ts: string; permalink: string; channel: string; thread_ts: string }, now = new Date()): string {
  const name = item.file.slice(item.file.lastIndexOf("/") + 1);
  const r = redact(item.entry.text);
  const { error: _e, ...rest } = item.entry;
  atomicWrite(join(scope.dir, "sent", name), yaml({ ...rest, text: r.text, ...(r.kinds.length ? { redacted: r.kinds } : {}), ...sent, sent_at: now.toISOString() }));
  unlinkSync(item.file);
  if (item.entry.in_reply_to) markDone(scope, item.entry.in_reply_to);
  return join(scope.dir, "sent", name);
}

/** A failed send stays in outbox/, with why and how often. */
export function recordFailure(item: Listed<OutboxEntry>, error: string): void {
  atomicWrite(item.file, yaml({ ...item.entry, attempts: (item.entry.attempts ?? 0) + 1, error }));
}

/** Inbox entries older than the scope's `nudge_after_min` (default 30). */
export function overdue(scope: Scope, nowMs = Date.now()): Listed<InboxEntry>[] {
  const min = readSettings(scope).nudge_after_min ?? 30;
  return listInbox(scope).filter((i) => nowMs - i.mtimeMs >= min * 60_000);
}

/** Record that an entry was nudged (👀 added), so a later run skips it. */
export function markNudged(item: Listed<InboxEntry>, now = new Date()): void {
  atomicWrite(item.file, yaml({ ...item.entry, nudged_at: now.toISOString() }));
  // The file's mtime is when it arrived (`overdue` waits from it): keep it, or
  // a nudged message would drop out of `nudge` for another nudge_after_min.
  const t = new Date(item.mtimeMs);
  utimesSync(item.file, t, t);
}
