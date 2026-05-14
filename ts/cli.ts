#!/usr/bin/env bun
// Slack CLI entry — mirrors the Rust impl in src/main.rs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { listProfiles, removeProfile, resolveCookie, resolveToken, useProfile } from "./profiles.ts";
import { cmdAuthLogin } from "./auth.ts";

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
  openDm,
  parseSlackPermalink,
  replies,
  resolveChannel,
  search,
  searchAll,
  send as slackSend,
  uploadFile,
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
  const matches = asArray(getPath(resp, ["messages", "matches"])).map(asRecord);
  const cache = new Map<string, string>();
  let lastDay = "";
  for (const m of matches.slice(0, limit)) {
    const ts = tsNum(m);
    const label = dayLabel(ts);
    if (label !== lastDay) {
      if (lastDay !== "") console.log("");
      console.log(`  ${label}`);
      console.log("  ----------------------------");
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
 *  Accepts: `#chan:ts`, `@user:ts`, Slack permalink URL, or plain ref. */
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
    }
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
    console.error("Error: target must embed a message ts (e.g. #chan:1700000000.000100 or a Slack permalink URL)");
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
      `--- Last message in channel ------------------`,
      `  ${lastUser}: ${lastText.split("\n")[0]?.slice(0, 100) ?? "(empty)"}`,
      `--- Sending ----------------------------------`,
      `  To:      ${args.target}${args.thread ? ` (thread ${args.thread})` : ""}`,
      `  Message: ${args.message}`,
      `--------------------------------────────────`,
    ]);
  }
  const ts = await slackSend(token, channelId, args.message, args.thread);
  console.log(`✓ Sent (ts: ${ts})`);
}

// --- upload ---
interface UploadArgs {
  target: string;
  filePath: string;
  title?: string;
  thread?: string;
  comment?: string;
  code?: string;
  channelId?: string;
  userId?: string;
}
async function cmdUpload(token: string, args: UploadArgs): Promise<void> {
  const { statSync, existsSync } = await import("node:fs");
  const { basename } = await import("node:path");

  if (!existsSync(args.filePath)) {
    console.error(`Error: file not found: ${args.filePath}`);
    process.exit(1);
  }
  const stat = statSync(args.filePath);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId);
  else if (args.target.startsWith("#") || args.target.startsWith("@")) {
    channelId = await resolveChannel(token, args.target);
  } else {
    console.error(`Error: target must be #channel-name or @username (got: ${args.target})`);
    process.exit(1);
  }

  const filename = basename(args.filePath);
  const title = args.title ?? filename;
  const sizeFmt = stat.size < 1024
    ? `${stat.size} B`
    : stat.size < 1048576
    ? `${(stat.size / 1024).toFixed(1)} KB`
    : `${(stat.size / 1048576).toFixed(1)} MB`;

  const code = safetyCode(channelId, args.filePath, title);
  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Uploading file ---------------------------`,
      `  To:    ${args.target}${args.thread ? ` (thread ${args.thread})` : ""}`,
      `  File:  ${args.filePath}`,
      `  Title: ${title}`,
      `  Size:  ${sizeFmt}`,
      `--------------------------------────────────`,
    ]);
  }

  const uploadOpts: { title?: string; threadTs?: string; initialComment?: string } = { title };
  if (args.thread !== undefined) uploadOpts.threadTs = args.thread;
  if (args.comment !== undefined) uploadOpts.initialComment = args.comment;
  const { fileId, permalink } = await uploadFile(token, channelId, args.filePath, uploadOpts);
  console.log(`✓ Uploaded (file_id: ${fileId}${permalink ? `, url: ${permalink}` : ""})`);
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
            .option("format", { type: "string", choices: ["text", "jsonl"] as const, default: "text" }),
          async (argv) => {
            await cmdChannels(tok(argv as W), argv.limit, argv.filter, argv.all, argv.format);
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
            .option("format", { type: "string", choices: ["text", "jsonl", "yaml"] as const, default: "text" }),
          async (argv) => {
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
            if (argv.format === "jsonl") {
              for (const u of members) console.log(JSON.stringify(u));
              return;
            }
            if (argv.format === "yaml") {
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
            for (const u of members) {
              const profile = asRecord(u.profile);
              const handle = String(u.name ?? u.id);
              const id = String(u.id ?? "");
              const display = String(profile.display_name || "");
              const real = String(profile.real_name || "");
              const email = String(profile.email || "");
              const tz = String(u.tz ?? "");
              const parts = [display, real].filter((s) => s && s !== handle).join(" / ");
              const meta = [email, tz].filter(Boolean).join("  ");
              console.log(`@${handle}  ${id}  ${parts}${meta ? "  " + meta : ""}`);
            }
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
        .option("count", { alias: "n", type: "number", default: 100 }),
      async (argv) => {
        await cmdSearch(tok(argv as W), argv.query!, argv.count);
      },
    )
    .command(
      "send <target> <message>",
      "Send a message (confirm-hash safety gate)",
      (y) => y
        .positional("target", { type: "string", demandOption: true })
        .positional("message", { type: "string", demandOption: true })
        .option("thread", { type: "string", describe: "Thread timestamp" })
        .option("code", { type: "string", describe: "Safety hash to confirm send" })
        .option("channel-id", { type: "string", describe: "Raw channel ID" })
        .option("user-id", { type: "string", describe: "Raw user ID (opens DM)" }),
      async (argv) => {
        const args: SendArgs = { target: argv.target!, message: argv.message! };
        if (argv.thread) args.thread = argv.thread;
        if (argv.code) args.code = argv.code;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        if (argv["user-id"]) args.userId = argv["user-id"];
        await cmdSend(tok(argv as W), args);
      },
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
      "upload <target> <file>",
      "Upload a file to a channel or DM",
      (y) => y
        .positional("target", { type: "string", demandOption: true })
        .positional("file", { type: "string", demandOption: true, describe: "Path to file" })
        .option("title", { type: "string" })
        .option("thread", { type: "string", describe: "Thread timestamp" })
        .option("comment", { type: "string", describe: "Initial comment" })
        .option("code", { type: "string", describe: "Safety hash to confirm upload" })
        .option("channel-id", { type: "string" })
        .option("user-id", { type: "string" }),
      async (argv) => {
        const args: UploadArgs = { target: argv.target!, filePath: argv.file! };
        if (argv.title) args.title = argv.title;
        if (argv.thread) args.thread = argv.thread;
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
        .command(["login", "$0"], "Interactive auth setup", () => {}, async () => {
          await cmdAuthLogin();
        })
        .command("ls", "List configured workspaces", () => {}, () => {
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
          ["rm <name>", "remove <name>"],
          "Remove a workspace",
          (y2) => y2.positional("name", { type: "string", demandOption: true }),
          (argv) => {
            removeProfile(argv.name!);
            console.log(`Removed workspace "${argv.name}"`);
          },
        ),
    )
    .command("login", false as unknown as string, () => {}, async () => {
      await cmdAuthLogin();
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
