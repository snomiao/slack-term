#!/usr/bin/env bun
// Slack CLI entry — mirrors the Rust impl in src/main.rs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { listProfiles, removeProfile, resolveCookie, resolveToken, useProfile } from "./profiles.ts";
import { cmdAuthLogin, cmdAuthChrome, cmdAuthFirefox, cmdAuthToken, cmdAuthApp } from "./auth.ts";
import { cmdTail } from "./tail.ts";

import {
  authTestSession,
  conversationInfoSession,
  createDraft,
  deleteDraft,
  updateDraft,
  editMessage,
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
  search,
  searchAll,
  send as slackSend,
  scheduleMessage,
  listScheduledMessages,
  deleteScheduledMessage,
  uploadFile,
  userInfoPair,
  userName,
  getPath,
  type Json,
} from "./slack.ts";
import { dayLabel, formatYmdHm, resolveDateMarkup, resolveMentions } from "./format.ts";

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
  return `${stamp}  ${who}:  ${body}`;
}

// --- msgs <target> — channel/DM history with timestamps ---
async function cmdMsgsTarget(token: string, target: string, limit: number): Promise<void> {
  const parsed = parseSlackPermalink(target);
  const channelId = await resolveChannel(token, target);
  const cache = new Map<string, string>();
  if (parsed?.threadTs) {
    const resp = (await replies(token, channelId, parsed.threadTs, limit)) as Record<string, Json>;
    const msgs = asArray(resp.messages).map(asRecord);
    for (const m of msgs) {
      console.log(await formatMsgLine(token, m, cache));
    }
  } else {
    const hist = (await history(token, channelId, limit)) as Record<string, Json>;
    const msgs = asArray(hist.messages).map(asRecord);
    for (const m of msgs.reverse()) {
      console.log(await formatMsgLine(token, m, cache));
    }
  }
}

// --- thread ---
async function cmdThread(token: string, target: string, ts: string, limit: number): Promise<void> {
  const channelId = await resolveChannel(token, target);
  const resp = (await replies(token, channelId, parseInputTs(ts), limit)) as Record<string, Json>;
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
async function cmdSearch(token: string, query: string, count: number, json: boolean): Promise<void> {
  const resp = await searchAll(token, query, count);
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
 *  Accepts: `#chan:1700000000.000100`, `@user:ts`, `RAWID:ts`, Slack permalink with thread_ts, or plain ref. */
function parseTargetThread(s: string): { ref: string; threadTs?: string } {
  const url = parseSlackPermalink(s);
  if (url) return url.threadTs ? { ref: url.channel, threadTs: url.threadTs } : { ref: url.channel };
  const colon = s.indexOf(":");
  if (colon > 0) {
    const maybeTs = s.slice(colon + 1);
    if (/^\d{10}\.\d{6}$/.test(maybeTs)) return { ref: s.slice(0, colon), threadTs: maybeTs };
    if (/^\d{4}-\d{2}-\d{2}T/.test(maybeTs)) return { ref: s.slice(0, colon), threadTs: isoToSlackTs(maybeTs) };
  }
  return { ref: s };
}

// --- edit ---
interface EditArgs {
  target: string;
  newText: string;
  code?: string;
  channelId?: string;
}
async function cmdEdit(token: string, args: EditArgs): Promise<void> {
  const { ref, ts } = splitRefTs(args.target);
  if (!ts) {
    console.error("Error: target must embed a message ts (e.g. #chan:2026-05-11T06:01:04.000100 or a Slack permalink URL)");
    process.exit(2);
  }

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else channelId = await resolveChannel(token, ref);

  // Fetch the message to display the original text and compute the safety hash.
  const resp = (await replies(token, channelId, ts, 1)) as Record<string, Json>;
  const msgs = asArray(resp.messages).map(asRecord);
  const original = msgs.find((m) => String(m.ts) === ts);
  if (!original) {
    console.error(`Message not found at ts=${ts} in channel ${channelId}`);
    process.exit(1);
  }
  const originalText = typeof original.text === "string" ? original.text : "";

  const code = safetyCode(originalText, args.newText);
  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Original message -------------------------`,
      ...originalText.split("\n").map((l) => `  ${l}`),
      `--- Replacing with ---------------------------`,
      ...args.newText.split("\n").map((l) => `  ${l}`),
      `--------------------------------────────────`,
    ]);
  }

  const newTs = await editMessage(token, channelId, ts, args.newText);
  console.log(`✓ Edited (ts: ${newTs})`);
}

// --- send ---
interface SendArgs {
  target: string;
  message: string;
  code?: string;
  channelId?: string;
  userId?: string;
}
async function cmdSend(token: string, args: SendArgs): Promise<void> {
  const { ref, threadTs } = parseTargetThread(args.target);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId);
  else channelId = await resolveChannel(token, ref);

  // Fetch last 1 message for context hash
  const ctx = (await history(token, channelId, 1)) as Record<string, Json>;
  const lastMsg = asArray(ctx.messages).map(asRecord)
    .filter((m) => m.subtype === undefined || m.subtype === null)[0];
  const lastText = typeof lastMsg?.text === "string" ? lastMsg.text : "";
  const lastUser = typeof lastMsg?.user === "string" ? lastMsg.user : "?";

  const code = safetyCode(lastText, args.message);

  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Last message in channel ------------------`,
      `  ${lastUser}: ${lastText.split("\n")[0]?.slice(0, 100) ?? "(empty)"}`,
      `--- Sending ----------------------------------`,
      `  To:      ${ref}${threadTs ? ` (thread ${threadTs})` : ""}`,
      `  Message: ${args.message}`,
      `--------------------------------────────────`,
    ]);
  }
  const ts = await slackSend(token, channelId, args.message, threadTs);
  console.log(`✓ Sent (ts: ${ts})`);
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
}
async function cmdScheduleSend(token: string, args: ScheduleSendArgs): Promise<void> {
  const { ref, threadTs } = parseTargetThread(args.target);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId);
  else channelId = await resolveChannel(token, ref);

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
  const id = await scheduleMessage(token, channelId, args.message, postAt, threadTs);
  console.log(`✓ Scheduled (id: ${id}, at: ${postAtDate})`);
}

async function cmdScheduleList(token: string, target?: string, channelId?: string): Promise<void> {
  let channel: string | undefined;
  if (channelId) {
    channel = channelId;
  } else if (target) {
    channel = await resolveChannel(token, target);
  }
  const resp = (await listScheduledMessages(token, channel)) as {
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
}
async function cmdScheduleRm(token: string, args: ScheduleRmArgs): Promise<void> {
  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else channelId = await resolveChannel(token, args.target);

  const code = safetyCode(channelId, args.id);
  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Deleting scheduled message ---------------`,
      `  Channel: ${args.target}`,
      `  ID:      ${args.id}`,
      `---------------------------------------------`,
    ]);
  }
  await deleteScheduledMessage(token, channelId, args.id);
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
  else if (args.userId) channelId = await openDm(token, args.userId);
  else channelId = await resolveChannel(token, ref);

  function fmtSize(n: number): string {
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  }

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
    const { fileId, permalink } = await uploadFile(token, channelId, f.fp, uploadOpts);
    const prefix = total > 1 ? `[${i + 1}/${total}] ` : "";
    console.log(`${prefix}✓ Uploaded (file_id: ${fileId}${permalink ? `, url: ${permalink}` : ""})`);
  }
}

// --- dispatch ---

async function main(): Promise<void> {
  loadDotenvFiles();

  type W = { workspace?: string };
  const tok = (a: W) => resolveToken(a.workspace);
  const ck = (a: W) => resolveCookie(a.workspace);

  await yargs(hideBin(process.argv))
    .scriptName("slack")
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
        .option("limit", { alias: "n", type: "number", default: 20, describe: "Number of messages" }),
      async (argv) => {
        const token = tok(argv as W);
        if (argv.target) await cmdMsgsTarget(token, argv.target, argv.limit);
        else await cmdMsgs(token);
      },
    )
    .command(
      "thread <target> <ts>",
      "Show thread messages",
      (y) => y
        .positional("target", { type: "string", demandOption: true })
        .positional("ts", { type: "string", demandOption: true })
        .option("limit", { alias: "n", type: "number", default: 100 }),
      async (argv) => {
        await cmdThread(tok(argv as W), argv.target!, argv.ts!, argv.limit);
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
            const ref = argv.channel!;
            const channelRef = ref.startsWith("#") || ref.startsWith("@") || ref.startsWith("C") || ref.startsWith("G") || ref.startsWith("D") ? ref : `#${ref}`;
            const channelId = await resolveChannel(token, channelRef);
            const resp = asRecord((await conversationInfo(token, channelId)) as Json);
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
        await cmdSearch(tok(argv as W), argv.query!, argv.count, argv.json);
      },
    )
    .command(
      "send <target> <message>",
      "Send a message (confirm-hash safety gate)",
      (y) => y
        .positional("target", { type: "string", demandOption: true, describe: "#chan, @user, #chan:thread_ts, or permalink" })
        .positional("message", { type: "string", demandOption: true })
        .option("code", { type: "string", describe: "Safety hash to confirm send" })
        .option("channel-id", { type: "string", describe: "Raw channel ID" })
        .option("user-id", { type: "string", describe: "Raw user ID (opens DM)" }),
      async (argv) => {
        const args: SendArgs = { target: argv.target!, message: argv.message! };
        if (argv.code) args.code = argv.code;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        if (argv["user-id"]) args.userId = argv["user-id"];
        await cmdSend(tok(argv as W), args);
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
            .positional("target", { type: "string", demandOption: true, describe: "#chan, @user, #chan:thread_ts, or permalink" })
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
            await cmdScheduleList(tok(argv as W), argv.target as string | undefined, argv["channel-id"]);
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
        .option("channel-id", { type: "string", describe: "Raw channel ID" }),
      async (argv) => {
        const args: EditArgs = { target: argv.target!, newText: argv.newText! };
        if (argv.code) args.code = argv.code;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        await cmdEdit(tok(argv as W), args);
      },
    )
    .command(
      "upload <target> <file..>",
      "Upload one or more files to a channel or DM",
      (y) => y
        .positional("target", { type: "string", demandOption: true, describe: "#chan, @user, #chan:thread_ts, or permalink" })
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
        await cmdUpload(tok(argv as W), args);
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
        .option("me", { type: "boolean", default: false, describe: "Filter to messages that mention you" })
        .option("interval", { type: "number", default: 60000, describe: "Poll interval in ms (default 60s; use --interval=3000 for near-real-time)" })
        .option("rtm", { type: "boolean", default: true, describe: "Use RTM WebSocket when available (xoxc + cookie); pass --no-rtm to force polling" }),
      async (argv) => {
        const token = tok(argv as W);
        const cookie = ck(argv as W);
        const signal = new AbortController();
        process.on("SIGINT", () => { signal.abort(); process.exit(0); });
        await cmdTail(token, argv.target, {
          ...(argv.since !== undefined ? { since: argv.since } : {}),
          ...(argv.thread !== undefined ? { thread: argv.thread } : {}),
          me: argv.me,
          interval: argv.interval,
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
