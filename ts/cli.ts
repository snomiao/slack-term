#!/usr/bin/env bun
// Slack CLI entry — mirrors the Rust impl in src/main.rs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { listProfiles, removeProfile, resolveBotToken, resolveCookie, resolveToken, useProfile, type Profile } from "./profiles.ts";
import { diagnoseBotMessaging, formatDiagnosis } from "./botdoctor.ts";
import { cmdAuthLogin, cmdAuthChrome, cmdAuthFirefox, cmdAuthToken, cmdAuthApp } from "./auth.ts";
import { cmdTail } from "./tail.ts";

import {
  authTest,
  authScopes,
  authTestSession,
  conversationInfoSession,
  createChannel,
  inviteToChannel,
  createDraft,
  deleteDraft,
  updateDraft,
  editMessage,
  deleteMessage,
  reactionAdd,
  reactionRemove,
  filesInfo,
  filesList,
  history,
  listConversations,
  listDrafts,
  listUsers,
  userInfo,
  conversationInfo,
  openDm,
  parseSlackPermalink,
  replies,
  resolveChannel,
  resolveUserId,
  search,
  searchAll,
  send as slackSend,
  getPermalink,
  scheduleMessage,
  listScheduledMessages,
  deleteScheduledMessage,
  uploadFile,
  userInfoPair,
  userName,
  getPath,
  type Json,
} from "./slack.ts";
import { dayLabel, encodeMentions, encodeMentionsDetailed, findUntaggedMentions, formatYmdHm, mentionWarnings, resolveDateMarkup, resolveMentions, type MentionEncodeResult } from "./format.ts";

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

// Lossless Slack ts → ISO string: "2026-05-11T06:01:04.000100"
function slackTsToIso(tsRaw: string): string {
  const [secStr, fracStr = "000000"] = tsRaw.split(".");
  const epochSec = Number(secStr);
  const d = new Date(epochSec * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  const frac = fracStr.padEnd(6, "0").slice(0, 6);
  return `${y}-${mo}-${da}T${h}:${mi}:${s}.${frac}`;
}

// Parse ISO ts back to Slack ts — throws if fractional is absent or not exactly 6 digits.
function isoToSlackTs(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})$/);
  if (!m) throw new Error(`Invalid message timestamp "${iso}" — expected 2026-05-11T06:01:04.000100`);
  const epochMs = Date.parse(m[1] + "Z");
  if (isNaN(epochMs)) throw new Error(`Cannot parse date in "${iso}"`);
  return `${Math.floor(epochMs / 1000)}.${m[2]}`;
}

function parseInputTs(s: string): string {
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? isoToSlackTs(s) : s;
}

// Format one message line: `[ts]  @handle  text` (UTC). Pass chLabel (e.g. "#general") for search.
async function formatMsgLine(
  token: string,
  m: Record<string, Json>,
  cache: Map<string, string>,
  chLabel?: string,
): Promise<string> {
  const rawTs = typeof m.ts === "string" ? m.ts : `${tsNum(m)}.000000`;
  const stamp = slackTsToIso(rawTs);
  let handle = "?";
  if (typeof m.user === "string") {
    const uid = m.user;
    const handleKey = "@" + uid;
    if (!cache.has(handleKey)) {
      const [, h] = await userInfoPair(token, uid);
      cache.set(handleKey, h);
    }
    handle = cache.get(handleKey) ?? uid;
  } else if (typeof m.username === "string") {
    handle = m.username;
  }
  const raw = typeof m.text === "string" ? m.text : "";
  const resolved = resolveDateMarkup(await resolveMentions(token, raw, cache));
  const lines = resolved.split("\n");
  const body = lines[0] + (lines.length > 1 ? "\n" + lines.slice(1).map(l => `  ${l}`).join("\n") : "");
  const who = chLabel ? `${chLabel}  @${handle}` : `@${handle}`;
  const reactions = asArray(m.reactions)
    .map(asRecord)
    .map((r) => {
      const name = typeof r.name === "string" ? r.name : "";
      const count = Number(r.count ?? asArray(r.users).length ?? 0);
      return name ? `:${name}:×${count}` : "";
    })
    .filter(Boolean)
    .join(" ");
  const attachTail = asArray(m.files)
    .map(asRecord)
    .map((f) => {
      const name = typeof f.name === "string" ? f.name : typeof f.title === "string" ? f.title : "(file)";
      const sz = typeof f.size === "number" ? `  (${fmtSize(f.size)})` : "";
      const id = typeof f.id === "string" ? `  [${f.id}]` : "";
      return `\n   📎 ${name}${sz}${id}`;
    })
    .join("");
  const tail = (reactions ? `\n   ${reactions}` : "") + attachTail;
  return `${stamp}  ${who}:  ${body}${tail}`;
}

// Human-readable byte size, shared by upload/download/attachment rendering.
function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

// Slim a message's file attachments to the fields a script needs to detect and
// fetch them: id (for `slack download`), name, size, mimetype, and the two URLs.
function slimFiles(m: Record<string, Json>): Record<string, Json>[] {
  return asArray(m.files)
    .map(asRecord)
    .map((f) => ({
      id: f.id ?? null,
      name: f.name ?? f.title ?? null,
      mimetype: f.mimetype ?? null,
      size: f.size ?? null,
      url_private_download: f.url_private_download ?? f.url_private ?? null,
      permalink: f.permalink ?? null,
    }));
}

// Slim a raw message down to the fields a script actually needs. Keeps the
// author's user ID (incl. external / Slack-Connect guests that never appear in
// users.list) so callers can resolve mentions without scraping history by hand.
function slimMsg(m: Record<string, Json>): Record<string, Json> {
  const files = slimFiles(m);
  return {
    ts: m.ts ?? null,
    user: m.user ?? null,
    username: m.username ?? null,
    bot_id: m.bot_id ?? null,
    thread_ts: m.thread_ts ?? null,
    text: typeof m.text === "string" ? m.text : "",
    // Present only when the message carries attachments, so scripts can reliably
    // detect files without the key adding noise to every plain-text line.
    ...(files.length > 0 ? { files } : {}),
  };
}

// --- msgs <target> — channel/DM history with timestamps ---
async function cmdMsgsTarget(token: string, target: string, limit: number, format: "text" | "jsonl" = "text"): Promise<void> {
  const parsed = parseSlackPermalink(target);
  const channelId = await resolveChannel(token, target);
  const cache = new Map<string, string>();
  const fetchMsgs = async (): Promise<Record<string, Json>[]> => {
    if (parsed?.threadTs) {
      const resp = (await replies(token, channelId, parsed.threadTs, limit)) as Record<string, Json>;
      return asArray(resp.messages).map(asRecord);
    }
    const hist = (await history(token, channelId, limit)) as Record<string, Json>;
    return asArray(hist.messages).map(asRecord).reverse();
  };
  const msgs = await fetchMsgs();
  if (format === "jsonl") {
    for (const m of msgs) console.log(JSON.stringify(slimMsg(m)));
    return;
  }
  for (const m of msgs) {
    console.log(await formatMsgLine(token, m, cache));
  }
}

// --- thread ---
async function cmdThread(token: string, target: string, ts: string, limit: number, format: "text" | "jsonl" = "text"): Promise<void> {
  const channelId = await resolveChannel(token, target);
  const resp = (await replies(token, channelId, parseInputTs(ts), limit)) as Record<string, Json>;
  const msgs = asArray(resp.messages).map(asRecord);
  if (format === "jsonl") {
    for (const m of msgs) console.log(JSON.stringify(slimMsg(m)));
    return;
  }
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
      .slice(0, 3)
      .reverse();
    if (msgs.length === 0) continue;
    console.log(`-- #${name} --------------------------------`);
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
  const matches = asArray(getPath(resp, ["messages", "matches"])).map(asRecord).slice(0, limit);
  const cache = new Map<string, string>();

  // Group by day (API returns newest-first; reverse within each group for chronological reading)
  const groups: { label: string; msgs: Record<string, Json>[] }[] = [];
  for (const m of matches) {
    const label = dayLabel(tsNum(m));
    const last = groups[groups.length - 1];
    if (last?.label === label) last.msgs.push(m);
    else groups.push({ label, msgs: [m] });
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const { label, msgs } = groups[gi]!;
    if (gi > 0) console.log("");
    console.log(`  ${label}`);
    console.log("  ----------------------------");
    for (const m of [...msgs].reverse()) {
      const ch = asRecord(m.channel);
      const isIm = ch.is_im === true;
      const rawName = typeof ch.name === "string" ? ch.name : "dm";
      let chLabel: string;
      if (isIm && rawName.startsWith("U")) {
        const handleKey = "@" + rawName;
        if (!cache.has(handleKey)) {
          const [, h] = await userInfoPair(token, rawName);
          cache.set(handleKey, h);
        }
        chLabel = `@${cache.get(handleKey) ?? rawName}`;
      } else if (isIm) {
        chLabel = `@${rawName}`;
      } else {
        chLabel = `#${rawName}`;
      }
      console.log(await formatMsgLine(token, m, cache, chLabel));
    }
  }
}

// --- channels ---
async function cmdChannels(token: string, limit: number, filter?: string, all?: boolean, format = "text"): Promise<void> {
  const resp = (await listConversations(token)) as Record<string, Json>;
  const channels = asArray(resp.channels)
    .map(asRecord)
    .filter((c) => all || c.is_member === true)
    .filter((c) => {
      if (!filter) return true;
      const n = typeof c.name === "string" ? c.name : "";
      return n.toLowerCase().includes(filter.toLowerCase());
    })
    .sort((a, b) => Number(b.updated ?? 0) - Number(a.updated ?? 0))
    .slice(0, limit);

  if (format === "jsonl") {
    for (const ch of channels) console.log(JSON.stringify(ch));
    return;
  }
  for (const ch of channels) {
    const id = String(ch.id ?? "");
    const name = typeof ch.name === "string" ? ch.name : typeof ch.user === "string" ? ch.user : id;
    const isIm = ch.is_im === true;
    const isMpim = ch.is_mpim === true;
    const prefix = isIm || isMpim ? "@" : "#";
    const memberMark = ch.is_member === true ? "" : " (not joined)";
    const purpose = typeof asRecord(ch.purpose).value === "string" ? String(asRecord(ch.purpose).value) : "";
    const meta = purpose ? `  ${purpose.split("\n")[0]?.slice(0, 60)}` : "";
    console.log(`${prefix}${name}  ${id}${memberMark}${meta}`);
  }
}

// --- search ---

/** search.messages (and most read/write Web API methods) reject a bot token
 *  (xoxb-) with not_allowed_token_type — it's a user-only endpoint. Find a
 *  sibling profile that holds a user token (xoxp-/xoxc-) for the *same*
 *  workspace (teamId) as the bot profile currently in use, so the caller can
 *  retry with it automatically instead of just erroring. Deliberately does
 *  NOT fall back to a user-token profile for a different workspace — that
 *  would silently run the search against the wrong (possibly private)
 *  workspace instead of failing loudly. Returns undefined (no fallback) when
 *  the current token isn't a known profile at all, since its workspace can't
 *  be verified. */
function findUserTokenProfile(currentToken: string): { name: string; profile: Profile } | undefined {
  const isUserToken = (t: string) => t.startsWith("xoxp-") || t.startsWith("xoxc-");
  const profiles = listProfiles();
  const current = profiles.find((p) => p.profile.token === currentToken);
  if (!current) return undefined;
  return profiles.find((p) => isUserToken(p.profile.token) && p.profile.teamId === current.profile.teamId);
}

async function cmdSearch(token: string, query: string, count: number, json: boolean, cookie?: string): Promise<void> {
  let searchToken = token;
  let searchCookie = cookie;
  let resp: Json;
  try {
    resp = await searchAll(searchToken, query, count, searchCookie);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (token.startsWith("xoxb-") && msg.includes("not_allowed_token_type")) {
      const fallback = findUserTokenProfile(token);
      if (fallback) {
        console.error(`Note: search.messages needs a user token — the active profile is a bot token (xoxb-); falling back to profile "${fallback.name}".`);
        searchToken = fallback.profile.token;
        searchCookie = fallback.profile.cookie;
        resp = await searchAll(searchToken, query, count, searchCookie);
      } else {
        console.error(
          "Error: search requires a user token (xoxp-/xoxc-) — the active profile is a bot token (xoxb-), which Slack rejects for search.messages.\n" +
          "  Add a user-token profile:  slack auth login   (or slack auth token)\n" +
          "  Then select it:            slack auth use <name>   (or pass --workspace <name>)",
        );
        process.exit(1);
      }
    } else {
      throw e;
    }
  }
  if (json) {
    console.log(JSON.stringify(resp, null, 2));
    return;
  }
  const matches = asArray(getPath(resp as Record<string, Json>, ["messages", "matches"])).map(asRecord);
  const cache = new Map<string, string>();
  for (const m of matches) {
    const ch = asRecord(m.channel);
    const isIm = ch.is_im === true;
    const rawName = typeof ch.name === "string" ? ch.name : "dm";
    let chLabel: string;
    if (isIm && rawName.startsWith("U")) {
      const handleKey = "@" + rawName;
      if (!cache.has(handleKey)) {
        const [, h] = await userInfoPair(searchToken, rawName, searchCookie);
        cache.set(handleKey, h);
      }
      chLabel = `@${cache.get(handleKey) ?? rawName}`;
    } else if (isIm) {
      chLabel = `@${rawName}`;
    } else {
      chLabel = `#${rawName}`;
    }
    console.log(await formatMsgLine(searchToken, m, cache, chLabel));
  }
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
    console.log(`-- ${id}  ${chLabel}  [${stamp}]${sentTag}`);
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

/** Strip ANSI escape sequences and control characters before drawing text the
 *  terminal treats as trusted. Slack lets any user pick their own display name,
 *  so an attacker could embed color/cursor codes; neutralize them here. */
function stripTerminalControls(s: string): string {
  return s
    // CSI sequences (colors, cursor moves, …)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
    // any remaining control chars, including a lone ESC and C1 range
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    // Unicode bidi controls (marks, embeddings, overrides, isolates) — a crafted
    // display name could use these to spoof or reorder the rendered line.
    // ALM, LRM/RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI.
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

// Slack API method → the token scope that grants it, for missing_scope guidance.
const SCOPE_FOR_METHOD: Record<string, string> = {
  "reactions.add": "reactions:write",
  "reactions.remove": "reactions:write",
  "chat.postMessage": "chat:write",
  "chat.update": "chat:write",
  "chat.delete": "chat:write",
  "conversations.replies": "channels:history (or groups:history)",
  "conversations.history": "channels:history (or groups:history)",
};

/** Turn a raw Slack API error into a single clean line of guidance, hiding the
 *  yargs usage dump / stack trace that a thrown handler would otherwise print.
 *  Recognizes the common reaction/message failure codes; falls back to the
 *  original message for anything unmapped. */
function friendlySlackError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/Slack error on (\S+): (\w+)/);
  if (!m) return raw;
  const [, method, code] = m;
  switch (code) {
    case "missing_scope": {
      const scope = SCOPE_FOR_METHOD[method!] ?? "the required";
      // Note the token-type gotcha: the CLI uses the USER token (xoxp) by default,
      // so the scope must be in "User Token Scopes" — adding it only to "Bot Token
      // Scopes" fixes `--as-bot`/`doctor` but not the default path. Then reinstall.
      return `Error: token lacks the ${scope} scope (needed for ${method}). Add it to your Slack App's User Token Scopes (or Bot Token Scopes if you use a bot token / --as-bot) — it must be on the token type the CLI actually uses — then reinstall to the workspace.`;
    }
    case "invalid_name":
      return `Error: not a valid emoji shortcode — use the name without colons (e.g. white_check_mark), and make sure it exists in the workspace.`;
    case "already_reacted":
      return `Error: you've already added that reaction to the message.`;
    case "no_reaction":
      return `Error: that reaction isn't on the message — nothing to remove.`;
    case "message_not_found":
      return `Error: no message found at that timestamp in the channel — check the target ts/permalink.`;
    case "channel_not_found":
      return `Error: channel not found — check the target.`;
    default:
      return raw;
  }
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

/** Split a target ref that may embed a message ts.
 *  Accepts: `#chan:1700000000.000100`, `#chan:2026-05-11T06:01:04.000100`, Slack permalink URL, or plain ref.
 *  Throws if an ISO-format ts is present but missing the required 6-digit fractional part. */
function splitRefTs(s: string): { ref: string; ts?: string } {
  const url = parseSlackPermalink(s);
  if (url) return url.ts ? { ref: url.channel, ts: url.ts } : { ref: url.channel };
  if (s.startsWith("#") || s.startsWith("@")) {
    const colon = s.indexOf(":");
    if (colon > 0) {
      const maybeTs = s.slice(colon + 1);
      if (/^\d{10}\.\d{6}$/.test(maybeTs)) {
        return { ref: s.slice(0, colon), ts: maybeTs };
      }
      if (/^\d{4}-\d{2}-\d{2}T/.test(maybeTs)) {
        return { ref: s.slice(0, colon), ts: isoToSlackTs(maybeTs) };
      }
    }
  }
  return { ref: s };
}

/** Parse a send/upload target that may embed a thread_ts after `:`.
 *  Accepts: `#chan:1700000000.000100`, `@user:ts`, `RAWID:ts`, Slack permalink, or plain ref.
 *  A message permalink targets that message's thread — `?thread_ts=` (the parent) wins when
 *  present, otherwise the message's own ts. A channel-only permalink stays top-level. */
function parseTargetThread(s: string): { ref: string; threadTs?: string } {
  const url = parseSlackPermalink(s);
  if (url) {
    const threadTs = url.threadTs ?? url.ts;
    return threadTs ? { ref: url.channel, threadTs } : { ref: url.channel };
  }
  const colon = s.indexOf(":");
  if (colon > 0) {
    const maybeTs = s.slice(colon + 1);
    if (/^\d{10}\.\d{6}$/.test(maybeTs)) return { ref: s.slice(0, colon), threadTs: maybeTs };
    if (/^\d{4}-\d{2}-\d{2}T/.test(maybeTs)) return { ref: s.slice(0, colon), threadTs: isoToSlackTs(maybeTs) };
  }
  return { ref: s };
}

/** Human-readable destination label for confirm gates, e.g. "#general (C00000001)".
 *  When ref is already a #channel/@user label, keep it; otherwise resolve the channel
 *  name via conversations.info (fail-soft: a raw ID is still unambiguous). */
async function destLabel(token: string, channelId: string, ref: string, cookie?: string): Promise<string> {
  let name = ref;
  if (!ref.startsWith("#") && !ref.startsWith("@")) {
    try {
      const info = asRecord((await conversationInfo(token, channelId, cookie)) as Json);
      const ch = asRecord(info.channel);
      if (ch.is_im === true) {
        const uid = typeof ch.user === "string" ? ch.user : "";
        name = uid ? `@${await userName(token, uid, cookie)}` : channelId;
      } else {
        name = typeof ch.name === "string" ? `#${ch.name}` : channelId;
      }
    } catch {
      name = channelId;
    }
  }
  return name === channelId ? channelId : `${name} (${channelId})`;
}

/** One-line description of a single thread message for confirm gates:
 *  "2026-06-11 08:05 @handle: head…". `headLen` bounds the text preview. */
async function threadMsgLine(token: string, m: Record<string, Json>, headLen = 60, cookie?: string): Promise<string> {
  const author = typeof m.user === "string"
    ? await userName(token, m.user, cookie)
    : typeof m.username === "string"
    ? m.username
    : "?";
  const head = (typeof m.text === "string" ? m.text : "").split("\n")[0] ?? "";
  const headShort = head.length > headLen ? `${head.slice(0, headLen)}…` : head;
  const ts = typeof m.ts === "string" ? m.ts : "";
  const stamp = ts ? slackTsToIso(ts).slice(0, 16).replace("T", " ") : "";
  return `${stamp} @${author}${headShort ? `: ${headShort}` : ""}`;
}

/** One-line thread-parent description for confirm gates: "2026-06-11 08:05 @handle: head…".
 *  Fail-soft: returns the raw ts if the parent cannot be found. */
async function threadParentLine(token: string, threadTs: string, threadMsgs: Record<string, Json>[], cookie?: string): Promise<string> {
  const parent = threadMsgs.find((m) => String(m.ts) === threadTs) ?? threadMsgs[0];
  if (!parent) return threadTs;
  return threadMsgLine(token, parent, 40, cookie);
}

/** Normalize a message for duplicate comparison: lowercase, collapse whitespace,
 *  strip <@U…>/<#C…> markup and surrounding punctuation so cosmetic differences
 *  (a trailing period, an added mention) don't hide a re-post. */
function normalizeForDup(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[@#!][^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Character-bigram Dice coefficient (0..1) over normalized text — robust to
 *  minor edits, good at catching near-identical re-posts. Identical strings →1;
 *  a shared word or two in otherwise different messages stays low. */
function textSimilarity(a: string, b: string): number {
  const na = normalizeForDup(a);
  const nb = normalizeForDup(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 || bb.size === 0) return 0;
  let overlap = 0;
  for (const [g, count] of ba) {
    const other = bb.get(g);
    if (other) overlap += Math.min(count, other);
  }
  const total = sumCounts(ba) + sumCounts(bb);
  return total === 0 ? 0 : (2 * overlap) / total;
}

function sumCounts(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

// --- edit ---
interface EditArgs {
  target: string;
  newText: string;
  code?: string;
  channelId?: string;
  mentions?: boolean;
  // Session cookie (xoxd) for `token` — required for an xoxc- desktop session
  // token to be accepted by the public Slack API at all.
  cookie?: string;
}
async function cmdEdit(token: string, args: EditArgs): Promise<void> {
  const { ref, ts } = splitRefTs(args.target);
  if (!ts) {
    console.error("Error: target must embed a message ts (e.g. #chan:2026-05-11T06:01:04.000100 or a Slack permalink URL)");
    process.exit(2);
  }

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else channelId = await resolveChannel(token, ref, args.cookie);

  // Fetch the message to display the original text and compute the safety hash.
  const resp = (await replies(token, channelId, ts, 1, args.cookie)) as Record<string, Json>;
  const msgs = asArray(resp.messages).map(asRecord);
  const original = msgs.find((m) => String(m.ts) === ts);
  if (!original) {
    console.error(`Message not found at ts=${ts} in channel ${channelId}`);
    process.exit(1);
  }
  const originalText = typeof original.text === "string" ? original.text : "";

  // Convert @handle → <@USERID> before hashing/editing (unresolved stay as text).
  const newText = args.mentions
    ? await encodeMentions(token, args.newText, channelId, args.cookie ? { cookie: args.cookie } : {})
    : args.newText;

  const code = safetyCode(originalText, newText);
  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Original message -------------------------`,
      ...originalText.split("\n").map((l) => `  ${l}`),
      `--- Replacing with ---------------------------`,
      ...newText.split("\n").map((l) => `  ${l}`),
      `--------------------------------────────────`,
    ]);
  }

  const newTs = await editMessage(token, channelId, ts, newText, args.cookie);
  console.log(`✓ Edited (ts: ${newTs})`);
}

// --- delete ---
interface DeleteArgs {
  target: string;
  code?: string;
  channelId?: string;
  cookie?: string;
}
async function cmdDelete(token: string, args: DeleteArgs): Promise<void> {
  const { ref, ts } = splitRefTs(args.target);
  if (!ts) {
    console.error("Error: target must embed a message ts (e.g. #chan:2026-05-11T06:01:04.000100 or a Slack permalink URL)");
    process.exit(2);
  }

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else channelId = await resolveChannel(token, ref, args.cookie);

  // Fetch the message to display what is being deleted and compute the safety hash.
  const resp = (await replies(token, channelId, ts, 1, args.cookie)) as Record<string, Json>;
  const msgs = asArray(resp.messages).map(asRecord);
  const original = msgs.find((m) => String(m.ts) === ts);
  if (!original) {
    console.error(`Message not found at ts=${ts} in channel ${channelId}`);
    process.exit(1);
  }
  const originalText = typeof original.text === "string" ? original.text : "";

  const code = safetyCode(channelId, ts, originalText);
  if (args.code !== code) {
    const dest = await destLabel(token, channelId, ref, args.cookie);
    requireCode(args.code, code, [
      `--- Deleting message -------------------------`,
      `  → ${dest} at ${slackTsToIso(ts)}`,
      ...originalText.split("\n").map((l) => `  ${l}`),
      `---------------------------------------------`,
    ]);
  }

  await deleteMessage(token, channelId, ts, args.cookie);
  console.log(`✓ Deleted (ts: ${ts})`);
}

// --- react ---
interface ReactArgs {
  target: string;
  emoji: string;
  remove?: boolean;
  channelId?: string;
  cookie?: string;
}
// Add (or --remove) an emoji reaction. No confirm gate: a reaction is trivial
// and fully reversible (`--remove`), and the whole point is a lightweight ack
// that doesn't grow the thread. The emoji is a shortcode without colons
// (e.g. "eyes", "white_check_mark", "hourglass").
async function cmdReact(token: string, args: ReactArgs): Promise<void> {
  const { ref, ts } = splitRefTs(args.target);
  if (!ts) {
    console.error("Error: target must embed a message ts (e.g. #chan:2026-05-11T06:01:04.000100 or a Slack permalink URL)");
    process.exit(2);
  }
  const emoji = args.emoji.replace(/^:|:$/g, "");

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else channelId = await resolveChannel(token, ref, args.cookie);

  if (args.remove) {
    await reactionRemove(token, channelId, ts, emoji, args.cookie);
    console.log(`✓ Removed :${emoji}: (ts: ${ts})`);
  } else {
    await reactionAdd(token, channelId, ts, emoji, args.cookie);
    console.log(`✓ Reacted :${emoji}: (ts: ${ts})`);
  }
}

// --- send ---
interface SendArgs {
  target: string;
  message: string;
  code?: string;
  channelId?: string;
  userId?: string;
  asBot?: boolean;
  broadcast?: boolean;
  mentions?: boolean;
  // Token used to resolve @handle mentions (needs users:read). Defaults to the
  // send token; set to the user token when sending --as-bot so the bot token
  // need not carry users:read.
  mentionToken?: string;
  // Session cookie (xoxd) for the mention token — required for an xoxc- user
  // token to call users.list on the public API (it is rejected without it).
  mentionCookie?: string;
  // Session cookie (xoxd) for `token` itself — required for an xoxc- desktop
  // session token to be accepted by the public Slack API at all (chat.postMessage
  // included). Not set when sending --as-bot (the bot token needs no cookie).
  cookie?: string;
}

// Detect the silent-failure footgun: DMing yourself with your own user token.
// Slack does not notify you about messages you sent to yourself, so an
// escalation DM via `send @me` (or @your-own-handle) is delivered but never
// surfaces. Returns true when ref names the token's own user.
async function isSelfDm(token: string, ref: string, cookie?: string): Promise<boolean> {
  if (!ref.startsWith("@")) return false;
  const name = ref.slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (name === "me" || name === "you") return true;
  try {
    const self = await authTest(token, cookie);
    const selfName = (self.user ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return selfName !== "" && selfName === name;
  } catch {
    return false;
  }
}

async function cmdSend(token: string, args: SendArgs): Promise<void> {
  const { ref, threadTs } = parseTargetThread(args.target);
  const cookie = args.cookie;

  // Guard the self-DM footgun before doing anything else, unless sending as the
  // bot (which delivers a notifiable DM from a different identity).
  if (!args.asBot && !args.channelId && !args.userId && await isSelfDm(token, ref, cookie)) {
    console.error(
      `Warning: "${ref}" is a DM to yourself — Slack will NOT notify you of your own message.\n` +
      `  To reach yourself with a notification, send as the bot:  slack send '${ref}' '...' --as-bot`,
    );
  }

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId, cookie);
  else channelId = await resolveChannel(token, ref, cookie);

  // Convert @handle / @名前 tokens to <@USERID> before hashing/sending so the
  // safety gate covers exactly what will be posted. Unresolved tokens stay as
  // text. The detailed report drives the confirm-gate mention preview below.
  let message = args.message;
  let mentionReport: MentionEncodeResult | null = null;
  if (args.mentions) {
    mentionReport = await encodeMentionsDetailed(args.mentionToken ?? token, args.message, channelId, args.mentionCookie);
    message = mentionReport.text;
    // Prominent, always-visible warning for any @token that will NOT notify —
    // so a mistyped or unresolved name (esp. a Japanese display name) is caught
    // before it goes out as inert plain text. Shown even when --code is passed.
    // Wording is shared with the library wrapper via mentionWarnings(). Strip
    // control chars — the surfaces embed Slack-controlled display text.
    for (const line of mentionWarnings(mentionReport.unresolved)) console.error(`⚠ ${stripTerminalControls(line)}`);
  }

  // Warn-only lint: names written as plain text (no leading @) that map to a
  // known workspace member but aren't <@USERID>-tagged — they won't be notified.
  // Never blocks; fail-soft (a missing users:read scope or API error must not
  // stall a send).
  try {
    for (const u of await findUntaggedMentions(args.mentionToken ?? token, message, args.mentionCookie)) {
      // u.surface / u.display carry Slack-controlled display text — strip control chars.
      console.error(`⚠ possible untagged mention: ${stripTerminalControls(u.surface)} — @${stripTerminalControls(u.display)} won't be notified (did you mean <@${u.userId}>?)`);
    }
  } catch {
    // best-effort; ignore
  }

  // Confirm-gate mention preview: exactly who resolves (→ notified) and who
  // stays literal. Inserted into the dry-run block so the sender eyeballs the
  // tagging before committing with --code.
  const mentionLines: string[] = [];
  if (mentionReport && (mentionReport.resolved.length > 0 || mentionReport.unresolved.length > 0)) {
    mentionLines.push(`--- Mentions ---------------------------------`);
    for (const r of mentionReport.resolved) {
      mentionLines.push(`  ✓ ${stripTerminalControls(r.surface)} → @${stripTerminalControls(r.display)} (${r.userId}) — will notify`);
    }
    for (const u of mentionReport.unresolved) {
      const why = u.reason === "ambiguous" ? "ambiguous" : u.reason === "unavailable" ? "lookup unavailable" : "no match";
      mentionLines.push(`  ⚠ ${stripTerminalControls(u.surface)} — plain text, NOT notified (${why})`);
    }
  }

  // Gather context for the confirm gate. For a THREAD reply, pull the thread's
  // own recent messages so the preview shows what's already been said there —
  // this is what stops accidental duplicate replies (the channel's last message
  // is irrelevant when you're deep in a thread). For a top-level send, fall back
  // to the channel's last message. Fail-soft throughout: a bot token without
  // history scope can still send; only the preview degrades.
  let lastText = "";
  let lastUser = "?";
  let threadMsgs: Record<string, Json>[] = [];
  // Author of the destination's TRUE most recent message (thread-scoped for a
  // thread reply, channel-scoped for a top-level send) — feeds the unreplied-warn
  // check below. Tracks `user` (normal message) and `bot_id` (a `bot_message`
  // subtype post — e.g. `send --as-bot` — which carries bot_id/username but no
  // `user`) so ownership can be determined either way. Undefined when the
  // preview fetch failed (fail-soft).
  let lastMsgUserId: string | undefined;
  let lastMsgBotId: string | undefined;
  let lastMsgTs: string | undefined;
  if (threadTs) {
    try {
      // Fetch a generous window and preview its tail. conversations.replies is
      // oldest-first from the parent, so a very long thread's true tail may lie
      // beyond this window — 100 covers essentially all real threads.
      const resp = (await replies(token, channelId, threadTs, 100, cookie)) as Record<string, Json>;
      threadMsgs = asArray(resp.messages).map(asRecord);
      const lastMsg = threadMsgs[threadMsgs.length - 1];
      // Bind the hash to the thread's most recent message: if someone replies
      // between preview and confirm, the code invalidates and re-previews.
      lastText = typeof lastMsg?.text === "string" ? lastMsg.text : "";
      lastMsgUserId = typeof lastMsg?.user === "string" ? lastMsg.user : undefined;
      lastMsgBotId = typeof lastMsg?.bot_id === "string" ? lastMsg.bot_id : undefined;
      lastMsgTs = typeof lastMsg?.ts === "string" ? lastMsg.ts : undefined;
    } catch {
      // best-effort preview only
    }
  } else {
    try {
      const ctx = (await history(token, channelId, 1, undefined, undefined, cookie)) as Record<string, Json>;
      // limit=1 already narrows this to exactly the channel's true last message
      // (subtype or not) — take it raw for the ownership check below. The
      // subtype filter is only for the human-readable preview text/author: it
      // deliberately hides system events (channel_join etc.), but a bot_message
      // post is a real message and must NOT be dropped here, or a bot's own
      // last post would silently disable the unreplied-warn for --as-bot sends.
      const rawMsgs = asArray(ctx.messages).map(asRecord);
      const lastMsg = rawMsgs.filter((m) => m.subtype === undefined || m.subtype === null)[0];
      lastText = typeof lastMsg?.text === "string" ? lastMsg.text : "";
      // Resolve the author's user ID to a display name for the preview; fall back
      // to the bot username, then the raw ID. userName() is fail-soft.
      lastUser = typeof lastMsg?.user === "string"
        ? await userName(token, lastMsg.user, cookie)
        : typeof lastMsg?.username === "string"
        ? lastMsg.username
        : "?";
      const rawLast = rawMsgs[0];
      lastMsgUserId = typeof rawLast?.user === "string" ? rawLast.user : undefined;
      lastMsgBotId = typeof rawLast?.bot_id === "string" ? rawLast.bot_id : undefined;
      lastMsgTs = typeof rawLast?.ts === "string" ? rawLast.ts : undefined;
    } catch {
      // best-effort preview only
    }
  }

  // Unreplied guard: the destination's last message is our own and no one has
  // replied since (by definition, since it's still the most recent message) —
  // sending another new message risks spamming the same person twice. Warn
  // (never block) and point at `slack edit` on that message instead. Reply-status
  // based, not time-based, so it still fires even long after the last send.
  // Self-identity covers both a normal post (`user` = our user id) and a
  // `bot_message`-subtype post (`bot_id` = our app's bot id, no `user`), the
  // shape `send --as-bot` produces. Opt out with SLACK_UNREPLIED_WARN=0.
  if (process.env.SLACK_UNREPLIED_WARN !== "0" && lastMsgTs && (lastMsgUserId || lastMsgBotId)) {
    try {
      const self = await authScopes(token, cookie);
      const isSelfAuthor =
        (!!lastMsgUserId && !!self.userId && self.userId === lastMsgUserId) ||
        (!!lastMsgBotId && !!self.botId && self.botId === lastMsgBotId);
      if (isSelfAuthor) {
        // Prefer a real permalink (exact, copy-pasteable). If that lookup fails,
        // fall back to a form guaranteed parseable by `slack edit` regardless of
        // what shape `ref` is in (a bare channel/user name, a raw ID resolved
        // from a permalink, or a thread ref) — `#<channelId>:<ts>` always yields
        // a ts split, and `--channel-id` makes the leading "#name" irrelevant to
        // resolution, so it never depends on ref's original prefix or an
        // embedded thread_ts colliding with the appended message ts.
        let editCmd = `slack edit "#${channelId}:${lastMsgTs}" "<新しい本文>" --channel-id ${channelId}`;
        try {
          const permalink = await getPermalink(token, channelId, lastMsgTs, cookie);
          if (permalink) editCmd = `slack edit "${permalink}" "<新しい本文>"`;
        } catch {
          // fall back to the --channel-id form above
        }
        console.error(`⚠ 相手はまだ返信していません(最後のメッセージはあなたのものです)。`);
        console.error(`  連投を避けるため、新規送信でなく直前のメッセージの edit を検討してください:`);
        console.error(`    ${editCmd}`);
        console.error(`  このまま送信する場合は --code=XXXX で確定。`);
      }
    } catch {
      // best-effort; a failed self-identity lookup must not block the send
    }
  }

  // Duplicate guard: if the outgoing message closely matches something already
  // in the thread, warn (never block). Catches re-posting a reply you already
  // sent. Threshold is deliberately high so only near-identical text trips it.
  if (threadTs && threadMsgs.length) {
    let best = { sim: 0, msg: null as Record<string, Json> | null };
    for (const m of threadMsgs) {
      const t = typeof m.text === "string" ? m.text : "";
      if (!t) continue;
      const sim = textSimilarity(message, t);
      if (sim > best.sim) best = { sim, msg: m };
    }
    if (best.msg && best.sim >= 0.82) {
      const pct = Math.round(best.sim * 100);
      console.error(`⚠ possible duplicate: ${pct}% similar to an existing thread message — ${await threadMsgLine(token, best.msg, 60, cookie)}`);
    }
  }

  // Hash covers the destination too — a code minted for one channel/thread
  // cannot confirm a send to another.
  const code = safetyCode(channelId, threadTs ?? "", lastText, message);

  if (args.code !== code) {
    const dest = await destLabel(token, channelId, ref, cookie);
    if (threadTs) {
      const parentLine = await threadParentLine(token, threadTs, threadMsgs, cookie);
      // Preview the tail of the thread (up to 3 most recent messages) so the
      // sender can see what's already been said and avoid repeating it.
      const recent = threadMsgs.slice(-3);
      const recentLines = recent.length
        ? await Promise.all(recent.map(async (m) => `  ${await threadMsgLine(token, m, 60, cookie)}`))
        : ["  (thread context unavailable)"];
      requireCode(args.code, code, [
        `--- Recent messages in thread ----------------`,
        ...recentLines,
        ...mentionLines,
        `--- Sending ----------------------------------`,
        `  → ${dest} thread of ${parentLine} — THREAD REPLY`,
        `  Message: ${message}`,
        `--------------------------------────────────`,
      ]);
    } else {
      requireCode(args.code, code, [
        `--- Last message in channel ------------------`,
        `  ${lastUser}: ${lastText.split("\n")[0]?.slice(0, 100) ?? "(empty)"}`,
        ...mentionLines,
        `--- Sending ----------------------------------`,
        `  → ${dest} — NEW top-level message`,
        `  Message: ${message}`,
        `--------------------------------────────────`,
      ]);
    }
  }
  const ts = await slackSend(token, channelId, message, threadTs, args.broadcast, cookie);
  let permalink = "";
  try {
    permalink = await getPermalink(token, channelId, ts, cookie);
  } catch {
    // fail-soft: getPermalink failure (rate limit, network, etc.) should not
    // mask send success — fall back to ts-only output below.
  }
  if (permalink) {
    console.log(`✓ Sent: ${permalink}`);
  } else {
    console.log(`✓ Sent (ts: ${ts})`);
  }

  // After a bot DM, check the app can actually carry a two-way conversation —
  // an escalation the user can't reply to (Messages Tab off / missing scopes)
  // is worse than useless. Non-fatal: the send already succeeded.
  if (args.asBot && channelId.startsWith("D")) {
    try {
      const diag = await diagnoseBotMessaging(token);
      if (!diag.ok) {
        for (const line of formatDiagnosis(diag, true)) console.error(line);
      } else {
        // Scopes are fine, but the Messages Tab toggle isn't API-detectable.
        const appUrl = diag.appId ? `https://api.slack.com/apps/${diag.appId}` : "https://api.slack.com/apps";
        console.error(
          `Note: if ${args.target} can't reply (app messaging may be off), ` +
          `enable Messages Tab: ${appUrl} → App Home.`,
        );
      }
    } catch {
      // diagnosis is best-effort; never turn a successful send into a failure.
    }
  }
}

async function cmdDoctor(token: string): Promise<void> {
  const diag = await diagnoseBotMessaging(token);
  for (const line of formatDiagnosis(diag, false)) console.log(line);
  if (!diag.ok) process.exit(1);
}

// --- schedule ---
function parsePostAt(at: string): number {
  if (/^\d{10,}$/.test(at)) return parseInt(at, 10);
  const d = new Date(at.replace(" ", "T"));
  if (isNaN(d.getTime())) throw new Error(`Cannot parse time: ${at}`);
  return Math.floor(d.getTime() / 1000);
}

interface ScheduleSendArgs {
  target: string;
  message: string;
  at: string;
  code?: string;
  channelId?: string;
  userId?: string;
  cookie?: string;
}
async function cmdScheduleSend(token: string, args: ScheduleSendArgs): Promise<void> {
  const { ref, threadTs } = parseTargetThread(args.target);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId, args.cookie);
  else channelId = await resolveChannel(token, ref, args.cookie);

  const postAt = parsePostAt(args.at);
  const postAtDate = new Date(postAt * 1000).toISOString();
  const code = safetyCode(channelId, args.message, String(postAt));

  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Scheduling message -----------------------`,
      `  To:      ${ref}${threadTs ? ` (thread ${threadTs})` : ""}`,
      `  At:      ${postAtDate} (Unix: ${postAt})`,
      `  Message: ${args.message}`,
      `---------------------------------------------`,
    ]);
  }
  const id = await scheduleMessage(token, channelId, args.message, postAt, threadTs, args.cookie);
  console.log(`✓ Scheduled (id: ${id}, at: ${postAtDate})`);
}

async function cmdScheduleList(token: string, target?: string, channelId?: string, cookie?: string): Promise<void> {
  let channel: string | undefined;
  if (channelId) {
    channel = channelId;
  } else if (target) {
    channel = await resolveChannel(token, target, cookie);
  }
  const resp = (await listScheduledMessages(token, channel, cookie)) as {
    scheduled_messages?: { id: string; channel_id: string; post_at: number; text: string }[];
  };
  const msgs = resp.scheduled_messages ?? [];
  if (msgs.length === 0) { console.log("(no scheduled messages)"); return; }
  for (const m of msgs) {
    const at = new Date(m.post_at * 1000).toISOString();
    console.log(`${m.id}  ${at}  [${m.channel_id}]  ${m.text.split("\n")[0]?.slice(0, 80) ?? ""}`);
  }
}

interface ScheduleRmArgs {
  target: string;
  id: string;
  code?: string;
  channelId?: string;
  cookie?: string;
}
async function cmdScheduleRm(token: string, args: ScheduleRmArgs): Promise<void> {
  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else channelId = await resolveChannel(token, args.target, args.cookie);

  const code = safetyCode(channelId, args.id);
  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Deleting scheduled message ---------------`,
      `  Channel: ${args.target}`,
      `  ID:      ${args.id}`,
      `---------------------------------------------`,
    ]);
  }
  await deleteScheduledMessage(token, channelId, args.id, args.cookie);
  console.log(`✓ Deleted scheduled message ${args.id}`);
}

// --- upload ---
interface UploadArgs {
  target: string;
  filePaths: string[];
  title?: string;
  comment?: string;
  code?: string;
  channelId?: string;
  userId?: string;
  cookie?: string;
}
async function cmdUpload(token: string, args: UploadArgs): Promise<void> {
  const { statSync, existsSync } = await import("node:fs");
  const { basename } = await import("node:path");

  for (const fp of args.filePaths) {
    if (!existsSync(fp)) {
      console.error(`Error: file not found: ${fp}`);
      process.exit(1);
    }
  }

  const { ref, threadTs } = parseTargetThread(args.target);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId, args.cookie);
  else channelId = await resolveChannel(token, ref, args.cookie);

  const isBatch = args.filePaths.length > 1;
  const files = args.filePaths.map((fp) => {
    const filename = basename(fp);
    const title = isBatch ? filename : (args.title ?? filename);
    return { fp, filename, title, sizeFmt: fmtSize(statSync(fp).size) };
  });

  // Safety code covers the full batch — single-file code is identical to the old formula.
  const code = safetyCode(channelId, ...files.flatMap((f) => [f.fp, f.title]));
  if (args.code !== code) {
    const destLine = `  To:    ${ref}${threadTs ? ` (thread ${threadTs})` : ""}`;
    const lines = isBatch
      ? [
          `--- Uploading ${files.length} files ------------------------`,
          destLine,
          ...files.map((f) => `    ${f.filename}  (${f.sizeFmt})`),
          `--------------------------------────────────`,
        ]
      : [
          `--- Uploading file ---------------------------`,
          destLine,
          `  File:  ${files[0]!.fp}`,
          `  Title: ${files[0]!.title}`,
          `  Size:  ${files[0]!.sizeFmt}`,
          `--------------------------------────────────`,
        ];
    requireCode(args.code, code, lines);
  }

  const total = files.length;
  for (let i = 0; i < total; i++) {
    const f = files[i]!;
    const uploadOpts: { title?: string; threadTs?: string; initialComment?: string } = { title: f.title };
    if (threadTs !== undefined) uploadOpts.threadTs = threadTs;
    if (args.comment !== undefined && i === 0) uploadOpts.initialComment = args.comment;
    const { fileId, permalink } = await uploadFile(token, channelId, f.fp, uploadOpts, args.cookie);
    const prefix = total > 1 ? `[${i + 1}/${total}] ` : "";
    console.log(`${prefix}✓ Uploaded (file_id: ${fileId}${permalink ? `, url: ${permalink}` : ""})`);
  }
}

// --- files ls — list files visible to the token (files.list, read-only) ---
// Walks files.list pages until it has `limit` rows or runs out. Canvases and
// Slack Lists from the web "unified files" view mostly don't appear here (the
// token can't reach those internal APIs) — this lists real file uploads.
async function cmdFilesList(
  token: string,
  cookie: string | undefined,
  opts: { limit: number; types?: string; channel?: string; user?: string; format: string },
): Promise<void> {
  const channelId = opts.channel ? await resolveChannel(token, opts.channel, cookie) : undefined;
  const files: Record<string, Json>[] = [];
  let page = 1;
  let pages = 1;
  do {
    const listOpts: { page: number; count: number; types?: string; channel?: string; user?: string } = { page, count: 200 };
    if (opts.types) listOpts.types = opts.types;
    if (channelId) listOpts.channel = channelId;
    if (opts.user) listOpts.user = opts.user;
    const resp = asRecord((await filesList(token, listOpts, cookie)) as Json);
    for (const f of asArray(resp.files)) files.push(asRecord(f));
    pages = Number(asRecord(resp.paging).pages ?? 1);
    page++;
  } while (files.length < opts.limit && page <= pages);
  const shown = files.slice(0, opts.limit);

  if (opts.format === "jsonl") {
    for (const f of shown) {
      console.log(JSON.stringify({
        id: f.id ?? null,
        name: f.name ?? f.title ?? null,
        filetype: f.filetype ?? null,
        size: f.size ?? null,
        user: f.user ?? null,
        created: f.created ?? null,
        permalink: f.permalink ?? null,
      }));
    }
    return;
  }
  for (const f of shown) {
    const id = String(f.id ?? "");
    const name = typeof f.name === "string" ? f.name : typeof f.title === "string" ? f.title : id;
    const ft = typeof f.filetype === "string" ? f.filetype : "?";
    const size = typeof f.size === "number" ? fmtSize(f.size) : "";
    console.log(`${id}  ${ft.padEnd(7)}  ${size.padStart(9)}  ${name}`);
  }
}

// --- download <ref> [dest] — fetch an attachment's bytes to disk (read-only) ---
// ref: a file ID (F…) or a Slack file permalink (…/files/<UID>/<FID>/<name>).
function parseFileId(ref: string): string | undefined {
  if (/^F[A-Z0-9]+$/i.test(ref)) return ref;
  return ref.match(/\/files\/[A-Za-z0-9]+\/(F[A-Za-z0-9]+)/)?.[1];
}

async function cmdDownload(token: string, cookie: string | undefined, ref: string, dest?: string): Promise<void> {
  const fileId = parseFileId(ref);
  if (!fileId) {
    throw new Error(
      `Not a file ID or file permalink: ${ref}\n` +
      `Expected F… or https://<ws>.slack.com/files/<UID>/<FID>/<name>`,
    );
  }
  const info = asRecord((await filesInfo(token, fileId, cookie)) as Json);
  const f = asRecord(info.file);
  const name = typeof f.name === "string" ? f.name : typeof f.title === "string" ? f.title : fileId;
  const url = typeof f.url_private_download === "string" ? f.url_private_download
    : typeof f.url_private === "string" ? f.url_private : "";
  if (!url) throw new Error(`files.info returned no download URL for ${fileId}`);

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (cookie) headers.Cookie = `d=${cookie}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const { statSync, existsSync } = await import("node:fs");
  const { basename } = await import("node:path");
  let outPath = dest ?? name;
  if (dest && existsSync(dest) && statSync(dest).isDirectory()) outPath = join(dest, basename(name));
  writeFileSync(outPath, buf);
  console.log(`✓ Downloaded ${name} (${fmtSize(buf.length)}) → ${outPath}`);
}

// --- dispatch ---

async function main(): Promise<void> {
  loadDotenvFiles();

  type W = { workspace?: string };
  const tok = (a: W) => resolveToken(a.workspace);
  const ck = (a: W) => resolveCookie(a.workspace);

  await yargs(hideBin(process.argv))
    .scriptName("slack")
    // A thrown handler error (e.g. a Slack API failure) is a runtime error, not a usage
    // mistake — print just the clean one-line message, never the command's --help block or a
    // minified source stack. Reserve the usage/help output for actual argument-parse errors
    // (err is undefined then). showHelpOnFail(false) stops yargs' default help dump.
    .showHelpOnFail(false)
    .fail((msg, err, y) => {
      if (err) {
        console.error(err.message);
        process.exit(1);
      }
      console.error(msg);
      console.error("");
      y.showHelp();
      process.exit(1);
    })
    .option("workspace", { alias: "w", type: "string", describe: "Workspace name" })
    .middleware(async (argv) => {
      const cmd = String((argv._ ?? [])[0] ?? "");
      if (!cmd || cmd === "auth" || cmd === "login") return;
      try {
        resolveToken((argv as W).workspace);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("No profiles configured")) {
          console.log("No workspace configured. Let's set that up:\n");
          await cmdAuthLogin();
          process.exit(0);
        }
        throw e;
      }
    }, true)
    .command(
      ["read [target]", "msgs [target]"],
      "Browse messages",
      (y) => y
        .positional("target", { type: "string", describe: "#channel, @user, or URL" })
        .option("limit", { alias: "n", type: "number", default: 20, describe: "Number of messages" })
        .option("format", { type: "string", choices: ["text", "jsonl"] as const, default: "text", describe: "jsonl exposes raw ts/user/text (incl. external-guest user IDs)" })
        .option("json", { type: "boolean", default: false, describe: "Alias for --format=jsonl" }),
      async (argv) => {
        const token = tok(argv as W);
        const format = argv.json ? "jsonl" : (argv.format as "text" | "jsonl");
        if (argv.target) await cmdMsgsTarget(token, argv.target, argv.limit, format);
        else await cmdMsgs(token);
      },
    )
    .command(
      "thread <target> <ts>",
      "Show thread messages",
      (y) => y
        .positional("target", { type: "string", demandOption: true })
        .positional("ts", { type: "string", demandOption: true })
        .option("limit", { alias: "n", type: "number", default: 100 })
        .option("format", { type: "string", choices: ["text", "jsonl"] as const, default: "text", describe: "jsonl exposes raw ts/user/text (incl. external-guest user IDs)" })
        .option("json", { type: "boolean", default: false, describe: "Alias for --format=jsonl" }),
      async (argv) => {
        const format = argv.json ? "jsonl" : (argv.format as "text" | "jsonl");
        await cmdThread(tok(argv as W), argv.target!, argv.ts!, argv.limit, format);
      },
    )
    .command(
      ["channel", "channels", "ch"],
      "Channel commands",
      (y) => y
        .command(
          ["ls", "list"],
          "List channels",
          (y2) => y2
            .option("limit", { alias: "n", type: "number", default: 200 })
            .option("filter", { alias: "f", type: "string" })
            .option("all", { type: "boolean", default: false })
            .option("format", { type: "string", choices: ["text", "jsonl"] as const, default: "text" })
            .option("json", { type: "boolean", default: false, describe: "Alias for --format=jsonl" }),
          async (argv) => {
            await cmdChannels(tok(argv as W), argv.limit, argv.filter, argv.all, argv.json ? "jsonl" : argv.format);
          },
        )
        .command(
          "get <channel>",
          "Show channel details",
          (y2) => y2.positional("channel", { type: "string", demandOption: true, describe: "#name or channel ID" }),
          async (argv) => {
            const token = tok(argv as W);
            const cookie = ck(argv as W);
            const ref = argv.channel!;
            const channelRef = ref.startsWith("#") || ref.startsWith("@") || ref.startsWith("C") || ref.startsWith("G") || ref.startsWith("D") ? ref : `#${ref}`;
            const channelId = await resolveChannel(token, channelRef, cookie);
            const resp = asRecord((await conversationInfo(token, channelId, cookie)) as Json);
            const ch = asRecord(resp.channel);
            const name = typeof ch.name === "string" ? ch.name : channelId;
            const isIm = ch.is_im === true;
            const prefix = isIm ? "@" : "#";
            const purpose = String(asRecord(ch.purpose).value ?? "");
            const topic = String(asRecord(ch.topic).value ?? "");
            const memberCount = ch.num_members ?? ch.member_count ?? "";
            console.log(`${prefix}${name}  ${channelId}`);
            if (topic) console.log(`topic:   ${topic}`);
            if (purpose) console.log(`purpose: ${purpose}`);
            if (memberCount) console.log(`members: ${memberCount}`);
            console.log(`private: ${ch.is_private === true}`);
          },
        )
        .command(
          ["create <name>", "new <name>"],
          "Create a channel (confirm-hash safety gate)",
          (y2) => y2
            .positional("name", { type: "string", demandOption: true, describe: "Channel name (Slack lowercases it; no spaces)" })
            .option("private", { type: "boolean", default: false, describe: "Create a private channel" })
            .option("invite", { type: "string", array: true, default: [], describe: "Users to invite after creating (@handle or Uxxxx, repeatable)" })
            .option("code", { type: "string", describe: "Safety hash to confirm create" }),
          async (argv) => {
            const token = tok(argv as W);
            const cookie = ck(argv as W);
            // Slack lowercases and strips the leading #; normalize for preview + code.
            const name = argv.name!.replace(/^#/, "").toLowerCase();
            const isPrivate = argv.private === true;
            const invites = (argv.invite as string[]).filter(Boolean);
            const code = safetyCode(name, String(isPrivate), invites.join(","));
            if (argv.code !== code) requireCode(argv.code, code, [
              `--- Creating channel -------------------------`,
              `  name:    ${isPrivate ? "🔒 " : "#"}${name}`,
              `  private: ${isPrivate}`,
              ...(invites.length ? [`  invite:  ${invites.join(", ")}`] : []),
              `--------------------------------────────────`,
            ]);
            let created: { id: string; name: string };
            try {
              created = await createChannel(token, name, isPrivate, cookie);
            } catch (e: unknown) {
              console.error(e instanceof Error ? e.message : String(e));
              process.exit(1);
            }
            console.log(`✓ Created ${isPrivate ? "🔒 " : "#"}${created.name}  (${created.id})`);
            if (invites.length) {
              const ids: string[] = [];
              for (const ref of invites) {
                try {
                  ids.push(ref.startsWith("U") || ref.startsWith("W") ? ref : await resolveUserId(token, ref, cookie));
                } catch (e: unknown) {
                  console.error(`  ! could not resolve ${ref}: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
              // conversations.invite returns ok:true but silently no-ops for a
              // single-channel guest (is_ultra_restricted) — they can only ever
              // belong to the one channel they were created in. Warn up front
              // (fail-soft, never blocks) so a no-op invite isn't mistaken for
              // success.
              for (const uid of ids) {
                try {
                  const info = asRecord((await userInfo(token, uid, cookie)) as Json);
                  const u = asRecord(info.user);
                  if (u.is_ultra_restricted === true) {
                    console.error(`⚠ ${uid} is a single-channel guest — Slack restricts them to their one existing channel; this invite will likely report success but not actually add them.`);
                  } else if (u.is_restricted === true) {
                    console.error(`⚠ ${uid} is a multi-channel guest — double-check they were actually added (guest invites can silently no-op depending on workspace restrictions).`);
                  }
                } catch {
                  // best-effort; a lookup failure must not block the invite
                }
              }
              if (ids.length) {
                try {
                  await inviteToChannel(token, created.id, ids, cookie);
                  console.log(`✓ Invited ${ids.length} member${ids.length === 1 ? "" : "s"}`);
                } catch (e: unknown) {
                  console.error(`  ! invite failed: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            }
          },
        )
        .demandCommand(1, "")
        .showHelpOnFail(true),
    )
    .command(
      ["user", "usr"],
      "User commands",
      (y) => y
        .command(
          ["ls", "list"],
          "List workspace members",
          (y2) => y2
            .option("limit", { alias: "n", type: "number", default: 200 })
            .option("filter", { alias: "f", type: "string" })
            .option("format", { type: "string", choices: ["text", "jsonl", "yaml"] as const, default: "text" })
            .option("json", { type: "boolean", default: false, describe: "Alias for --format=jsonl" }),
          async (argv) => {
            const format = argv.json ? "jsonl" : argv.format;
            const resp = (await listUsers(tok(argv as W))) as Record<string, Json>;
            const filter = argv.filter?.toLowerCase();
            const members = asArray(resp.members)
              .map(asRecord)
              .filter((u) => u.deleted !== true && u.is_bot !== true && String(u.id) !== "USLACKBOT")
              .filter((u) => {
                if (!filter) return true;
                const name = String(u.name ?? "").toLowerCase();
                const real = String(asRecord(u.profile).real_name ?? "").toLowerCase();
                const email = String(asRecord(u.profile).email ?? "").toLowerCase();
                return name.includes(filter) || real.includes(filter) || email.includes(filter);
              })
              .slice(0, argv.limit);
            if (format === "jsonl") {
              for (const u of members) console.log(JSON.stringify(u));
              return;
            }
            if (format === "yaml") {
              for (const u of members) {
                console.log("---");
                function yamlVal(v: Json, indent = ""): string {
                  if (v === null) return "null";
                  if (typeof v === "string") return v.includes("\n") ? `|\n  ${v.split("\n").join("\n  ")}` : v;
                  if (typeof v !== "object") return String(v);
                  if (Array.isArray(v)) return v.map((i) => `\n${indent}  - ${yamlVal(i, indent + "  ")}`).join("");
                  return Object.entries(v as Record<string, Json>).map(([k, val]) =>
                    `\n${indent}  ${k}: ${yamlVal(val, indent + "  ")}`).join("");
                }
                for (const [k, v] of Object.entries(u)) console.log(`${k}: ${yamlVal(v)}`);
              }
              return;
            }
            const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            for (const u of members) {
              const profile = asRecord(u.profile);
              const handle = String(u.name ?? u.id);
              const id = String(u.id ?? "");
              const display = String(profile.display_name || "");
              const real = String(profile.real_name || "");
              const email = String(profile.email || "");
              const tz = String(u.tz ?? "");
              const names = [...new Set([display, real].filter((s) => s && s !== handle))];
              const parts = names.join(" / ");
              const tzPart = tz && tz !== localTz ? tz : "";
              const meta = [email, tzPart].filter(Boolean).join("  ");
              console.log(`@${handle}  ${id}  ${parts}${meta ? "  " + meta : ""}`);
            }
          },
        )
        .command(
          "get <user>",
          "Show user details",
          (y2) => y2.positional("user", { type: "string", demandOption: true, describe: "@handle or user ID" }),
          async (argv) => {
            const token = tok(argv as W);
            const ref = argv.user!.startsWith("@") ? argv.user!.slice(1) : argv.user!;
            // If not a Slack user ID (U + alphanumeric), resolve from users list by handle
            let userId = ref;
            if (!/^U[A-Z0-9]+$/.test(ref)) {
              const listResp = (await listUsers(token)) as Record<string, Json>;
              const match = asArray(listResp.members).map(asRecord)
                .find((u) => String(u.name ?? "") === ref);
              if (!match) { console.error(`User not found: @${ref}`); process.exit(1); }
              userId = String(match.id);
            }
            const resp = asRecord((await userInfo(token, userId)) as Json);
            const u = asRecord(resp.user);
            const profile = asRecord(u.profile);
            const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const handle = String(u.name ?? userId);
            const id = String(u.id ?? userId);
            const display = String(profile.display_name || "");
            const real = String(profile.real_name || "");
            const email = String(profile.email || "");
            const tz = String(u.tz ?? "");
            const phone = String(profile.phone || "");
            const title = String(profile.title || "");
            console.log(`@${handle}  ${id}`);
            const names = [...new Set([display, real].filter((s) => s && s !== handle))];
            if (names.length) console.log(`name:  ${names.join(" / ")}`);
            if (email) console.log(`email: ${email}`);
            if (phone) console.log(`phone: ${phone}`);
            if (title) console.log(`title: ${title}`);
            if (tz && tz !== localTz) console.log(`tz:    ${tz}`);
          },
        )
        .demandCommand(1, "")
        .showHelpOnFail(true),
    )
    .command(
      "news",
      "Activity feed (mentions to you)",
      (y) => y.option("limit", { alias: "l", type: "number", default: 20 }),
      async (argv) => {
        await cmdNews(tok(argv as W), argv.limit);
      },
    )
    .command(
      "search <query>",
      "Full-text search",
      (y) => y
        .positional("query", { type: "string", demandOption: true })
        .option("count", { alias: "n", type: "number", default: 100 })
        .option("json", { type: "boolean", default: false, describe: "Output raw JSON" }),
      async (argv) => {
        await cmdSearch(tok(argv as W), argv.query!, argv.count, argv.json, ck(argv as W));
      },
    )
    .command(
      "send <target> <message>",
      "Send a message (confirm-hash safety gate)",
      (y) => y
        .positional("target", { type: "string", demandOption: true, describe: "#chan, @user, #chan:thread_ts, or permalink (a message permalink replies in its thread)" })
        .positional("message", { type: "string", demandOption: true })
        .option("code", { type: "string", describe: "Safety hash to confirm send" })
        .option("channel-id", { type: "string", describe: "Raw channel ID" })
        .option("user-id", { type: "string", describe: "Raw user ID (opens DM)" })
        .option("as-bot", { type: "boolean", default: false, describe: "Send via the bot token (xoxb / SLACK_BOT_TOKEN) so a DM notifies the recipient and can be two-way" })
        .option("broadcast", { type: "boolean", default: false, describe: "Also send to channel: broadcast a threaded reply back to the channel (Slack's \"Also send to #channel\" checkbox). Only effective with a thread target." })
        .option("mentions", { type: "boolean", default: true, describe: "Convert @handle tokens to real <@USERID> mentions (on by default; resolves via users.list, then channel members for Slack Connect guests). Unresolved handles stay as plain text. The confirm preview shows the converted message before sending. Disable with --no-mentions for literal @text." }),
      async (argv) => {
        const args: SendArgs = { target: argv.target!, message: argv.message! };
        if (argv.code) args.code = argv.code;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        if (argv["user-id"]) args.userId = argv["user-id"];
        if (argv.broadcast) args.broadcast = true;
        // Mentions on by default; `--no-mentions` (yargs negation) sets it false.
        // A message with no `@token` short-circuits inside encodeMentions, so the
        // common case pays no extra API call.
        if (argv.mentions !== false) {
          args.mentions = true;
          // Resolve mentions with the user token (has users:read) even when the
          // message itself is sent via the bot token. Pass its cookie too so an
          // xoxc- desktop token can reach users.list (rejected without the cookie).
          args.mentionToken = tok(argv as W);
          const mc = ck(argv as W);
          if (mc) args.mentionCookie = mc;
        }
        let sendToken: string;
        if (argv["as-bot"]) {
          const botToken = resolveBotToken();
          if (!botToken) {
            console.error(
              "Error: --as-bot needs a bot token, but no xoxb- token was found.\n" +
              "  Set SLACK_BOT_TOKEN=xoxb-... in ~/.config/slack-cli/.env (or your shell).",
            );
            process.exit(1);
          }
          // Resolve @user → user_id with the *user* token (has users:read), then
          // let cmdSend open the DM with the bot token (im:write). This avoids
          // requiring users:read on the bot and guarantees the DM is bot↔user
          // (not the user's own self-DM).
          if (!args.channelId && !args.userId && args.target.startsWith("@")) {
            try {
              args.userId = await resolveUserId(tok(argv as W), args.target, ck(argv as W));
            } catch (e: unknown) {
              console.error(
                `Error: could not resolve ${args.target} to a user for the bot DM.\n` +
                `  ${e instanceof Error ? e.message : String(e)}\n` +
                `  Tip: pass --user-id <Uxxxx> to skip the lookup.`,
              );
              process.exit(1);
            }
          }
          sendToken = botToken;
          args.asBot = true;
        } else {
          sendToken = tok(argv as W);
          // Session cookie for `sendToken` itself — needed for an xoxc- desktop
          // token to be accepted by the public API at all. Not applicable to the
          // bot token above (bot tokens need no cookie).
          const sc = ck(argv as W);
          if (sc) args.cookie = sc;
        }
        // Print a clean error instead of yargs' usage dump when a send fails at
        // runtime (e.g. missing scope, channel not found). The confirm gate
        // exits via process.exit, so it is unaffected.
        try {
          await cmdSend(sendToken, args);
        } catch (e: unknown) {
          console.error(friendlySlackError(e));
          process.exit(1);
        }
      },
    )
    .command(
      "doctor",
      "Check the bot token (xoxb) can carry a two-way DM (scopes + Messages Tab)",
      (y) => y,
      async () => {
        const botToken = resolveBotToken();
        if (!botToken) {
          console.error(
            "Error: slack doctor checks the bot token, but no xoxb- token was found.\n" +
            "  Set SLACK_BOT_TOKEN=xoxb-... in ~/.config/slack-cli/.env (or your shell).",
          );
          process.exit(1);
        }
        await cmdDoctor(botToken);
      },
    )
    .command(
      "schedule",
      "Manage scheduled messages",
      (y) => y
        .command(
          "send <target> <message>",
          "Schedule a message for later delivery",
          (y2) => y2
            .positional("target", { type: "string", demandOption: true, describe: "#chan, @user, #chan:thread_ts, or permalink (a message permalink replies in its thread)" })
            .positional("message", { type: "string", demandOption: true })
            .option("at", { type: "string", demandOption: true, describe: "Delivery time (ISO datetime or Unix ts)" })
            .option("code", { type: "string", describe: "Safety hash to confirm" })
            .option("channel-id", { type: "string", describe: "Raw channel ID" })
            .option("user-id", { type: "string", describe: "Raw user ID (opens DM)" }),
          async (argv) => {
            const args: ScheduleSendArgs = { target: argv.target!, message: argv.message!, at: argv.at! };
            if (argv.code) args.code = argv.code;
            if (argv["channel-id"]) args.channelId = argv["channel-id"];
            if (argv["user-id"]) args.userId = argv["user-id"];
            const cookie = ck(argv as W);
            if (cookie) args.cookie = cookie;
            await cmdScheduleSend(tok(argv as W), args);
          },
        )
        .command(
          ["ls", "list"],
          "List pending scheduled messages",
          (y2) => y2
            .positional("target", { type: "string", describe: "#channel to filter by" })
            .option("channel-id", { type: "string", describe: "Raw channel ID" }),
          async (argv) => {
            await cmdScheduleList(tok(argv as W), argv.target as string | undefined, argv["channel-id"], ck(argv as W));
          },
        )
        .command(
          "rm <target> <id>",
          "Delete a scheduled message",
          (y2) => y2
            .positional("target", { type: "string", demandOption: true, describe: "#channel or @user" })
            .positional("id", { type: "string", demandOption: true, describe: "Scheduled message ID" })
            .option("code", { type: "string", describe: "Safety hash to confirm" })
            .option("channel-id", { type: "string", describe: "Raw channel ID" }),
          async (argv) => {
            const args: ScheduleRmArgs = { target: argv.target!, id: argv.id! };
            if (argv.code) args.code = argv.code;
            const cookie = ck(argv as W);
            if (cookie) args.cookie = cookie;
            if (argv["channel-id"]) args.channelId = argv["channel-id"];
            await cmdScheduleRm(tok(argv as W), args);
          },
        )
        .demandCommand(1, "")
        .showHelpOnFail(true),
      () => {},
    )
    .command(
      "edit <target> <newText>",
      "Edit a sent message",
      (y) => y
        .positional("target", { type: "string", demandOption: true, describe: "#chan:ts, @user:ts, or permalink" })
        .positional("newText", { type: "string", demandOption: true })
        .option("code", { type: "string", describe: "Safety hash to confirm edit" })
        .option("channel-id", { type: "string", describe: "Raw channel ID" })
        .option("mentions", { type: "boolean", default: true, describe: "Convert @handle tokens in the new text to real <@USERID> mentions (on by default). Unresolved handles stay as plain text. Disable with --no-mentions for literal @text." }),
      async (argv) => {
        const args: EditArgs = { target: argv.target!, newText: argv.newText! };
        if (argv.code) args.code = argv.code;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        if (argv.mentions !== false) args.mentions = true;
        const cookie = ck(argv as W);
        if (cookie) args.cookie = cookie;
        await cmdEdit(tok(argv as W), args);
      },
    )
    .command(
      "delete <target>",
      "Delete a sent message (confirm-hash safety gate)",
      (y) => y
        .positional("target", { type: "string", demandOption: true, describe: "#chan:ts, @user:ts, or permalink" })
        .option("code", { type: "string", describe: "Safety hash to confirm delete" })
        .option("channel-id", { type: "string", describe: "Raw channel ID" }),
      async (argv) => {
        const args: DeleteArgs = { target: argv.target! };
        if (argv.code) args.code = argv.code;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        const cookie = ck(argv as W);
        if (cookie) args.cookie = cookie;
        await cmdDelete(tok(argv as W), args);
      },
    )
    .command(
      "react <target> <emoji>",
      "Add (or --remove) an emoji reaction — a lightweight ack that doesn't grow the thread",
      (y) => y
        .positional("target", { type: "string", demandOption: true, describe: "#chan:ts, @user:ts, or permalink" })
        .positional("emoji", { type: "string", demandOption: true, describe: "Emoji shortcode without colons (e.g. eyes, white_check_mark, hourglass)" })
        .option("remove", { type: "boolean", default: false, describe: "Remove the reaction instead of adding it" })
        .option("channel-id", { type: "string", describe: "Raw channel ID" }),
      async (argv) => {
        const args: ReactArgs = { target: argv.target!, emoji: argv.emoji! };
        if (argv.remove) args.remove = true;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        const cookie = ck(argv as W);
        if (cookie) args.cookie = cookie;
        // Print a clean one-line error instead of yargs' usage dump + stack when
        // the reaction fails at runtime (missing_scope, invalid_name, etc.).
        try {
          await cmdReact(tok(argv as W), args);
        } catch (e: unknown) {
          console.error(friendlySlackError(e));
          process.exit(1);
        }
      },
    )
    .command(
      "upload <target> <file..>",
      "Upload one or more files to a channel or DM",
      (y) => y
        .positional("target", { type: "string", demandOption: true, describe: "#chan, @user, #chan:thread_ts, or permalink (a message permalink replies in its thread)" })
        .positional("file", { type: "string", array: true, demandOption: true, describe: "Path(s) to file(s)" })
        .option("title", { type: "string", describe: "Title (single file only)" })
        .option("comment", { type: "string", describe: "Initial comment (first file)" })
        .option("code", { type: "string", describe: "4-hex safety code to confirm upload" })
        .option("channel-id", { type: "string" })
        .option("user-id", { type: "string" }),
      async (argv) => {
        const args: UploadArgs = { target: argv.target!, filePaths: argv.file as string[] };
        if (argv.title) args.title = argv.title;
        if (argv.comment) args.comment = argv.comment;
        if (argv.code) args.code = argv.code;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        if (argv["user-id"]) args.userId = argv["user-id"];
        const cookie = ck(argv as W);
        if (cookie) args.cookie = cookie;
        await cmdUpload(tok(argv as W), args);
      },
    )
    .command(
      "files",
      "File commands",
      (y) => y
        .command(
          ["ls", "list"],
          "List files visible to you (files.list)",
          (y2) => y2
            .option("limit", { alias: "l", type: "number", default: 100, describe: "Max files to list" })
            .option("type", { alias: "t", type: "string", describe: "Slack type filter: images, pdfs, gdocs, snippets, zips, spaces, all" })
            .option("channel", { alias: "c", type: "string", describe: "Only files in this channel (#name, @user, ID, or permalink)" })
            .option("user", { alias: "u", type: "string", describe: "Only files from this raw user ID" })
            .option("format", { type: "string", choices: ["text", "jsonl"], default: "text" })
            .option("json", { type: "boolean", default: false, describe: "Alias for --format=jsonl" }),
          async (argv) => {
            const o: { limit: number; types?: string; channel?: string; user?: string; format: string } = {
              limit: argv.limit as number,
              format: argv.json ? "jsonl" : (argv.format as string),
            };
            if (argv.type) o.types = argv.type as string;
            if (argv.channel) o.channel = argv.channel as string;
            if (argv.user) o.user = argv.user as string;
            await cmdFilesList(tok(argv as W), ck(argv as W), o);
          },
        )
        .demandCommand(1, "")
        .showHelpOnFail(true),
      () => {},
    )
    .command(
      "download <ref> [dest]",
      "Download a file attachment (by file ID or file permalink) to disk",
      (y) => y
        .positional("ref", { type: "string", demandOption: true, describe: "File ID (F…) or Slack file permalink" })
        .positional("dest", { type: "string", describe: "Output path or directory (default: ./<filename>)" }),
      async (argv) => {
        await cmdDownload(tok(argv as W), ck(argv as W), argv.ref!, argv.dest);
      },
    )
    .command(
      "dump",
      "Bulk export channel history as markdown",
      (y) => y
        .option("days", { alias: "d", type: "number", default: 7, describe: "Days of history" })
        .option("limit", { alias: "l", type: "number", default: 200 })
        .option("filter", { alias: "f", type: "string", describe: "Filter channel names" }),
      async (argv) => {
        await cmdDump(tok(argv as W), argv.days, argv.limit, argv.filter);
      },
    )
    .command(
      "drafts",
      "Manage message drafts (requires xoxc desktop token)",
      (y) => y
        .command(
          ["$0", "ls", "list"],
          "List pending drafts",
          (y2) => y2.option("all", { alias: "a", type: "boolean", default: false, describe: "Include sent drafts" }),
          async (argv) => {
            await cmdDrafts(tok(argv as W), ck(argv as W), argv.all);
          },
        )
        .command(
          ["new <channel> [text..]", "save <channel> [text..]"],
          "Create a draft",
          (y2) => y2
            .positional("channel", { type: "string", demandOption: true })
            .positional("text", { type: "string", array: true, default: [] }),
          async (argv) => {
            const token = tok(argv as W); const cookie = ck(argv as W);
            const text = (argv.text as string[]).join(" ");
            if (!text) { console.error("Usage: slack drafts new <#channel|@user> <text>"); process.exit(2); }
            const channelId = await resolveChannel(token, argv.channel!, cookie);
            const resp = (await createDraft(token, channelId, text, cookie)) as Record<string, Json>;
            console.log(`✓ Draft created (id: ${asRecord(resp.draft).id ?? "?"})`);
          },
        )
        .command(
          "get <id>",
          "Show a draft",
          (y2) => y2.positional("id", { type: "string", demandOption: true }),
          async (argv) => {
            await cmdDraftGet(tok(argv as W), ck(argv as W), argv.id!);
          },
        )
        .command(
          ["edit <id> [text..]", "update <id> [text..]"],
          "Edit a draft",
          (y2) => y2
            .positional("id", { type: "string", demandOption: true })
            .positional("text", { type: "string", array: true, default: [] })
            .option("code", { type: "string" }),
          async (argv) => {
            const token = tok(argv as W); const cookie = ck(argv as W);
            const text = (argv.text as string[]).join(" ");
            if (!text) { console.error("Usage: slack drafts edit <id> <new-text>"); process.exit(2); }
            const listResp = (await listDrafts(token, cookie)) as Record<string, Json>;
            const d = asArray(listResp.drafts).map(asRecord).find((x) => String(x.id) === argv.id);
            if (!d) { console.error(`Draft not found: ${argv.id}`); process.exit(1); }
            const prevText = draftText(d);
            const code = safetyCode(prevText, text);
            if (argv.code !== code) requireCode(argv.code, code, [
              `--- Current draft ----------------------------`,
              ...prevText.split("\n").map((l) => `  ${l}`),
              `--- Replacing with ---------------------------`,
              ...text.split("\n").map((l) => `  ${l}`),
              `--------------------------------────────────`,
            ]);
            const resp = (await updateDraft(token, argv.id!, draftChannelId(d), text, cookie)) as Record<string, Json>;
            console.log(`✓ Draft updated (id: ${asRecord(resp.draft).id ?? "?"})`);
          },
        )
        .command(
          ["delete <id>", "rm <id>"],
          "Delete a draft",
          (y2) => y2
            .positional("id", { type: "string", demandOption: true })
            .option("code", { type: "string" }),
          async (argv) => {
            const token = tok(argv as W); const cookie = ck(argv as W);
            const listResp = (await listDrafts(token, cookie)) as Record<string, Json>;
            const d = asArray(listResp.drafts).map(asRecord).find((x) => String(x.id) === argv.id);
            if (!d) { console.error(`Draft not found: ${argv.id}`); process.exit(1); }
            const prevText = draftText(d);
            const code = safetyCode(argv.id!, prevText);
            if (argv.code !== code) requireCode(argv.code, code, [
              `─-- Deleting draft ───────────────────────────`,
              `  id: ${argv.id}`,
              ...prevText.split("\n").map((l) => `  ${l}`),
              `--------------------------------────────────`,
            ]);
            await deleteDraft(token, argv.id!, cookie);
            console.log(`✓ Draft deleted (id: ${argv.id})`);
          },
        ),
    )
    .command(
      "auth",
      "Authentication and workspace management",
      (y) => y
        .command(
          "token",
          "Add a workspace — paste an existing xoxp-/xoxb- token",
          (y2) => y2
            .option("token", { type: "string", describe: "Token to save directly (non-interactive)" })
            .option("name", { type: "string", describe: "Workspace name (used with --token)" }),
          async (argv) => {
            await cmdAuthToken({
              ...(argv.token !== undefined ? { token: argv.token } : {}),
              ...(argv.name !== undefined ? { name: argv.name } : {}),
            });
          },
        )
        .command(
          "app",
          "Create a new Slack app and obtain a token (guided wizard)",
          (y2) => y2.option("bot", { type: "boolean", describe: "Create a bot token (xoxb-) instead of user (xoxp-)" }),
          async (argv) => {
            await cmdAuthApp({ ...(argv.bot !== undefined ? { bot: argv.bot } : {}) });
          },
        )
        .command(
          "login",
          "Interactive auth wizard (all auth methods: desktop app, token, new app)",
          (y2) => y2
            .option("token", { type: "string", describe: "Token to save directly (non-interactive)" })
            .option("name", { type: "string", describe: "Workspace name (used with --token)" }),
          async (argv) => {
            await cmdAuthLogin({
              ...(argv.token !== undefined ? { token: argv.token } : {}),
              ...(argv.name !== undefined ? { name: argv.name } : {}),
            });
          },
        )
        .command(["ls", "status"], "Show auth status", () => {}, () => {
          const profiles = listProfiles();
          if (profiles.length === 0) { console.log("No workspaces configured. Run: slack auth login"); return; }
          for (const { name, profile, current } of profiles)
            console.log(`${current ? "* " : "  "}${name}  ${profile.team}  (${profile.user})  ${profile.url ?? ""}`);
        })
        .command(
          "use <name>",
          "Switch active workspace",
          (y2) => y2
            .positional("name", { type: "string", demandOption: true })
            .option("g", { type: "boolean", default: false, describe: "Write global lockfile (~/.slack-cli/workspace)" }),
          (argv) => {
            if (!argv.g) ensureSlackCliDir(join(process.cwd(), ".slack-cli"));
            useProfile(argv.name!, argv.g);
            console.log(`Switched to workspace "${argv.name}" ${argv.g ? "globally" : "locally"}`);
          },
        )
        .command(
          ["logout <name>", "rm <name>", "remove <name>"],
          "Remove a workspace",
          (y2) => y2.positional("name", { type: "string", demandOption: true }),
          (argv) => {
            removeProfile(argv.name!);
            console.log(`Removed workspace "${argv.name}"`);
          },
        )
        .command(
          ["chrome", "cookie"],
          "Attach Chrome browser xoxd cookie to a workspace (macOS, interactive)",
          (y2) => y2
            .option("workspace", { type: "string", alias: "w", describe: "Workspace name to update (default: active)" }),
          async (argv) => {
            await cmdAuthChrome({ ...(argv.workspace !== undefined ? { workspace: argv.workspace } : {}) });
          },
        )
        .command(
          "firefox",
          "Attach Firefox browser xoxd cookie to a workspace (all platforms)",
          (y2) => y2
            .option("workspace", { type: "string", alias: "w", describe: "Workspace name to update (default: active)" }),
          async (argv) => {
            await cmdAuthFirefox({ ...(argv.workspace !== undefined ? { workspace: argv.workspace } : {}) });
          },
        )
        .command("$0", false as unknown as string, () => {}, () => { y.showHelp(); process.exit(0); }),
    )
    .command(
      "tail [target]",
      "Stream new messages in real time (like tail -f)",
      (y) => y
        .positional("target", { type: "string", describe: "#channel or @user to follow" })
        .option("since", { type: "string", describe: "Backfill from N ago (e.g. 10m, 2h, 1d)" })
        .option("thread", { type: "string", describe: "Follow a single thread by timestamp" })
        .option("watch-thread", { type: "string", describe: "Watch the channel's top-level timeline AND one thread's replies together (ts or permalink)" })
        .option("me", { type: "boolean", default: false, describe: "Filter to messages that mention you" })
        .option("interval", { type: "number", default: 60000, describe: "Poll interval in ms (default 60s; use --interval=3000 for near-real-time)" })
        .option("timeout", { type: "string", describe: "Auto-stop after this long (e.g. 30m, 2h). Exit code 0 even if nothing arrived." })
        .option("exit-on-message", { type: "boolean", default: false, describe: "Stop as soon as the first new message from someone else arrives (wait-for-reply)" })
        .option("rtm", { type: "boolean", default: true, describe: "Use RTM WebSocket when available (xoxc + cookie); pass --no-rtm to force polling" }),
      async (argv) => {
        const token = tok(argv as W);
        const cookie = ck(argv as W);
        const signal = new AbortController();
        process.on("SIGINT", () => { signal.abort(); process.exit(0); });
        await cmdTail(token, argv.target, {
          ...(argv.since !== undefined ? { since: argv.since } : {}),
          ...(argv.thread !== undefined ? { thread: argv.thread } : {}),
          ...(argv["watch-thread"] !== undefined ? { watchThread: argv["watch-thread"] as string } : {}),
          me: argv.me,
          interval: argv.interval,
          ...(argv.timeout !== undefined ? { timeout: argv.timeout } : {}),
          ...(argv["exit-on-message"] === true ? { exitOnMessage: true } : {}),
          ...(cookie !== undefined ? { cookie } : {}),
          ...(argv.rtm === false ? { noRtm: true } : {}),
        }, signal.signal);
      },
    )
    .command("login", false as unknown as string, (y2) => y2
      .option("token", { type: "string" })
      .option("name", { type: "string" }), async (argv) => {
      await cmdAuthLogin({
        ...(argv.token !== undefined ? { token: argv.token } : {}),
        ...(argv.name !== undefined ? { name: argv.name } : {}),
      });
    })
    .demandCommand(1, "Specify a command. Run with --help for usage.")
    .strict()
    .help()
    .alias("help", "h")
    .parseAsync();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
