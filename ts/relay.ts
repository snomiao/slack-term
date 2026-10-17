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

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { authTest, conversationsJoin, history, memberChannels, reactionAdd, replies, send } from "./slack.ts";
import { resolveCookie, resolveToken } from "./profiles.ts";
import { connectRelayStream, wakeableSleep } from "./relayStream.ts";

const run = promisify(execFile);

export const RELAY_MARK = "🤖";
export const FORWARD_PREFIX = "[slack-relay]";

export type Agent = { pid: number; cwd: string; status: string; cli: string };
export type SlackMsg = {
  ts: string; user?: string; text?: string; subtype?: string; thread_ts?: string; bot_id?: string;
  reply_count?: number; latest_reply?: string;
};

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

/** Addressing the relay's own bot ("<@BOT> do x", or a typed "@snobot do x") is the
 *  same as no prefix: the mention is dropped and the message goes to the default /
 *  thread agent. A bare mention still forwards, so the agent sees it was pinged. */
export function stripSelfMention(text: string, selfId: string, selfName: string): string {
  let t = text.trim();
  if (selfId) t = t.replace(new RegExp(`^<@${selfId}(\\|[^>]*)?>[\\s:,]*`), "");
  if (selfName) t = t.replace(new RegExp(`^@${selfName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w./-])[\\s:,]*`, "i"), "");
  t = t.trim();
  return t || "(you were mentioned, no text)";
}

/** Does the text tag this user (`<@U…>` or `<@U…|name>`)? */
export function mentionsUser(text: string | undefined, uid: string): boolean {
  return !!uid && new RegExp(`<@${uid}(\\|[^>]*)?>`).test(text ?? "");
}

/** In a mention-only channel only a message that tags the bot starts a conversation;
 *  once a thread is bound to an agent, the owner's further replies in it count too. */
export function mentionGate(m: SlackMsg, opts: { mentionsOnly: boolean; botId: string; threadBound: boolean }): boolean {
  if (!opts.mentionsOnly) return true;
  return opts.threadBound || mentionsUser(m.text, opts.botId);
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
  delivered: string[];                    // message ts already forwarded (restart-proof dedupe)
  floor: string;                          // never forward anything at/before this ts
  replySeen: Record<string, string>;      // thread root ts → newest reply ts looked at
};

const THREAD_TTL_MS = 24 * 3600_000;

function loadState(path: string): State {
  try { return JSON.parse(readFileSync(path, "utf8")) as State; } catch {
    return { cursor: "", threads: {}, agentThread: {}, ownTs: [], outboxOffset: {}, replied: {}, delivered: [], floor: "", replySeen: {} };
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

type Config = {
  workspace?: string;    // slack-term profile holding the owner's user session (optional with a bot)
  channel: string;
  team?: string;         // expected team id — a bot token for another workspace is refused
  owner?: string;        // the user whose messages are instructions (default: the user token's owner)
  defaultAgent?: string;
  intervalMs?: number;
  stateDir?: string;
  botTokenFile?: string; // dotenv file with SLACK_RELAY_BOT_TOKEN=xoxb-… (default ~/.config/slack-cli/relay-bot.env)
  mentionsOnly?: boolean;
  mentionIntervalMs?: number; // poll interval of a mention-only child (default 15 s)
  mentionRescanMs?: number;   // how often the supervisor re-lists the bot's channels (default 5 min) // only messages that tag the bot (and threads already bound) are instructions
  stream?: string;       // wss://<relay-worker>/stream — realtime wake-ups (relay-worker/)
  streamKeyFile?: string; // dotenv file with RELAY_STREAM_KEY=… (default ~/.config/slack-cli/relay-stream.env)
  streamIntervalMs?: number; // poll interval while the stream is up (default 30 s; it is only the safety net then)
};

const AUTH_ERROR = /invalid_auth|not_authed|token_revoked|token_expired|account_inactive|needs its session cookie/;

function loadConfig(argv: string[]): Config {
  const ci = argv.indexOf("--config");
  const cfgPath = ci >= 0 && argv[ci + 1] ? argv[ci + 1]! : join(homedir(), ".config", "slack-cli", "relay.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Config;
  if (!/^[CDG][A-Z0-9]{6,}$/.test(cfg.channel)) throw new Error(`relay.json: "channel" must be a channel ID, got ${cfg.channel}`);
  return cfg;
}

function botTokenPath(cfg: Config): string {
  return cfg.botTokenFile ?? join(homedir(), ".config", "slack-cli", "relay-bot.env");
}

export function readBotToken(path: string): string | undefined {
  try {
    const m = readFileSync(path, "utf8").match(/^SLACK_RELAY_BOT_TOKEN=(xoxb-\S+)\s*$/m);
    return m?.[1];
  } catch { return undefined; }
}

type Creds = {
  token: string;        // reads AND writes — the bot when there is one
  cookie?: string;
  owner: string;        // whose messages are instructions
  ownerName: string;
  selfId: string;       // who the relay posts as (loop guard)
  selfName: string;
  mode: "bot" | "user";
};

async function resolveCreds(cfg: Config, channel: string): Promise<Creds> {
  const bot = readBotToken(botTokenPath(cfg));
  let user: { token: string; cookie?: string; id: string; name: string; team: string } | undefined;
  let userErr = "";
  try {
    const token = resolveToken(cfg.workspace);
    const cookie = resolveCookie(cfg.workspace);
    const a = await authTest(token, cookie);
    user = { token, ...(cookie ? { cookie } : {}), id: a.userId, name: a.user, team: a.teamId };
  } catch (e: unknown) { userErr = String(e).split("\n")[0]!; }
  if (bot) {
    const b = await authTest(bot);
    if (cfg.team && b.teamId !== cfg.team) throw new Error(`bot token is for team ${b.teamId}, relay.json expects ${cfg.team}`);
    const owner = cfg.owner ?? user?.id;
    if (!owner) throw new Error(`bot mode needs "owner" in relay.json (user session unavailable: ${userErr})`);
    // A DM (D…) has no join; a private channel (G…/C…) needs an invite if the join fails.
    if (!channel.startsWith("D")) {
      try { await conversationsJoin(bot, channel); } catch (e: unknown) { log("bot could not join channel (invite it):", String(e)); }
    }
    return { token: bot, owner, ownerName: user?.name ?? owner, selfId: b.userId, selfName: b.user, mode: "bot" };
  }
  if (!user) throw new Error(`no bot token and the user session failed: ${userErr}`);
  if (cfg.team && user.team !== cfg.team) throw new Error(`user session is for team ${user.team}, relay.json expects ${cfg.team}`);
  return { token: user.token, ...(user.cookie ? { cookie: user.cookie } : {}), owner: cfg.owner ?? user.id, ownerName: user.name, selfId: user.id, selfName: "", mode: "user" };
}

/** Record a delivered message ts; false when it was already delivered. */
export function markDelivered(delivered: string[], ts: string, cap = 2000): boolean {
  if (delivered.includes(ts)) return false;
  delivered.push(ts);
  if (delivered.length > cap) delivered.splice(0, delivered.length - cap);
  return true;
}

/** Prompt-free token pickup: `bun run relay set-bot-token` reads the clipboard (macOS) or
 *  stdin, checks it is a bot token for the configured team, and saves it 0600. The token
 *  itself is never printed. */
async function setBotToken(cfg: Config): Promise<void> {
  let tok = "";
  try { tok = (await run("pbpaste", [])).stdout.trim(); } catch { /* not macOS */ }
  if (!tok.startsWith("xoxb-")) {
    process.stderr.write("Paste the Bot User OAuth Token (xoxb-…), then Enter: ");
    tok = await new Promise<string>((res) => {
      let buf = "";
      process.stdin.on("data", (d) => { buf += String(d); if (buf.includes("\n")) res(buf.trim()); });
    });
  }
  if (!tok.startsWith("xoxb-")) { console.error("Not a bot token (expected xoxb-…)."); process.exit(1); }
  const a = await authTest(tok);
  if (cfg.team && a.teamId !== cfg.team) { console.error(`That bot token is for team ${a.teamId}, not ${cfg.team}.`); process.exit(1); }
  const path = botTokenPath(cfg);
  writeFileSync(path, `SLACK_RELAY_BOT_TOKEN=${tok}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`Saved bot token for @${a.user} (${a.userId}, team ${a.teamId}) to ${path}. A running relay switches to it within one cycle.`);
  process.exit(0);
}

/** Mention mode: run one mention-only relay per channel the bot is a member of (except
 *  the home channel and DMs, which have full relays), re-listing every few minutes. Each
 *  child is the ordinary single-channel relay with `mentionsOnly`, its own state and outbox.
 *  Never acts on anyone but the owner — the children apply the same owner check. */
async function superviseMentions(cfg: Config, argv: string[]): Promise<void> {
  const bot = readBotToken(botTokenPath(cfg));
  if (!bot) throw new Error("mention mode needs the bot token (bun run relay set-bot-token)");
  const root = join(cfg.stateDir ?? join(homedir(), ".config", "slack-cli", "relay"), "mentions");
  mkdirSync(root, { recursive: true });
  const exclude = new Set([cfg.channel, ...(cfg as { mentionExclude?: string[] }).mentionExclude ?? []]);
  const children = new Map<string, ReturnType<typeof spawn>>();
  const self = process.argv[1]!;
  const startChild = (id: string, name: string): void => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const childCfg = join(dir, "relay.json");
    writeFileSync(childCfg, JSON.stringify({ ...cfg, channel: id, stateDir: dir, mentionsOnly: true, intervalMs: cfg.mentionIntervalMs ?? 15_000 }));
    const child = spawn(process.execPath, [self, "--config", childCfg], { stdio: ["ignore", "pipe", "pipe"] });
    const tag = `[#${name || id}]`;
    child.stdout?.on("data", (d) => process.stdout.write(String(d).split("\n").filter(Boolean).map((l) => `${tag} ${l}\n`).join("")));
    child.stderr?.on("data", (d) => process.stdout.write(`${tag} ${String(d)}`));
    child.on("exit", (code) => {
      children.delete(id);
      log(`${tag} exited (${code}); restarting in 30 s`);
      setTimeout(() => { if (!children.has(id) && !stopping) startChild(id, name); }, 30_000);
    });
    children.set(id, child);
    log(`${tag} watching for mentions`);
  };
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopping = true; for (const c of children.values()) c.kill("SIGTERM"); process.exit(0); });
  const cyi = argv.indexOf("--rounds");
  let rounds = cyi >= 0 ? Number(argv[cyi + 1]) : Infinity;
  while (rounds-- > 0) {
    try {
      let chans = await memberChannels(bot, "public_channel");
      try { chans = chans.concat(await memberChannels(bot, "private_channel")); } catch { /* no groups:read */ }
      const want = new Map(chans.filter((c) => !exclude.has(c.id) && !c.id.startsWith("D")).map((c) => [c.id, c.name]));
      for (const [id, name] of want) if (!children.has(id)) startChild(id, name);
      for (const [id, c] of children) if (!want.has(id)) { log(`[${id}] bot left — stopping`); c.kill("SIGTERM"); }
    } catch (e: unknown) { log("listing channels failed", String(e).slice(0, 200)); }
    await new Promise((r) => setTimeout(r, cfg.mentionRescanMs ?? 300_000));
  }
  stopping = true;
  for (const c of children.values()) c.kill("SIGTERM");
}

export async function main(argv: string[]): Promise<void> {
  const cfg = loadConfig(argv);
  if (argv[0] === "set-bot-token") return setBotToken(cfg);
  if (argv[0] === "mentions") return superviseMentions(cfg, argv);
  const CHANNEL = cfg.channel; // the ONLY channel this process ever reads or writes
  const stateDir = cfg.stateDir ?? join(homedir(), ".config", "slack-cli", "relay");
  const outbox = join(stateDir, "outbox");
  mkdirSync(outbox, { recursive: true });
  const statePath = join(stateDir, "state.json");
  const st = loadState(statePath);
  st.delivered ??= [];
  st.replySeen ??= {};
  st.floor ??= "";
  const ownTs = new Set(st.ownTs);
  const save = (): void => {
    st.ownTs = [...ownTs].slice(-500);
    writeFileSync(statePath, JSON.stringify(st, null, 1));
  };
  const intervalMs = cfg.intervalMs ?? 5000;

  let creds: Creds | undefined;
  let botFileMtime = 0;
  const botFileChanged = (): boolean => {
    let m = 0;
    try { m = statSync(botTokenPath(cfg)).mtimeMs; } catch { /* absent */ }
    const changed = m !== botFileMtime;
    botFileMtime = m;
    return changed;
  };
  botFileChanged();

  // `pid`: a top-level post made for an agent opens a thread bound to that agent, so a
  // reply under it reaches that agent.
  const post = async (text: string, threadTs?: string, pid?: number): Promise<string> => {
    const c = creds!;
    // A bot has its own name and avatar; a relay posting as the user marks its text.
    const ts = await send(c.token, CHANNEL, c.mode === "bot" ? text : `${RELAY_MARK} ${text}`, threadTs, false, c.cookie, true);
    if (ts) ownTs.add(ts);
    if (ts && !threadTs && pid !== undefined) {
      st.threads[ts] = { pid, seen: ts, touched: Date.now() };
      st.agentThread[String(pid)] = ts;
      st.replySeen[ts] = ts;
    }
    return ts;
  };
  const react = (ts: string, name: string): Promise<void> =>
    reactionAdd(creds!.token, CHANNEL, ts, name, creds!.cookie).catch((e: unknown) => {
      if (!String(e).includes("already_reacted")) log("react failed", name, String(e));
    });

  let agents: Agent[] = [];
  const lastStatus = new Map<number, string>();

  const deliver = async (m: SlackMsg, threadTs: string): Promise<void> => {
    if (st.delivered.includes(m.ts)) return; // restart / overlapping polls: never twice
    const text = stripSelfMention(m.text ?? "", creds!.selfId, creds!.selfName)
      .replace(new RegExp(`<@${creds!.selfId}(\\|[^>]*)?>`, "g"), `@${creds!.selfName || "bot"}`);
    const bound = st.threads[threadTs];
    const { route, body } = parseRoute(text);
    let agent: Agent | undefined;
    if (route) {
      const r = matchAgent(route, agents, cfg.defaultAgent ? Number(cfg.defaultAgent) : undefined);
      agent = r.agent;
      if (!agent) {
        markDelivered(st.delivered, m.ts); save();
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
      markDelivered(st.delivered, m.ts); save();
      await post(`agent ${bound?.pid ?? cfg.defaultAgent ?? "?"} is not running — address one with \`@name …\``, threadTs);
      return;
    }
    await react(m.ts, "eyes");
    const msg = forwardText(route ? body : text.trim(), { from: `@${creds!.ownerName}`, agentPid: agent.pid, outbox });
    // `ay send` exit 4 = QUEUED: accepted while the agent is busy, delivered when its
    // input box frees up. That is a delivery, and resending it would duplicate.
    let queued = false;
    try {
      await run("ay", ["send", "--force", String(agent.pid), msg], { timeout: 60_000 });
    } catch (e: unknown) {
      const err = e as { code?: number; stderr?: string };
      if (err.code === 4) queued = true;
      else {
        log("ay send failed", agent.pid, `exit=${err.code}`, (err.stderr ?? String(e)).trim().slice(-500));
        markDelivered(st.delivered, m.ts); save();
        await post(`could not deliver to ${agentLabel(agent)} (${agent.pid}): ay send exit ${err.code ?? "?"}`, threadTs);
        return;
      }
    }
    markDelivered(st.delivered, m.ts);
    // Mutate in place: the replies loop holds this same object and advances its `seen`.
    const th = (st.threads[threadTs] ??= { pid: agent.pid, seen: threadTs, touched: Date.now() });
    th.pid = agent.pid;
    th.touched = Date.now();
    st.agentThread[String(agent.pid)] = threadTs;
    st.replied[String(agent.pid)] = false;
    save(); // persist before anything else can fail
    await react(m.ts, queued ? "hourglass_flowing_sand" : "white_check_mark");
    log(`→ ${agentLabel(agent)} (${agent.pid})${queued ? " [queued]" : ""} ts=${m.ts} ${JSON.stringify(body.slice(0, 80))}`);
  };

  const cycle = async (): Promise<void> => {
    const c = creds!;
    agents = await listAgents().catch((e: unknown) => { log("ay ls failed", String(e)); return agents; });

    // 1) one history call over the last day: new top-level messages (past the cursor),
    //    and every thread whose latest_reply moved — whoever started it (the owner, a
    //    bystander, or the relay itself). Thread roots older than a day are not watched.
    const dayAgo = Date.now() / 1000 - THREAD_TTL_MS / 1000;
    // The floor gates what is forwarded (cursor for top-level, `seen` for replies), not which
    // roots are scanned: a thread started before a restart still gets new replies.
    const h = (await history(c.token, CHANNEL, 200, String(dayAgo), undefined, c.cookie)) as { messages?: SlackMsg[] };
    for (const m of (h.messages ?? []).slice().reverse()) {
      if (Number(m.ts) > Number(st.cursor)) {
        if (isInstruction(m, c.owner, ownTs) && mentionGate(m, { mentionsOnly: !!cfg.mentionsOnly, botId: c.selfId, threadBound: false })) await deliver(m, m.ts);
        st.cursor = m.ts;
        save();
      }
      if (!m.reply_count || !m.latest_reply) continue;
      const seen = String(Math.max(Number(st.replySeen[m.ts] ?? 0), Number(st.floor) || 0));
      if (Number(m.latest_reply) <= Number(seen)) continue;
      const r = (await replies(c.token, CHANNEL, m.ts, 200, c.cookie)) as { messages?: SlackMsg[] };
      for (const x of r.messages ?? []) {
        if (x.ts === m.ts || Number(x.ts) <= Number(seen)) continue;
        if (isInstruction(x, c.owner, ownTs) && mentionGate(x, { mentionsOnly: !!cfg.mentionsOnly, botId: c.selfId, threadBound: !!st.threads[m.ts] })) await deliver(x, m.ts);
        st.replySeen[m.ts] = x.ts;
        save();
      }
    }
    for (const [root, th] of Object.entries(st.threads)) if (Date.now() - th.touched > THREAD_TTL_MS) delete st.threads[root];
    for (const root of Object.keys(st.replySeen)) if (Number(root) < dayAgo) delete st.replySeen[root];

    // 3) outbox → thread
    for (const f of readdirSync(outbox).filter((x) => /^\d+\.md$/.test(x))) {
      const pid = f.replace(/\.md$/, "");
      const path = join(outbox, f);
      const size = statSync(path).size;
      const off = st.outboxOffset[pid] ?? 0;
      if (size <= off) { if (size < off) st.outboxOffset[pid] = 0; continue; }
      if (Date.now() - statSync(path).mtimeMs < 1500) continue; // let the write finish
      const chunk = readFileSync(path).subarray(off).toString("utf8");
      const threadTs = st.agentThread[pid];
      const a = agents.find((x) => String(x.pid) === pid);
      const who = a ? agentLabel(a) : pid;
      if (chunk.trim()) {
        await post(`*${who}*: ${clip(chunk)}`, threadTs, Number(pid));
        st.replied[pid] = true;
        log(`← ${who} (${pid}) ${chunk.trim().length} chars`);
      }
      st.outboxOffset[pid] = size;
      save();
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
  let backoff = 0;

  // Realtime: a wake frame for this channel ends the sleep, so a message is picked up
  // within one API round trip instead of up to one poll interval. Every (re)connect
  // also wakes once, to catch up on whatever arrived while the socket was down.
  const sleeper = wakeableSleep();
  let streamUp = false;
  let stopStream: (() => void) | undefined;
  const streamKey = (() => {
    try {
      return readFileSync(cfg.streamKeyFile ?? join(homedir(), ".config", "slack-cli", "relay-stream.env"), "utf8").match(/^RELAY_STREAM_KEY=(\S+)/m)?.[1];
    } catch { return undefined; }
  })();
  if (cfg.stream && streamKey) {
    stopStream = connectRelayStream({
      url: cfg.stream,
      key: streamKey,
      onWake: (w) => {
        if (w.channel !== CHANNEL) return;
        log(`⚡ wake ts=${w.ts}${w.thread_ts ? ` thread=${w.thread_ts}` : ""} transport=${(Date.now() / 1000 - Number(w.ts)).toFixed(2)}s`);
        sleeper.wake();
      },
      onState: (s, why) => {
        streamUp = s === "open";
        log(`stream ${s}${why ? ` (${why})` : ""}`);
        if (streamUp) sleeper.wake();
      },
    });
  } else if (cfg.stream) {
    log("stream configured but no RELAY_STREAM_KEY — polling only");
  }

  // Outbound must not wait for the (stream-lengthened) poll either: an agent appending to
  // its outbox wakes the loop. The 1.5 s settle check in the cycle still applies, so
  // wake again shortly after the last write.
  let outboxTimer: ReturnType<typeof setTimeout> | undefined;
  const outboxWatch = (() => {
    try {
      return watch(outbox, () => {
        if (outboxTimer) clearTimeout(outboxTimer);
        outboxTimer = setTimeout(() => sleeper.wake(), 1600);
      });
    } catch { return undefined; }
  })();

  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop = true; log("stopping"); save(); process.exit(0); });
  while (!stop && cyclesLeft-- > 0) {
    try {
      // (Re)resolve on start, after an auth failure, and when a bot token is dropped in —
      // credentials are re-read from disk, so a re-imported cookie needs no restart.
      if (!creds || botFileChanged()) {
        const prev = creds?.mode;
        creds = await resolveCreds(cfg, CHANNEL);
        log(`relay up: mode=${creds.mode} owner=${creds.owner} posts-as=${creds.selfId} channel=${CHANNEL} default=${cfg.defaultAgent ?? "-"} outbox=${outbox}${prev && prev !== creds.mode ? ` (was ${prev})` : ""}`);
        if (!st.cursor) {
          // Start from "now": never replay old history as instructions.
          const h = (await history(creds.token, CHANNEL, 1, undefined, undefined, creds.cookie)) as { messages?: SlackMsg[] };
          st.cursor = h.messages?.[0]?.ts ?? String(Date.now() / 1000);
        }
        if (!st.floor) {
          st.floor = st.cursor;
          save();
        }
      }
      await cycle();
      backoff = 0;
    } catch (e: unknown) {
      const msg = String(e);
      if (AUTH_ERROR.test(msg)) {
        creds = undefined;
        backoff = Math.min(backoff ? backoff * 2 : 15_000, 300_000);
        log(`!!! AUTH FAILED — ${msg.split("\n")[0]!.slice(0, 200)}. Retrying in ${backoff / 1000}s. ` +
          `Fix: set a bot token (bun run relay set-bot-token) or re-import the session (slack auth chrome -w ${cfg.workspace ?? "<ws>"}).`);
        save();
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      log("cycle error", msg.slice(0, 300));
    }
    await sleeper.sleep(streamUp ? (cfg.streamIntervalMs ?? 30_000) : intervalMs);
  }
  stopStream?.();
  outboxWatch?.close();
  if (outboxTimer) clearTimeout(outboxTimer);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(String(e)); process.exit(1); });
}
