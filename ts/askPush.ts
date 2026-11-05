// `slack ask --pending --push`: hand an answered question to the agent that
// asked it, instead of waiting for that agent to poll.
//
// Why: a pill pressed while the asker had moved on was never read back
// (2026-09-27: 13 of 71 asks). `--pending` lists them, but only to whoever
// runs it; a wrapper outside slack-term pushed them over `ay`, and that now
// lives here instead. The sent-log already holds the asking
// agent's pid, so slack-term can tell it directly.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive } from "./sentlog.ts";

/** ay rejects messages over 1024 chars. */
export const PUSH_MAX = 1000;

function clip(s: string, n: number): string {
  const one = s.split(/\s+/).filter(Boolean).join(" ");
  if (n <= 1) return "";
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

/** The one-line message the asker receives: link, answer, how, question. */
export function askPushMessage(p: { link: string; answer: string; how: string; question: string; freeText: boolean; collected?: boolean }): string {
  const head = `[ask-answer] ${p.link} →`;
  const ans = clip(p.answer, 300);
  let tail = p.how ? ` (${p.how})` : "";
  if (p.freeText) tail += " — a free-text reply, not a choice: the question stays open";
  else if (p.collected) tail += " — collected ✅";
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
    const r = run(process.env.SLACK_TERM_AY || "ay", ["send", String(pid), "--force", msg]);
    if (r.error) return undefined; // no ay on this machine
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (/no agent matched/i.test(out)) continue;
    if (r.status === 0 || /QUEUED|sent to pid|NOT SUBMITTED/.test(out)) return pid;
  }
  return undefined;
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
