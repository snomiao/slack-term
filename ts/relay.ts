#!/usr/bin/env bun
// slack ↔ agent-yes relay — one Slack channel as the remote control for a local
// `ay` fleet. Standalone on purpose (`bun run relay`), not a `slack` subcommand:
// it is agent-yes specific, runs as a long-lived daemon, and posts without the
// confirm gate — so it is hard-scoped to ONE configured channel instead.
//
// Inbound: only messages authored by the token owner (auth.test user_id, never
// a display name) are routed; everyone else in the channel is ignored. Routing:
//   "@otoji fix the build"   top-level → agent matched by repo / branch / pid
//   "fix the build"          top-level → the default agent
//   a reply in a thread       → whichever agent that thread is bound to
// Each forward is delivered with `ay send --force <pid>` behind a [slack-relay]
// prefix, and the Slack message gets 👀 (received) then ✅ (delivered).
//
// Outbound: the forwarded prompt tells the agent to append its reply to
// <outbox>/<pid>.md; the relay posts new outbox text into the agent's thread.
// Status edges (needs_input / exited, and idle when no reply was written) of
// agents that have a thread are posted there too, one short line each.
//
// The relay's own posts are authored by the same user, so they are skipped by
// ts (every ts it posts is remembered) and by the RELAY_MARK prefix.
//
// Config: ~/.config/slack-cli/relay.json (or --config), never in this repo:
//   { "workspace": "acme", "channel": "C00000001", "defaultAgent": "12345" }

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { authTest, history, reactionAdd, replies, send } from "./slack.ts";
import { resolveCookie, resolveToken } from "./profiles.ts";

const run = promisify(execFile);

export const RELAY_MARK = "🤖";
export const FORWARD_PREFIX = "[slack-relay]";

export type Agent = { pid: number; cwd: string; status: string; cli: string };
export type SlackMsg = { ts: string; user?: string; text?: string; subtype?: string; thread_ts?: string; bot_id?: string };

// ── pure logic (unit-tested) ────────────────────────────────────────────────

/** Only a plain message written by the token owner — and not by the relay
 *  itself — may become an instruction. Everything else is data. */
export function isInstruction(m: SlackMsg, selfId: string, ownTs: ReadonlySet<string>): boolean {
  if (!selfId || m.user !== selfId) return false;
  if (m.subtype !== undefined || m.bot_id !== undefined) return false;
  if (ownTs.has(m.ts)) return false;
  const text = (m.text ?? "").trim();
  return text !== "" && !text.startsWith(RELAY_MARK);
}

/** Split a leading `@name` route off a message. Slack user mentions (<@U…>)
 *  are not routes. */
export function parseRoute(text: string): { route?: string; body: string } {
  const m = text.trim().match(/^@([\w.\/-]+)[\s:,]+([\s\S]+)$/);
  if (!m) return { body: text.trim() };
  return { route: m[1]!.toLowerCase(), body: m[2]!.trim() };
}

/** "~/ws/<owner>/<repo>/tree/<branch>" → { repo, branch }; else basename. */
export function agentNames(cwd: string): { repo: string; branch: string } {
  const parts = cwd.split("/").filter(Boolean);
  const t = parts.lastIndexOf("tree");
  if (t > 0 && t < parts.length - 1) return { repo: parts[t - 1]!.toLowerCase(), branch: parts.slice(t + 1).join("/").toLowerCase() };
  return { repo: basename(cwd).toLowerCase(), branch: "" };
}

export function agentLabel(a: Agent): string {
  const { repo, branch } = agentNames(a.cwd);
  return branch && branch !== "main" ? `${repo}/${branch}` : repo;
}

/** Resolve a route to exactly one agent: pid, "repo/branch", "branch", or
 *  "repo" (ambiguous repos prefer the default agent, then the main tree). */
export function matchAgent(route: string, agents: Agent[], defaultPid?: number): { agent?: Agent; candidates: Agent[] } {
  const r = route.toLowerCase();
  if (/^\d+$/.test(r)) {
    const a = agents.find((x) => x.pid === Number(r));
    return a ? { agent: a, candidates: [a] } : { candidates: [] };
  }
  const exact = agents.filter((a) => {
    const { repo, branch } = agentNames(a.cwd);
    return `${repo}/${branch}` === r || agentLabel(a) === r || (branch !== "" && branch === r);
  });
  if (exact.length === 1) return { agent: exact[0]!, candidates: exact };
  const byRepo = exact.length > 1 ? exact : agents.filter((a) => agentNames(a.cwd).repo === r);
  if (byRepo.length === 1) return { agent: byRepo[0]!, candidates: byRepo };
  if (byRepo.length > 1) {
    const pick = byRepo.find((a) => a.pid === defaultPid) ?? byRepo.find((a) => agentNames(a.cwd).branch === "main");
    return pick ? { agent: pick, candidates: byRepo } : { candidates: byRepo };
  }
  return { candidates: [] };
}

export function forwardText(body: string, opts: { from: string; agentPid: number; outbox: string; permalink?: string }): string {
  const file = join(opts.outbox, `${opts.agentPid}.md`);
  return [
    `${FORWARD_PREFIX} message from ${opts.from} via Slack${opts.permalink ? ` (${opts.permalink})` : ""}:`,
    body,
    `— To answer in Slack, append a SHORT reply to ${file}, e.g.  cat >> ${file} <<'EOF' … EOF  (it is posted to the thread as-is; never put secrets in it).`,
  ].join("\n");
}

/** Keep outbound posts short: at most `maxLines` lines / `maxChars` chars. */
export function clip(text: string, maxLines = 15, maxChars = 2500): string {
  let t = text.trim();
  const lines = t.split("\n");
  if (lines.length > maxLines) t = lines.slice(0, maxLines).join("\n") + `\n… (+${lines.length - maxLines} lines)`;
  if (t.length > maxChars) t = t.slice(0, maxChars) + "…";
  return t;
}

// ── state ───────────────────────────────────────────────────────────────────

type State = {
  cursor: string;                         // newest top-level ts seen
  threads: Record<string, { pid: number; seen: string; touched: number }>; // thread_ts → agent
  agentThread: Record<string, string>;    // pid → latest thread_ts
  ownTs: string[];                        // ts the relay posted (loop guard)
  outboxOffset: Record<string, number>;   // pid → bytes consumed
  replied: Record<string, boolean>;       // pid → wrote outbox since last forward
};

const THREAD_TTL_MS = 24 * 3600_000;

function loadState(path: string): State {
  try { return JSON.parse(readFileSync(path, "utf8")) as State; } catch {
    return { cursor: "", threads: {}, agentThread: {}, ownTs: [], outboxOffset: {}, replied: {} };
  }
}

// ── side effects ────────────────────────────────────────────────────────────

async function listAgents(): Promise<Agent[]> {
  const { stdout } = await run("ay", ["ls", "--json"], { maxBuffer: 32 << 20 });
  const rows = JSON.parse(stdout) as Record<string, unknown>[];
  return rows
    .filter((r) => r.host === undefined || r.host === null || r.host === "local")
    .map((r) => ({ pid: Number(r.pid), cwd: String(r.cwd ?? ""), status: String(r.status ?? ""), cli: String(r.cli ?? "") }));
}

function log(...a: unknown[]): void {
  console.log(new Date().toISOString(), ...a);
}

export async function main(argv: string[]): Promise<void> {
  const ci = argv.indexOf("--config");
  const cfgPath = ci >= 0 && argv[ci + 1] ? argv[ci + 1]! : join(homedir(), ".config", "slack-cli", "relay.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { workspace?: string; channel: string; defaultAgent?: string; intervalMs?: number; stateDir?: string };
  if (!/^[CDG][A-Z0-9]{6,}$/.test(cfg.channel)) throw new Error(`relay.json: "channel" must be a channel ID, got ${cfg.channel}`);
  const CHANNEL = cfg.channel; // the ONLY channel this process ever reads or writes
  const token = resolveToken(cfg.workspace);
  const cookie = resolveCookie(cfg.workspace);
  const me = await authTest(token, cookie);
  if (!me.userId) throw new Error("auth.test returned no user_id");
  const stateDir = cfg.stateDir ?? join(homedir(), ".config", "slack-cli", "relay");
  const outbox = join(stateDir, "outbox");
  mkdirSync(outbox, { recursive: true });
  const statePath = join(stateDir, "state.json");
  const st = loadState(statePath);
  const ownTs = new Set(st.ownTs);
  const save = (): void => {
    st.ownTs = [...ownTs].slice(-500);
    writeFileSync(statePath, JSON.stringify(st, null, 1));
  };
  const intervalMs = cfg.intervalMs ?? 5000;
  log(`relay up: user=${me.userId} team=${me.teamId} channel=${CHANNEL} default=${cfg.defaultAgent ?? "-"} outbox=${outbox}`);

  if (!st.cursor) {
    // Start from "now": never replay old history as instructions.
    const h = (await history(token, CHANNEL, 1, undefined, undefined, cookie)) as { messages?: SlackMsg[] };
    st.cursor = h.messages?.[0]?.ts ?? String(Date.now() / 1000);
    save();
  }

  const post = async (text: string, threadTs?: string): Promise<string> => {
    const ts = await send(token, CHANNEL, `${RELAY_MARK} ${text}`, threadTs, false, cookie, true);
    if (ts) ownTs.add(ts);
    return ts;
  };
  const react = (ts: string, name: string): Promise<void> =>
    reactionAdd(token, CHANNEL, ts, name, cookie).catch((e: unknown) => log("react failed", name, String(e)));

  let agents: Agent[] = [];
  const lastStatus = new Map<number, string>();

  const deliver = async (m: SlackMsg, threadTs: string): Promise<void> => {
    const text = m.text ?? "";
    const bound = st.threads[threadTs];
    const { route, body } = parseRoute(text);
    let agent: Agent | undefined;
    if (route) {
      const r = matchAgent(route, agents, cfg.defaultAgent ? Number(cfg.defaultAgent) : undefined);
      agent = r.agent;
      if (!agent) {
        const names = (r.candidates.length ? r.candidates : agents).map((a) => `\`@${a.pid}\` ${agentLabel(a)}`).join(", ");
        await post(`no unique agent for \`@${route}\` — try one of: ${names}`, threadTs);
        return;
      }
    } else if (bound) {
      agent = agents.find((a) => a.pid === bound.pid);
    } else if (cfg.defaultAgent) {
      agent = agents.find((a) => a.pid === Number(cfg.defaultAgent));
    }
    if (!agent) {
      await post(`agent ${bound?.pid ?? cfg.defaultAgent ?? "?"} is not running — address one with \`@name …\``, threadTs);
      return;
    }
    await react(m.ts, "eyes");
    const msg = forwardText(route ? body : text.trim(), { from: `@${me.user}`, agentPid: agent.pid, outbox });
    try {
      await run("ay", ["send", "--force", String(agent.pid), msg], { timeout: 60_000 });
    } catch (e: unknown) {
      log("ay send failed", agent.pid, String(e).slice(0, 300));
      await post(`could not deliver to ${agentLabel(agent)} (${agent.pid}): ay send failed`, threadTs);
      return;
    }
    st.threads[threadTs] = { pid: agent.pid, seen: st.threads[threadTs]?.seen ?? threadTs, touched: Date.now() };
    st.agentThread[String(agent.pid)] = threadTs;
    st.replied[String(agent.pid)] = false;
    await react(m.ts, "white_check_mark");
    log(`→ ${agentLabel(agent)} (${agent.pid}) ts=${m.ts} ${JSON.stringify(body.slice(0, 80))}`);
  };

  const cycle = async (): Promise<void> => {
    agents = await listAgents().catch((e: unknown) => { log("ay ls failed", String(e)); return agents; });

    // 1) top-level messages
    const h = (await history(token, CHANNEL, 50, st.cursor, undefined, cookie)) as { messages?: SlackMsg[] };
    for (const m of (h.messages ?? []).slice().reverse()) {
      if (Number(m.ts) > Number(st.cursor)) st.cursor = m.ts;
      if (isInstruction(m, me.userId, ownTs)) await deliver(m, m.ts);
    }

    // 2) replies in threads the relay is tracking
    for (const [tts, th] of Object.entries(st.threads)) {
      if (Date.now() - th.touched > THREAD_TTL_MS) { delete st.threads[tts]; continue; }
      const r = (await replies(token, CHANNEL, tts, 100, cookie)) as { messages?: SlackMsg[] };
      for (const m of r.messages ?? []) {
        if (m.ts === tts || Number(m.ts) <= Number(th.seen)) continue;
        th.seen = m.ts;
        if (isInstruction(m, me.userId, ownTs)) await deliver(m, tts);
      }
    }

    // 3) outbox → thread
    for (const f of readdirSync(outbox).filter((x) => /^\d+\.md$/.test(x))) {
      const pid = f.replace(/\.md$/, "");
      const path = join(outbox, f);
      const size = statSync(path).size;
      const off = st.outboxOffset[pid] ?? 0;
      if (size <= off) { if (size < off) st.outboxOffset[pid] = 0; continue; }
      if (Date.now() - statSync(path).mtimeMs < 1500) continue; // let the write finish
      const chunk = readFileSync(path).subarray(off).toString("utf8");
      st.outboxOffset[pid] = size;
      const threadTs = st.agentThread[pid];
      const a = agents.find((x) => String(x.pid) === pid);
      const who = a ? agentLabel(a) : pid;
      if (!chunk.trim()) continue;
      await post(`*${who}*: ${clip(chunk)}`, threadTs);
      st.replied[pid] = true;
      log(`← ${who} (${pid}) ${chunk.trim().length} chars`);
    }

    // 4) status edges for agents that own a thread
    const live = new Set(agents.map((a) => a.pid));
    for (const [pidStr, threadTs] of Object.entries(st.agentThread)) {
      const pid = Number(pidStr);
      const a = agents.find((x) => x.pid === pid);
      const now = a ? a.status : "exited";
      const prev = lastStatus.get(pid);
      lastStatus.set(pid, now);
      if (prev === undefined || prev === now) continue;
      const who = a ? agentLabel(a) : pidStr;
      const ob = join(outbox, `${pidStr}.md`);
      const pending = existsSync(ob) && statSync(ob).size > (st.outboxOffset[pidStr] ?? 0);
      if (pending) st.replied[pidStr] = true;
      if (now === "needs_input") await post(`*${who}* needs input — reply in this thread to answer`, threadTs);
      else if (now === "idle" && !st.replied[pidStr]) await post(`*${who}* went idle without a reply`, threadTs);
      if (!live.has(pid)) {
        await post(`*${who}* exited`, threadTs);
        delete st.agentThread[pidStr];
      }
      if (now === "idle") st.replied[pidStr] = true; // one idle note per forward
    }
    save();
  };

  // --cycles N: run N poll cycles then exit (tests).
  const cyi = argv.indexOf("--cycles");
  let cyclesLeft = cyi >= 0 ? Number(argv[cyi + 1]) : Infinity;
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop = true; log("stopping"); save(); process.exit(0); });
  while (!stop && cyclesLeft-- > 0) {
    try { await cycle(); } catch (e: unknown) {
      const msg = String(e);
      log("cycle error", msg.slice(0, 300));
      if (/invalid_auth|not_authed|token_revoked|needs its session cookie/.test(msg)) process.exit(2);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(String(e)); process.exit(1); });
}
