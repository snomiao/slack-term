#!/usr/bin/env bun
// Slack CLI entry — mirrors the Rust impl in src/main.rs.

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { addProfile, listProfiles, removeProfile, resolveCookie, resolveToken, setCookie, useProfile } from "./profiles.ts";
import { extractSessions } from "./slack-app.ts";

import {
  authTest,
  authTestSession,
  conversationInfoSession,
  createDraft,
  deleteDraft,
  updateDraft,
  history,
  listConversations,
  listDrafts,
  openDm,
  replies,
  resolveChannel,
  search,
  searchAll,
  send as slackSend,
  userInfoPair,
  userName,
  getPath,
  type Json,
} from "./slack.ts";
import { dayLabel, formatHm, formatYmdHm, resolveDateMarkup, resolveMentions } from "./format.ts";

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function ensureSlackCliDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
}

function loadDotenvFiles(): void {
  // Global home config
  loadDotenv(join(homedir(), ".slack-cli", ".env.local"));
  loadDotenv(join(homedir(), ".config/slack-cli", ".env"));
  // Local project overrides (highest priority — loaded last so they win)
  loadDotenv(join(process.cwd(), ".slack-cli", ".env.local"));
  loadDotenv(join(process.cwd(), ".env.local"));
  loadDotenv(join(process.cwd(), ".env"));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function asRecord(v: Json | undefined): Record<string, Json> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {};
}

function asArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}

function tsNum(m: Record<string, Json>): number {
  return Number(m.ts ?? 0);
}

async function displayUser(
  token: string,
  m: Record<string, Json>,
  cache: Map<string, string>,
): Promise<string> {
  const uid = m.user;
  if (typeof uid === "string") {
    if (!cache.has(uid)) cache.set(uid, await userName(token, uid));
    return cache.get(uid) ?? uid;
  }
  return typeof m.username === "string" ? m.username : "bot";
}

function formatYmdHmsUtc(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
}

// Format one message line: `[YYYY-MM-DD HH:MM:SS] <real|@handle> text` (UTC)
async function formatMsgLine(
  token: string,
  m: Record<string, Json>,
  cache: Map<string, string>,
): Promise<string> {
  const ts = tsNum(m);
  const stamp = formatYmdHmsUtc(ts);
  let real = "?";
  let handle = "?";
  if (typeof m.user === "string") {
    const uid = m.user;
    const realKey = uid;
    const handleKey = "@" + uid;
    if (!cache.has(realKey) || !cache.has(handleKey)) {
      const [d, h] = await userInfoPair(token, uid);
      cache.set(realKey, d);
      cache.set(handleKey, h);
    }
    real = cache.get(realKey) ?? uid;
    handle = cache.get(handleKey) ?? uid;
  } else if (typeof m.username === "string") {
    real = m.username;
    handle = m.username;
  }
  const raw = typeof m.text === "string" ? m.text : "";
  const resolved = resolveDateMarkup(await resolveMentions(token, raw, cache));
  const oneline = resolved.split("\n").join(" ↵ ");
  return `[${stamp}] <${real}|@${handle}> ${oneline}`;
}

// --- msgs <target> — channel/DM history with timestamps ---
async function cmdMsgsTarget(token: string, target: string, limit: number): Promise<void> {
  const channelId = await resolveChannel(token, target);
  const hist = (await history(token, channelId, limit)) as Record<string, Json>;
  const msgs = asArray(hist.messages).map(asRecord);
  const cache = new Map<string, string>();
  for (const m of msgs.reverse()) {
    console.log(await formatMsgLine(token, m, cache));
  }
}

// --- thread ---
async function cmdThread(token: string, target: string, ts: string, limit: number): Promise<void> {
  const channelId = await resolveChannel(token, target);
  const resp = (await replies(token, channelId, ts, limit)) as Record<string, Json>;
  const msgs = asArray(resp.messages).map(asRecord);
  const cache = new Map<string, string>();
  for (const m of msgs) {
    console.log(await formatMsgLine(token, m, cache));
  }
}

// --- msgs (no target) ---
async function cmdMsgs(token: string): Promise<void> {
  const resp = (await listConversations(token)) as Record<string, Json>;
  const channels = asArray(resp.channels)
    .map(asRecord)
    .filter((c) => c.is_member === true)
    .sort((a, b) => Number(b.updated ?? 0) - Number(a.updated ?? 0))
    .slice(0, 10);

  const cache = new Map<string, string>();
  for (const ch of channels) {
    const id = String(ch.id ?? "");
    const name = typeof ch.name === "string" ? ch.name : typeof ch.user === "string" ? ch.user : id;
    const hist = (await history(token, id, 5)) as Record<string, Json>;
    const msgs = asArray(hist.messages)
      .map(asRecord)
      .filter((m) => m.subtype === undefined || m.subtype === null)
      .filter((m) => {
        const t = typeof m.text === "string" ? m.text : "";
        return t.length > 0 && !t.startsWith("<@");
      })
      .slice(0, 3);
    if (msgs.length === 0) continue;
    console.log(`── #${name} ─────────────────────────────────`);
    for (const m of msgs) {
      const who = await displayUser(token, m, cache);
      const raw = (typeof m.text === "string" ? m.text : "").split("\n")[0] ?? "";
      const text = await resolveMentions(token, raw, cache);
      console.log(`  ${who}: ${text}`);
    }
  }
}

// --- news ---
async function cmdNews(token: string, limit: number): Promise<void> {
  const resp = (await search(token, "to:me")) as Record<string, Json>;
  const matches = asArray(getPath(resp, ["messages", "matches"])).map(asRecord);
  const cache = new Map<string, string>();
  let lastDay = "";
  for (const m of matches.slice(0, limit)) {
    const ts = tsNum(m);
    const label = dayLabel(ts);
    if (label !== lastDay) {
      if (lastDay !== "") console.log("");
      console.log(`  ${label}`);
      console.log("  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
      lastDay = label;
    }
    const ch = asRecord(m.channel);
    const isIm = ch.is_im === true;
    const rawName = typeof ch.name === "string" ? ch.name : "dm";
    let chLabel: string;
    if (isIm && rawName.startsWith("U")) {
      if (!cache.has(rawName)) cache.set(rawName, await userName(token, rawName));
      chLabel = `@${cache.get(rawName) ?? rawName}`;
    } else if (isIm) {
      chLabel = `@${rawName}`;
    } else {
      chLabel = `#${rawName}`;
    }
    const display = await displayUser(token, m, cache);
    const raw = typeof m.text === "string" ? m.text : "";
    const resolved = resolveDateMarkup(await resolveMentions(token, raw, cache));
    const firstLine = (resolved.split("\n")[0] ?? "").slice(0, 80);
    const icon = isIm ? "💬" : "🔔";
    console.log(`  ${icon} ${chLabel}  ${formatHm(ts)}`);
    console.log(`     ${display}: ${firstLine}`);
  }
}

// --- search ---
async function cmdSearch(token: string, query: string, count: number): Promise<void> {
  const resp = await searchAll(token, query, count);
  console.log(JSON.stringify(resp, null, 2));
}

// --- dump ---
async function cmdDump(
  token: string,
  days: number,
  limit: number,
  filter?: string,
): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const resp = (await listConversations(token)) as Record<string, Json>;
  const channels = asArray(resp.channels)
    .map(asRecord)
    .filter((c) => c.is_member === true && c.is_im !== true && c.is_mpim !== true)
    .filter((c) => {
      if (!filter) return true;
      const n = typeof c.name === "string" ? c.name : "";
      return n.toLowerCase().includes(filter.toLowerCase());
    })
    .sort((a, b) => Number(b.updated ?? 0) - Number(a.updated ?? 0));

  const cache = new Map<string, string>();
  let total = 0;
  let active = 0;
  for (const ch of channels) {
    const id = String(ch.id ?? "");
    const name = typeof ch.name === "string" ? ch.name : id;
    let hist: Record<string, Json>;
    try {
      hist = (await history(token, id, limit)) as Record<string, Json>;
    } catch (e) {
      console.error(`  SKIP #${name}: ${(e as Error).message}`);
      continue;
    }
    const msgs = asArray(hist.messages)
      .map(asRecord)
      .filter((m) => (m.subtype === undefined || m.subtype === null) && tsNum(m) >= cutoff);
    if (msgs.length === 0) continue;
    active += 1;
    total += msgs.length;
    console.log(`## #${name} (${msgs.length} msgs)\n`);
    for (const m of [...msgs].reverse()) {
      const who = await displayUser(token, m, cache);
      const raw = typeof m.text === "string" ? m.text : "";
      const resolved = resolveDateMarkup(await resolveMentions(token, raw, cache));
      const oneline = resolved.split("\n").join(" ↵ ");
      console.log(`[${formatYmdHm(tsNum(m))}] ${who}: ${oneline}`);
    }
    console.log("");
  }
  console.error(`Dumped ${total} messages across ${active} channels (cutoff: ${days}d)`);
}

// Extract plain text from Slack rich-text blocks
function blocksToText(blocks: Json[]): string {
  const parts: string[] = [];
  function walk(node: Json): void {
    if (typeof node === "string") { parts.push(node); return; }
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (node && typeof node === "object") {
      const obj = node as Record<string, Json>;
      if (typeof obj.text === "string") { parts.push(obj.text); return; }
      if (Array.isArray(obj.elements)) walk(obj.elements);
      else if (Array.isArray(obj.content)) walk(obj.content);
    }
  }
  for (const b of blocks) walk(b);
  return parts.join("").trim();
}

// --- drafts helpers ---
async function buildChLabelResolver(
  token: string,
  cookie: string | undefined,
  myUserId: string,
): Promise<(channelId: string) => Promise<string>> {
  const cache = new Map<string, string>();
  return async (channelId: string): Promise<string> => {
    if (!channelId) return "(unknown)";
    if (cache.has(channelId)) return cache.get(channelId)!;
    try {
      const info = (await conversationInfoSession(token, channelId, cookie)) as Record<string, Json>;
      const ch = asRecord(info.channel);
      let label: string;
      if (ch.is_im === true) {
        const uid = typeof ch.user === "string" ? ch.user : "";
        if (!uid || uid === myUserId) {
          label = "@self";
        } else {
          const [display] = await userInfoPair(token, uid);
          label = `@${display}`;
        }
      } else {
        label = `#${typeof ch.name === "string" ? ch.name : channelId}`;
      }
      cache.set(channelId, label);
      return label;
    } catch {
      return channelId;
    }
  };
}

function draftChannelId(d: Record<string, Json>): string {
  const dest = asRecord(asArray(d.destinations)[0]);
  return String(dest.channel_id ?? d.channel_id ?? d.channel ?? "");
}

function draftText(d: Record<string, Json>): string {
  return blocksToText(asArray(d.blocks)) || (typeof d.text === "string" ? d.text : "(no text)");
}

// --- drafts list ---
async function cmdDrafts(token: string, cookie?: string, showAll = false): Promise<void> {
  const resp = (await listDrafts(token, cookie)) as Record<string, Json>;
  const all = asArray(resp.drafts ?? resp.messages ?? [])
    .map(asRecord)
    .filter((d) => d.is_deleted !== true);
  const drafts = showAll ? all : all.filter((d) => d.is_sent !== true);

  if (drafts.length === 0) {
    console.log(showAll ? "No drafts." : "No pending drafts. Run with --all to include sent.");
    return;
  }

  let myUserId = "";
  try { ({ userId: myUserId } = await authTestSession(token, cookie)); } catch { /* best-effort */ }
  const resolveChLabel = await buildChLabelResolver(token, cookie, myUserId);
  const mentionCache = new Map<string, string>();

  for (const d of drafts) {
    const channelId = draftChannelId(d);
    const text = draftText(d);
    const ts = Number(d.date_created ?? d.date_create ?? 0);
    const stamp = ts ? formatYmdHmsUtc(ts) : "?";
    const chLabel = await resolveChLabel(channelId);
    const id = typeof d.id === "string" ? d.id : "";
    const sentTag = d.is_sent === true ? "  [SENT]" : "";
    const resolved = resolveDateMarkup(await resolveMentions(token, text, mentionCache));
    console.log(`── ${id}  ${chLabel}  [${stamp}]${sentTag}`);
    for (const line of resolved.split("\n")) console.log(`   ${line}`);
  }
}

// --- drafts get ---
async function cmdDraftGet(token: string, cookie: string | undefined, draftId: string): Promise<void> {
  const resp = (await listDrafts(token, cookie)) as Record<string, Json>;
  const d = asArray(resp.drafts).map(asRecord).find((x) => String(x.id) === draftId);
  if (!d) { console.error(`Draft not found: ${draftId}`); process.exit(1); }

  let myUserId = "";
  try { ({ userId: myUserId } = await authTestSession(token, cookie)); } catch { /* best-effort */ }
  const resolveChLabel = await buildChLabelResolver(token, cookie, myUserId);

  const channelId = draftChannelId(d);
  const text = draftText(d);
  const ts = Number(d.date_created ?? 0);
  const updatedTs = String(d.last_updated_ts ?? "?");
  const chLabel = await resolveChLabel(channelId);

  const cache = new Map<string, string>();
  const resolved = resolveDateMarkup(await resolveMentions(token, text, cache));

  console.log(`id:      ${d.id}`);
  console.log(`channel: ${chLabel}  (${channelId})`);
  console.log(`created: ${ts ? formatYmdHmsUtc(ts) : "?"}`);
  console.log(`updated: ${formatYmdHmsUtc(Number(updatedTs.split(".")[0]))}`);
  console.log(`status:  ${d.is_sent === true ? "sent" : "pending"}`);
  console.log(`---`);
  console.log(resolved);
}

/** Compute a 4-char hex safety code from arbitrary context strings. */
function safetyCode(...parts: string[]): string {
  return sha256Hex(parts.join("\n")).slice(0, 4);
}

/** Dry-run gate: print context, print required --code=, exit 1.
 *  Call this when --code is absent or wrong. */
function requireCode(provided: string | undefined, expected: string, contextLines: string[]): void {
  for (const line of contextLines) console.log(line);
  if (provided !== undefined) {
    console.error(`Code mismatch (got ${provided}, expected ${expected})`);
  }
  console.error(`Rerun with --code=${expected}`);
  process.exit(1);
}

// --- send ---
interface SendArgs {
  target: string;
  message: string;
  thread?: string;
  code?: string;
  channelId?: string;
  userId?: string;
}
async function cmdSend(token: string, args: SendArgs): Promise<void> {
  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId);
  else if (args.target.startsWith("#") || args.target.startsWith("@")) {
    channelId = await resolveChannel(token, args.target);
  } else {
    console.error(`Error: target must be #channel-name or @username (got: ${args.target})`);
    console.error("Use --channel-id=<ID> or --user-id=<ID> to send by raw ID.");
    process.exit(1);
  }

  // Fetch last 1 message for context hash
  const ctx = (await history(token, channelId, 1)) as Record<string, Json>;
  const lastMsg = asArray(ctx.messages).map(asRecord)
    .filter((m) => m.subtype === undefined || m.subtype === null)[0];
  const lastText = typeof lastMsg?.text === "string" ? lastMsg.text : "";
  const lastUser = typeof lastMsg?.user === "string" ? lastMsg.user : "?";

  const code = safetyCode(lastText, args.message);

  if (args.code !== code) {
    requireCode(args.code, code, [
      `─── Last message in channel ──────────────────`,
      `  ${lastUser}: ${lastText.split("\n")[0]?.slice(0, 100) ?? "(empty)"}`,
      `─── Sending ──────────────────────────────────`,
      `  To:      ${args.target}${args.thread ? ` (thread ${args.thread})` : ""}`,
      `  Message: ${args.message}`,
      `─────────────────────────────────────────────`,
    ]);
  }
  const ts = await slackSend(token, channelId, args.message, args.thread);
  console.log(`✓ Sent (ts: ${ts})`);
}

// --- dispatch ---
function usage(): never {
  console.error(
    [
      "Usage: slack [--workspace=<name>] <command> [args]",
      "Commands:",
      "  msgs [<#channel|@user|url>] [-n|--limit N]",
      "  thread <#channel|@user|url> <ts> [-n|--limit N]",
      "  news [-l|--limit N]",
      "  search <query> [-n|--count N]",
      "  drafts [--all]                  list pending drafts (--all includes sent)",
      "  drafts new <#channel|@user> <text>",
      "  drafts get <draft-id>",
      "  drafts edit <draft-id> [--code=XXXX] <new-text>",
      "  drafts delete <draft-id> [--code=XXXX]",
      "  send <target> <message> [--thread TS] [--code XXXX] [--channel-id ID] [--user-id ID]",
      "  dump [-d|--days N] [-l|--limit N] [-f|--filter STR]",
      "  workspace ls|list",
      "  workspace import          (auto-import from Slack desktop app)",
      "  workspace add <name> <token>",
      "  workspace set-token <name> <token>",
      "  workspace set-cookie <name> <xoxd>  (store xoxd cookie for draft API)",
      "  workspace use <name>",
      "  workspace remove <name>",
      "  workspace current",
    ].join("\n"),
  );
  process.exit(2);
}

async function cmdWorkspace(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case "list":
    case "ls": {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        console.log("No workspaces configured.");
        console.log("Import from the Slack desktop app:  slack workspace import");
        console.log("Or add manually:                    slack workspace add <name> <token>");
        return;
      }
      for (const { name, profile, current } of profiles) {
        console.log(`${current ? "* " : "  "}${name}  ${profile.team}  (${profile.user})  ${profile.url ?? ""}`);
      }
      return;
    }
    case "import": {
      console.error("Scanning Slack desktop app...");
      const sessions = await extractSessions();
      if (sessions.length === 0) {
        console.error("No sessions found. Make sure Slack is installed and you have logged in.");
        return;
      }
      for (const s of sessions) {
        const teamLabel = s.teamName ?? s.teamId;
        console.error(`  Found: ${teamLabel} ${s.url ?? ""}`);
        const name = teamLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const profile: Parameters<typeof addProfile>[1] = {
          token: s.token,
          team: s.teamName ?? s.teamId,
          teamId: s.teamId,
          url: s.url ?? "",
          user: "",
        };
        if (s.cookie) profile.cookie = s.cookie;
        addProfile(name, profile);
        const cookieNote = s.cookie ? " + xoxd cookie" : "";
        console.log(`Added workspace "${name}": ${teamLabel}${cookieNote}`);
      }
      console.log(`\nNote: desktop app tokens (xoxc-) are internal Slack tokens.`);
      console.log(`If API calls fail, replace with an xoxp- token:`);
      console.log(`  slack workspace set-token <name> <xoxp-token>`);
      console.log(`\nDone. Run: slack workspace ls`);
      return;
    }
    case "add": {
      const [name, token] = args;
      if (!name || !token) {
        console.error("Usage: slack workspace add <name> <token>");
        process.exit(2);
      }
      console.error(`Verifying token...`);
      const info = await authTest(token);
      addProfile(name, { token, ...info });
      console.log(`Added workspace "${name}": ${info.team} (${info.user})`);
      return;
    }
    case "set-token": {
      const [name, token] = args;
      if (!name || !token) {
        console.error("Usage: slack workspace set-token <name> <token>");
        console.error("  Updates the token for an existing workspace profile.");
        process.exit(2);
      }
      console.error(`Verifying token...`);
      const info = await authTest(token);
      addProfile(name, { token, ...info });
      console.log(`Updated workspace "${name}": ${info.team} (${info.user})`);
      return;
    }
    case "set-cookie": {
      const [name, xoxd] = args;
      if (!name || !xoxd) {
        console.error("Usage: slack workspace set-cookie <name> <xoxd-value>");
        console.error("  Stores the xoxd session cookie for draft API access.");
        console.error("  Get it from: DevTools → Application → Cookies → slack.com → d");
        process.exit(2);
      }
      const cookieVal = xoxd.startsWith("d=") ? xoxd.slice(2) : xoxd;
      setCookie(name, cookieVal);
      console.log(`Cookie set for workspace "${name}". Run: slack drafts`);
      return;
    }
    case "use": {
      const globalFlag = args.includes("-g");
      const name = args.find((a) => a !== "-g");
      if (!name) {
        console.error("Usage: slack workspace use [-g] <name>");
        console.error("  -g   write to ~/.slack-cli/workspace (global)");
        console.error("       default: write to .slack-cli/workspace (local cwd)");
        process.exit(2);
      }
      if (!globalFlag) ensureSlackCliDir(join(process.cwd(), ".slack-cli"));
      useProfile(name, globalFlag);
      const scope = globalFlag ? "globally (~/.slack-cli/workspace)" : "locally (.slack-cli/workspace)";
      console.log(`Switched to workspace "${name}" ${scope}`);
      if (!globalFlag) console.log(`Tip: add .slack-cli/ to your .gitignore`);
      return;
    }
    case "remove": {
      const [name] = args;
      if (!name) { console.error("Usage: slack workspace remove <name>"); process.exit(2); }
      removeProfile(name);
      console.log(`Removed workspace "${name}"`);
      return;
    }
    case "current": {
      const profiles = listProfiles();
      const cur = profiles.find((p) => p.current);
      if (!cur) { console.log("No workspace selected"); return; }
      console.log(`${cur.name}  ${cur.profile.team}  (${cur.profile.user})`);
      return;
    }
    default:
      usage();
  }
}

async function main(): Promise<void> {
  loadDotenvFiles();

  // Strip global --workspace=<name> flag before subcommand dispatch.
  const rawArgs = process.argv.slice(2);
  let workspaceFlag: string | undefined;
  const filteredArgs: string[] = [];
  for (const arg of rawArgs) {
    const m = arg.match(/^--workspace=(.+)$/);
    if (m) { workspaceFlag = m[1]; }
    else filteredArgs.push(arg);
  }
  const [cmd, ...rest] = filteredArgs;
  // workspace subcommand needs no token
  if (cmd === "workspace") {
    await cmdWorkspace(rest[0] ?? "", rest.slice(1));
    return;
  }

  const token = resolveToken(workspaceFlag);
  const cookie = resolveCookie(workspaceFlag);

  switch (cmd) {
    case "msgs": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { limit: { type: "string", short: "n", default: "20" } },
        strict: true,
      });
      if (positionals[0]) {
        await cmdMsgsTarget(token, positionals[0], Number(values.limit));
      } else {
        await cmdMsgs(token);
      }
      return;
    }
    case "thread": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { limit: { type: "string", short: "n", default: "100" } },
        strict: true,
      });
      const target = positionals[0];
      const ts = positionals[1];
      if (!target || !ts) usage();
      await cmdThread(token, target, ts, Number(values.limit));
      return;
    }
    case "news": {
      const { values } = parseArgs({
        args: rest,
        options: { limit: { type: "string", short: "l", default: "20" } },
        strict: true,
      });
      await cmdNews(token, Number(values.limit));
      return;
    }
    case "drafts": {
      const sub = rest[0];
      if (sub === "new" || sub === "save") {
        // drafts new <#channel|@user> <text...>
        const args2 = rest.slice(1);
        const target = args2[0];
        const text = args2.slice(1).join(" ");
        if (!target || !text) {
          console.error("Usage: slack drafts new <#channel|@user> <text>");
          process.exit(2);
        }
        const channelId = await resolveChannel(token, target, cookie);
        const resp = (await createDraft(token, channelId, text, cookie)) as Record<string, Json>;
        console.log(`✓ Draft created (id: ${asRecord(resp.draft).id ?? "?"})`);
      } else if (sub === "get") {
        const draftId = rest[1];
        if (!draftId) { console.error("Usage: slack drafts get <draft-id>"); process.exit(2); }
        await cmdDraftGet(token, cookie, draftId);
      } else if (sub === "edit" || sub === "update") {
        // drafts edit <draft-id> [--code=XXXX] <text...>
        const draftId = rest[1];
        const codeArg = rest.find((a) => a.startsWith("--code="))?.slice(7);
        const textParts = rest.slice(2).filter((a) => !a.startsWith("--code="));
        const text = textParts.join(" ");
        if (!draftId || !text) {
          console.error("Usage: slack drafts edit <draft-id> <new-text>");
          process.exit(2);
        }
        const listResp = (await listDrafts(token, cookie)) as Record<string, Json>;
        const d = asArray(listResp.drafts).map(asRecord).find((x) => String(x.id) === draftId);
        if (!d) { console.error(`Draft not found: ${draftId}`); process.exit(1); }
        const prevText = draftText(d);
        const code = safetyCode(prevText, text);
        if (codeArg !== code) {
          requireCode(codeArg, code, [
            `─── Current draft content ────────────────────`,
            ...prevText.split("\n").map((l) => `  ${l}`),
            `─── Replacing with ───────────────────────────`,
            ...text.split("\n").map((l) => `  ${l}`),
            `─────────────────────────────────────────────`,
          ]);
        }
        const channelId = draftChannelId(d);
        const resp = (await updateDraft(token, draftId, channelId, text, cookie)) as Record<string, Json>;
        console.log(`✓ Draft updated (id: ${asRecord(resp.draft).id ?? "?"})`);
      } else if (sub === "delete" || sub === "rm") {
        const draftId = rest[1];
        const codeArg = rest.find((a) => a.startsWith("--code="))?.slice(7);
        if (!draftId) { console.error("Usage: slack drafts delete <draft-id>"); process.exit(2); }
        const listResp = (await listDrafts(token, cookie)) as Record<string, Json>;
        const d = asArray(listResp.drafts).map(asRecord).find((x) => String(x.id) === draftId);
        if (!d) { console.error(`Draft not found: ${draftId}`); process.exit(1); }
        const prevText = draftText(d);
        const code = safetyCode(draftId, prevText);
        if (codeArg !== code) {
          requireCode(codeArg, code, [
            `─── Deleting draft ───────────────────────────`,
            `  id: ${draftId}`,
            ...prevText.split("\n").map((l) => `  ${l}`),
            `─────────────────────────────────────────────`,
          ]);
        }
        await deleteDraft(token, draftId, cookie);
        console.log(`✓ Draft deleted (id: ${draftId})`);
      } else {
        const showAll = rest.includes("--all") || rest.includes("-a");
        await cmdDrafts(token, cookie, showAll);
      }
      return;
    }
    case "search": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { count: { type: "string", short: "n", default: "100" } },
        strict: true,
      });
      const query = positionals[0];
      if (!query) usage();
      await cmdSearch(token, query, Number(values.count));
      return;
    }
    case "send": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          thread: { type: "string" },
          code: { type: "string" },
          "channel-id": { type: "string" },
          "user-id": { type: "string" },
        },
        strict: true,
      });
      const target = positionals[0];
      const message = positionals[1];
      if (!target || !message) usage();
      const sendArgs: SendArgs = { target, message };
      if (values.thread !== undefined) sendArgs.thread = values.thread;
      if (values.code !== undefined) sendArgs.code = values.code;
      if (values["channel-id"] !== undefined) sendArgs.channelId = values["channel-id"];
      if (values["user-id"] !== undefined) sendArgs.userId = values["user-id"];
      await cmdSend(token, sendArgs);
      return;
    }
    case "dump": {
      const { values } = parseArgs({
        args: rest,
        options: {
          days: { type: "string", short: "d", default: "7" },
          limit: { type: "string", short: "l", default: "200" },
          filter: { type: "string", short: "f" },
        },
        strict: true,
      });
      await cmdDump(token, Number(values.days), Number(values.limit), values.filter);
      return;
    }
    default:
      usage();
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
