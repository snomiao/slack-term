// Local record of every message this CLI posted or edited, and WHO posted it.
//
// Why this exists: an agent asked a question, the human answered it, and no one
// collected the answer. Finding which agent had asked took a grep over ~1.8 GB
// of session transcripts, then matching cwd and start time to a live pid
// (measured 2026-09-27). The sender is known for certain at the moment of
// sending — this file writes it down then, instead of reconstructing it later.
//
// Two places, on purpose:
//   - a local SQLite log (~/.config/slack-cli/sent.sqlite), which `slack sent`
//     and `slack ask --pending` read;
//   - Slack message `metadata` (event_type `slack_term_sent`), invisible to
//     readers but returned by the API, so a machine WITHOUT the log can still
//     attribute a message.
//
// Everything here is fail-soft. A message that was posted must never be
// reported as failed because the bookkeeping about it failed.
//
// Opt out with SLACK_TERM_ATTRIBUTION=off (no log, no metadata).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export type SentKind = "send" | "ask" | "edit" | "poll";

/** Who sent it. Every field is best-effort; a missing one is left undefined
 *  rather than guessed. */
export interface Attribution {
  /** The `slack` process itself — short-lived, kept for completeness. */
  pid: number;
  /** The long-lived agent process that ran `slack` — what "is the sender still
   *  alive?" has to check. */
  agentPid?: number;
  host: string;
  cwd: string;
  gitBranch?: string;
  /** claude-code, codex, … — see detectCli. */
  cli?: string;
  sessionId?: string;
}

export interface SentRow {
  id: number;
  kind: SentKind;
  team?: string | null;
  channel: string;
  target?: string | null;
  ts: string;
  thread_ts?: string | null;
  permalink?: string | null;
  text: string;
  sent_at: number;
  pid: number;
  agent_pid?: number | null;
  host?: string | null;
  cwd: string;
  git_branch?: string | null;
  cli?: string | null;
  session_id?: string | null;
  as_bot: number;
  collected_at?: number | null;
  answer?: string | null;
  answer_exit?: number | null;
  delivered_at?: number | null;
  /** WHICH answer was delivered — a clarification relayed first must not
   *  stop the later actual decision from being relayed too. */
  delivered_answer?: string | null;
}

export function attributionEnabled(): boolean {
  return !/^(0|off|false|no)$/i.test(process.env.SLACK_TERM_ATTRIBUTION ?? "");
}

// --- attribution -------------------------------------------------------------

/** Agent CLIs recognised by process name when no env var names them. */
const AGENT_PROCESS_NAMES: Record<string, string> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  "cursor-agent": "cursor-agent",
  aider: "aider",
  amp: "amp",
};

type Proc = { pid: number; ppid: number; comm: string };

function procInfo(pid: number): Proc | undefined {
  try {
    const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    const m = (r.stdout ?? "").trim().match(/^(\d+)\s+(.+)$/);
    if (!m) return undefined;
    return { pid, ppid: Number(m[1]), comm: basename(m[2]!.trim()) };
  } catch {
    return undefined;
  }
}

/** The nearest ancestor whose process name is a known agent CLI. */
function findAgentAncestor(): Proc | undefined {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const p = procInfo(pid);
    if (!p) return undefined;
    if (AGENT_PROCESS_NAMES[p.comm]) return p;
    pid = p.ppid;
  }
  return undefined;
}

function positiveInt(s: string | undefined): number | undefined {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Read the sender off the environment and process tree.
 *
 *  Env vars used, and only those verified against a real session (2026-09-27):
 *  Claude Code sets CLAUDE_CODE_SESSION_ID, CLAUDE_PID and AI_AGENT
 *  (`claude-code_<version>_agent`). Other CLIs are recognised by the process
 *  name of an ancestor; their session ids are not read because their variable
 *  names were not verified. A wrapper that knows better sets the overrides:
 *  SLACK_TERM_AGENT_CLI, SLACK_TERM_AGENT_SESSION, SLACK_TERM_AGENT_PID. */
export function captureAttribution(env: NodeJS.ProcessEnv = process.env): Attribution {
  const a: Attribution = { pid: process.pid, host: safeHostname(), cwd: process.cwd() };

  let cli = env.SLACK_TERM_AGENT_CLI || undefined;
  if (!cli && env.AI_AGENT) cli = env.AI_AGENT.split("_")[0] || undefined;
  if (!cli && env.CLAUDECODE === "1") cli = "claude-code";

  let agentPid = positiveInt(env.SLACK_TERM_AGENT_PID) ?? positiveInt(env.CLAUDE_PID);
  if (!agentPid || !cli) {
    const anc = findAgentAncestor();
    if (anc) {
      agentPid ??= anc.pid;
      cli ??= AGENT_PROCESS_NAMES[anc.comm];
    }
  }
  if (cli) a.cli = cli;
  if (agentPid) a.agentPid = agentPid;

  const session = env.SLACK_TERM_AGENT_SESSION || env.CLAUDE_CODE_SESSION_ID;
  if (session) a.sessionId = session;

  const branch = gitBranch(a.cwd);
  if (branch) a.gitBranch = branch;
  return a;
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "";
  }
}

function gitBranch(cwd: string): string | undefined {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 2000 });
    const b = r.status === 0 ? (r.stdout ?? "").trim() : "";
    return b || undefined;
  } catch {
    return undefined;
  }
}

/** Slack message metadata: invisible in the client, returned by the API
 *  (`include_all_metadata`). Only defined fields — Slack rejects nulls. */
export const METADATA_EVENT_TYPE = "slack_term_sent";

export function attributionMetadata(kind: SentKind, a: Attribution): { event_type: string; event_payload: Record<string, string | number> } {
  const p: Record<string, string | number> = { kind, pid: a.pid, host: a.host, cwd: a.cwd };
  if (a.agentPid) p.agent_pid = a.agentPid;
  if (a.gitBranch) p.git_branch = a.gitBranch;
  if (a.cli) p.cli = a.cli;
  if (a.sessionId) p.session_id = a.sessionId;
  return { event_type: METADATA_EVENT_TYPE, event_payload: p };
}

// --- the database ------------------------------------------------------------

/** The subset of bun:sqlite / node:sqlite both provide. */
interface Stmt { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; }
interface Db { exec(sql: string): void; prepare(sql: string): Stmt; close(): void; }

export function sentDbPath(): string {
  if (process.env.SLACK_TERM_SENT_DB) return process.env.SLACK_TERM_SENT_DB;
  return join(process.env.HOME || homedir(), ".config", "slack-cli", "sent.sqlite");
}

function openSqlite(path: string): Db | undefined {
  // bun:sqlite under bun (how the tests and `bun run` execute), node:sqlite
  // under node 22.5+ (the published dist build). Neither → no log, said once.
  try {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      return new Database(path, { create: true }) as unknown as Db;
    }
    const mod = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as
      | { DatabaseSync: new (p: string) => Db }
      | undefined;
    if (mod?.DatabaseSync) return new mod.DatabaseSync(path);
  } catch {
    // fall through
  }
  return undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  team TEXT,
  channel TEXT NOT NULL,
  target TEXT,
  ts TEXT NOT NULL,
  thread_ts TEXT,
  permalink TEXT,
  text TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  agent_pid INTEGER,
  host TEXT,
  cwd TEXT NOT NULL,
  git_branch TEXT,
  cli TEXT,
  session_id TEXT,
  as_bot INTEGER NOT NULL DEFAULT 0,
  collected_at INTEGER,
  answer TEXT,
  answer_exit INTEGER,
  delivered_at INTEGER,
  delivered_answer TEXT
);
CREATE INDEX IF NOT EXISTS sent_msg ON sent(channel, ts);
CREATE INDEX IF NOT EXISTS sent_at ON sent(sent_at);
`;

export function openSentLog(): Db | undefined {
  const path = sentDbPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // openSqlite reports it
  }
  const db = openSqlite(path);
  if (!db) return undefined;
  // Owner-only: the log holds full outgoing text, DMs and private channels
  // included, plus session ids. Applied on every open so a log created before
  // this (or under a loose umask) is tightened too.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  try {
    db.exec(SCHEMA);
    // Columns added after the table first shipped. ALTER fails harmlessly when
    // the column is already there.
    try { db.exec("ALTER TABLE sent ADD COLUMN delivered_answer TEXT"); } catch { /* exists */ }
    return db;
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return undefined;
  }
}

export interface RecordSent {
  kind: SentKind;
  team?: string | undefined;
  channel: string;
  target?: string | undefined;
  ts: string;
  threadTs?: string | undefined;
  permalink?: string | undefined;
  text: string;
  asBot?: boolean | undefined;
  attribution: Attribution;
}

/** Append one row. Never throws — returns false and warns on stderr instead. */
export function recordSent(r: RecordSent): boolean {
  if (!attributionEnabled()) return false;
  const db = openSentLog();
  if (!db) {
    console.error(`  (送信ログに記録できませんでした: ${SENT_LOG_UNAVAILABLE} — ${sentDbPath()})`);
    return false;
  }
  try {
    const a = r.attribution;
    db.prepare(
      `INSERT INTO sent (kind, team, channel, target, ts, thread_ts, permalink, text, sent_at, pid, agent_pid, host, cwd, git_branch, cli, session_id, as_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.kind, r.team ?? null, r.channel, r.target ?? null, r.ts, r.threadTs ?? null, r.permalink ?? null, r.text,
      Date.now(), a.pid, a.agentPid ?? null, a.host || null, a.cwd, a.gitBranch ?? null, a.cli ?? null, a.sessionId ?? null,
      r.asBot ? 1 : 0,
    );
    return true;
  } catch (e: unknown) {
    console.error(`  (送信ログに記録できませんでした: ${e instanceof Error ? e.message : String(e)})`);
    return false;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// --- querying ----------------------------------------------------------------

export interface SentQuery {
  text?: string;
  channel?: string;
  sinceMs?: number;
  session?: string;
  cwd?: string;
  kind?: SentKind;
  limit?: number;
}

/** Newest first. `channel` matches the id or the target as typed (`#eng`, `@bob`);
 *  `session` and `cwd` are prefix matches; `text` is a case-insensitive substring. */
/** Why the log cannot be opened in this runtime — the storage is SQLite, which
 *  needs bun or node ≥ 22.5 (`node:sqlite`). Surfaced by `slack sent`, which
 *  must not answer "no matches" when the truth is "no log". */
export const SENT_LOG_UNAVAILABLE =
  "送信ログを開けません: SQLite が使えないランタイムです (bun、または node >= 22.5 の node:sqlite が必要)";

/** Newest first, or `undefined` when the log cannot be opened at all. */
export function querySent(q: SentQuery): SentRow[] | undefined {
  const db = openSentLog();
  if (!db) return undefined;
  try {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.text) { where.push("text LIKE ? ESCAPE '\\'"); params.push(`%${likeEscape(q.text)}%`); }
    if (q.channel) { where.push("(channel = ? OR target = ?)"); params.push(q.channel, q.channel); }
    if (q.sinceMs !== undefined) { where.push("sent_at >= ?"); params.push(q.sinceMs); }
    if (q.session) { where.push("session_id LIKE ? ESCAPE '\\'"); params.push(`${likeEscape(q.session)}%`); }
    if (q.cwd) { where.push("cwd LIKE ? ESCAPE '\\'"); params.push(`${likeEscape(q.cwd)}%`); }
    if (q.kind) { where.push("kind = ?"); params.push(q.kind); }
    const sql = `SELECT * FROM sent${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sent_at DESC, id DESC LIMIT ?`;
    params.push(q.limit ?? 50);
    return db.prepare(sql).all(...params) as SentRow[];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `30m`, `2h`, `7d`, `1w`, or an ISO date/time → epoch ms. Undefined if unreadable. */
export function parseSince(s: string, now = Date.now()): number | undefined {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i);
  if (m) {
    const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]!.toLowerCase() as "s"]!;
    return now - Number(m[1]) * unit;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

// --- ask collection ----------------------------------------------------------

/** Mark a logged ask as collected — its answer reached the caller. What
 *  `ask --pending` keys "answered but nobody heard" off. A no-op when the ask
 *  is not in this machine's log (asked elsewhere) or already collected. */
export function markAskCollected(channel: string, ts: string, answer: string, exit: number): void {
  if (!attributionEnabled()) return;
  const db = openSentLog();
  if (!db) return;
  try {
    db.prepare(
      `UPDATE sent SET collected_at = ?, answer = ?, answer_exit = ?
       WHERE kind = 'ask' AND channel = ? AND ts = ? AND collected_at IS NULL`,
    ).run(Date.now(), answer, exit, channel, ts);
  } catch {
    // bookkeeping only
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export function markAskDelivered(id: number, answer: string): void {
  const db = openSentLog();
  if (!db) return;
  try {
    db.prepare(`UPDATE sent SET delivered_at = ?, delivered_answer = ? WHERE id = ?`).run(Date.now(), answer, id);
  } catch {
    // bookkeeping only
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** Logged asks nobody has collected yet, oldest first. */
export function uncollectedAsks(sinceMs: number): SentRow[] {
  const db = openSentLog();
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT * FROM sent WHERE kind = 'ask' AND collected_at IS NULL AND sent_at >= ? ORDER BY sent_at ASC, id ASC`,
    ).all(sinceMs) as SentRow[];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** Is the agent that sent this row still the process at that pid? A pid alone
 *  is not enough — pids are reused, and delivering an answer to whatever now
 *  holds the number would hand a decision to the wrong agent. So the process
 *  must also (a) have started before the message was sent, and (b) carry the
 *  process name of the recorded CLI, when that CLI is one we know by name. */
export function senderAlive(row: Pick<SentRow, "agent_pid" | "pid" | "cli" | "sent_at">): boolean {
  const pid = row.agent_pid ?? row.pid;
  if (!pidAlive(pid)) return false;
  try {
    const r = spawnSync("ps", ["-o", "lstart=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    const line = (r.stdout ?? "").trim();
    // lstart is a fixed 24-char date ("Sun Sep 27 10:00:00 2026"), comm follows.
    const started = Date.parse(line.slice(0, 24));
    if (!Number.isNaN(started) && started > row.sent_at + 1000) return false;
    const comm = basename(line.slice(24).trim());
    const known = new Set(Object.values(AGENT_PROCESS_NAMES));
    if (row.cli && known.has(row.cli) && comm && AGENT_PROCESS_NAMES[comm] !== row.cli) return false;
  } catch {
    // ps unavailable: fall back to the bare pid check
  }
  return true;
}

/** Is this pid still running? `kill(pid, 0)` checks without signalling;
 *  EPERM means it exists but belongs to someone else — still alive. */
export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as { code?: string }).code === "EPERM";
  }
}
