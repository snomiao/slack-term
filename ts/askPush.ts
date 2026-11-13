// `slack ask --pending --push`: hand an answered question to the agent that
// asked it, instead of waiting for that agent to poll.
//
// Why: a pill pressed while the asker had moved on was never read back
// (2026-09-27: 13 of 71 asks). `--pending` lists them, but only to whoever
// runs it; a wrapper outside slack-hub pushed them over `ay`, and that now
// lives here instead. The sent-log already holds the asking
// agent's pid, so slack-hub can tell it directly.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pidAlive } from "./sentlog.ts";
import { hubEnv } from "./brand.ts";

/** ay rejects messages over 1024 chars. */
export const PUSH_MAX = 1000;

function clip(s: string, n: number): string {
  const one = s.split(/\s+/).filter(Boolean).join(" ");
  if (n <= 1) return "";
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

/** An answer this much older than its push is labelled late. */
export const PUSH_LATE_MS = 60 * 60_000;

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `[ask-answer]`, or — for an answer that is not new (a backfill, a lane that
 *  was down) — `[ask-answer, late: …]` with when it was given. A pill press
 *  carries no time in Slack, so a late one says when the question was asked. */
export function askPushTag(askedAtMs: number, answeredAtMs: number | undefined, nowMs = Date.now()): string {
  const since = answeredAtMs ?? askedAtMs;
  if (nowMs - since < PUSH_LATE_MS) return "[ask-answer]";
  return answeredAtMs !== undefined
    ? `[ask-answer, late: answered ${utc(answeredAtMs)}]`
    : `[ask-answer, late: asked ${utc(askedAtMs)}, pressed since]`;
}

/** The one-line message the asker receives: link, answer, how, question. */
export function askPushMessage(p: { link: string; answer: string; how: string; question: string; freeText: boolean; collected?: boolean; goneAsker?: number; tag?: string }): string {
  const head = `${p.tag ?? "[ask-answer]"} ${p.link} →`;
  const ans = clip(p.answer, 300);
  let tail = p.how ? ` (${p.how})` : "";
  if (p.freeText) tail += " — a free-text reply, not a choice: the question stays open";
  else if (p.collected) tail += " — collected ✅";
  if (p.goneAsker) tail += ` — asked by pid ${p.goneAsker}, now gone: sent to this lane by its directory`;
  const q = clip(p.question, PUSH_MAX - head.length - ans.length - tail.length - 8);
  return `${head} ${ans}${tail}. Q: ${q}`.slice(0, PUSH_MAX);
}

type Run = (cmd: string, args: string[]) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;
const runSync: Run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000 });

/** Parent pid, or 0. */
export function parentPid(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0;
  } catch {
    const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    return Number((r.stdout ?? "").trim()) || 0;
  }
}

/** Send `msg` to the agent at `pid` with `ay send --force`. The sent-log keeps
 *  the agent's own pid, while ay may know the wrapper above it, so up to three
 *  parents are tried too. Returns the pid that took it, or undefined. QUEUED
 *  and NOT SUBMITTED count as delivered: both reach the agent, and treating
 *  them as failures re-sent the same answer on every pass. */
export function notifyAgent(pid: number, msg: string, run: Run = runSync, parent = parentPid): number | undefined {
  for (let i = 0; i < 4 && pid > 1; i++, pid = parent(pid)) {
    const r = run(hubEnv("AY") || "ay", ["send", String(pid), "--force", msg]);
    if (r.error) return undefined; // no ay on this machine
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (/no agent matched/i.test(out)) continue;
    if (r.status === 0 || /QUEUED|sent to pid|NOT SUBMITTED/.test(out)) return pid;
  }
  return undefined;
}

/** Agents ay knows, or none when ay is missing or says something else. */
export function liveAgents(run: Run = runSync): { pid: number; cwd: string; started_at?: number }[] {
  const r = run(hubEnv("AY") || "ay", ["ls", "--json"]);
  try {
    const v = JSON.parse(r.stdout ?? "") as { pid?: unknown; cwd?: unknown; started_at?: unknown }[];
    return Array.isArray(v)
      ? v.flatMap((a) => (typeof a.pid === "number" && typeof a.cwd === "string" ? [{ pid: a.pid, cwd: a.cwd, ...(typeof a.started_at === "number" ? { started_at: a.started_at } : {}) }] : []))
      : [];
  } catch {
    return [];
  }
}

/** The live agent that took over a gone asker's lane: a lane restarts in the
 *  same directory, with a new pid. The newest one there wins. A shared
 *  directory (temp, home) says nothing about who asked, so it matches nobody. */
export function laneAgent(cwd: string, agents: { pid: number; cwd: string; started_at?: number }[], alive: (pid: number) => boolean = pidAlive): number | undefined {
  const dir = resolve(cwd);
  const tmp = resolve(tmpdir());
  if (dir === resolve(homedir()) || dir === tmp || dir.startsWith(`${tmp}/`)) return undefined;
  const here = agents.filter((a) => resolve(a.cwd.replace(/^~(?=\/|$)/, homedir())) === dir && alive(a.pid));
  return here.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0]?.pid;
}

/** One push pass at a time per machine: a watcher and a one-off run must not
 *  both push the same answer. Returns a release function, or undefined when a
 *  live pass holds the lock (a dead holder's lock is taken over). */
export function acquirePushLock(path: string): (() => void) | undefined {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(path); } catch { /* gone */ } };
    } catch {
      let holder = 0;
      try { holder = Number(readFileSync(path, "utf8").trim()); } catch { /* vanished */ }
      if (holder && holder !== process.pid && pidAlive(holder)) return undefined;
      try { unlinkSync(path); } catch { /* raced */ }
    }
  }
  return undefined;
}
