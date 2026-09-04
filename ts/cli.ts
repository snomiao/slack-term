#!/usr/bin/env bun
// Slack CLI entry — mirrors the Rust impl in src/main.rs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yargs, { type Options } from "yargs";
import { hideBin } from "yargs/helpers";
import { listProfiles, removeProfile, resolveBotToken, resolveCookie, resolveToken, useProfile, type Profile } from "./profiles.ts";
import { diagnoseBotMessaging, formatDiagnosis } from "./botdoctor.ts";
import { cmdAuthLogin, cmdAuthChrome, cmdAuthFirefox, cmdAuthToken, cmdAuthApp } from "./auth.ts";
import { cmdTail } from "./tail.ts";

import {
  ASK_KEYCAPS,
  ASK_MARKER,
  ASK_RESOLVED_MARKER,
  ASK_MAX_REACTION_CHOICES,
  askBuildText,
  askBuildResolvedText,
  askParseMessage,
  askExplainReject,
  askFlatten,
  askMatchChoice,
  applyInvalidNotice,
  readInvalidNotice,
  type AskFound,
} from "./ask.ts";
import {
  POLL_KEYCAPS,
  POLL_MARKER,
  POLL_CLOSED_MARKER,
  POLL_MAX_CHOICES,
  pollBuildText,
  pollBuildClosedText,
  pollFlatten,
  pollParseMessage,
  pollTally,
} from "./poll.ts";
import { seedReactionsInOrder } from "./reactionSeed.ts";
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
  reactionsGet,
  filesInfo,
  filesList,
  listRecords,
  history,
  listConversations,
  listConversationMembers,
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
import {
  buildTodoQuery,
  loadTodoConfig,
  resolveChannelCached,
  todoDoctor,
  todoFlag,
  userHandleCached,
  userTzCached,
  todoSet,
  withRateLimitRetry,
  DOCTOR_DEFAULT_LIMIT,
  type FlagName,
  type LsQueryOpts,
  type LsState,
  type ProgressState,
} from "./todo.ts";
import { setCacheEnabled } from "./cache.ts";
import { unescapeArg } from "./escapes.ts";
import { dayLabel, encodeMentions, encodeMentionsDetailed, findUntaggedMentions, formatYmdHm, mentionWarnings, resolveDateMarkup, resolveMentions, type MentionEncodeResult } from "./format.ts";
import { quietHoursNotice } from "./quietHours.ts";

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
  // Session cookie (xoxd) for `token` — required for an xoxc- desktop session
  // token; without it users.info 401s and every author renders as a raw ID.
  cookie?: string,
): Promise<string> {
  const rawTs = typeof m.ts === "string" ? m.ts : `${tsNum(m)}.000000`;
  const stamp = slackTsToIso(rawTs);
  let handle = "?";
  if (typeof m.user === "string") {
    const uid = m.user;
    const handleKey = "@" + uid;
    // Two-tier: this call's in-process Map → ~/.config/slack-cli/cache.json
    // (1h TTL, workspace-scoped) → users.info. Handles barely change, and a
    // long listing re-resolves the same few authors on every run.
    if (!cache.has(handleKey)) {
      const h = await userHandleCached(token, uid, async (t, u, c) => (await userInfoPair(t, u, c))[1], cookie);
      cache.set(handleKey, h);
    }
    handle = cache.get(handleKey) ?? uid;
  } else if (typeof m.username === "string") {
    handle = m.username;
  }
  const raw = typeof m.text === "string" ? m.text : "";
  const resolved = resolveDateMarkup(await resolveMentions(token, raw, cache, cookie));
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
  // Thread parents carry reply_count; surface it inline so a reader of
  // top-level history can see there is more to read without opening each ts.
  const replyCount = Number(m.reply_count ?? 0);
  const threadMark = replyCount > 0 ? `  [+${replyCount} ${replyCount === 1 ? "reply" : "replies"}]` : "";
  const tail = (reactions ? `\n   ${reactions}` : "") + attachTail;
  return `${stamp}  ${who}:  ${body}${threadMark}${tail}`;
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
    // Thread stats, present only on thread parents. Without these a caller
    // reading top-level history cannot tell a post with replies from one
    // without, and silently misses everything said inside the thread.
    // Reactions, when the message carries any. `ask` and `poll` record ANSWERS
    // as reactions, so omitting them made `--json` useless as the fallback
    // people reach for when a poller fails — the pressed pills were right there
    // in the API response and the CLI dropped them (reported 2026-08-31).
    ...(Array.isArray(m.reactions) && m.reactions.length
      ? { reactions: asArray(m.reactions).map(asRecord).map((r) => ({
          name: r.name ?? null,
          count: r.count ?? null,
          users: Array.isArray(r.users) ? r.users : [],
        })) }
      : {}),
    ...(m.reply_count !== undefined ? { reply_count: m.reply_count } : {}),
    ...(m.reply_users_count !== undefined ? { reply_users_count: m.reply_users_count } : {}),
    ...(m.latest_reply !== undefined ? { latest_reply: m.latest_reply } : {}),
    // Present only when the message carries attachments, so scripts can reliably
    // detect files without the key adding noise to every plain-text line.
    ...(files.length > 0 ? { files } : {}),
  };
}

// Keep only conversations whose last word is somebody else's — i.e. still
// awaiting our answer. For a thread parent that means the newest reply, which
// costs one conversations.replies call per thread (latest_reply gives the ts but
// not its author, so it cannot answer this on its own).
async function filterUnreplied(
  token: string,
  channelId: string,
  msgs: Record<string, Json>[],
  selfId: string,
  cookie?: string,
): Promise<Record<string, Json>[]> {
  const out: Record<string, Json>[] = [];
  for (const m of msgs) {
    let last = m;
    if (Number(m.reply_count ?? 0) > 0 && typeof m.ts === "string") {
      const resp = (await replies(token, channelId, m.ts, 200, cookie)) as Record<string, Json>;
      const all = asArray(resp.messages).map(asRecord);
      last = all[all.length - 1] ?? m;
    }
    if (last.user !== selfId) out.push(m);
  }
  return out;
}

// --- msgs <target> — channel/DM history with timestamps ---
async function cmdMsgsTarget(token: string, target: string, limit: number, format: "text" | "jsonl" = "text", unreplied = false, cookie?: string): Promise<void> {
  const parsed = parseSlackPermalink(target);
  const channelId = await resolveChannel(token, target, cookie);
  const cache = new Map<string, string>();
  const fetchMsgs = async (): Promise<Record<string, Json>[]> => {
    if (parsed?.threadTs) {
      const resp = (await replies(token, channelId, parsed.threadTs, limit, cookie)) as Record<string, Json>;
      return asArray(resp.messages).map(asRecord);
    }
    const hist = (await history(token, channelId, limit, undefined, undefined, cookie)) as Record<string, Json>;
    return asArray(hist.messages).map(asRecord).reverse();
  };
  let msgs = await fetchMsgs();
  if (unreplied) {
    const { userId } = await authTest(token, cookie);
    msgs = await filterUnreplied(token, channelId, msgs, userId, cookie);
  }
  if (format === "jsonl") {
    for (const m of msgs) console.log(JSON.stringify(slimMsg(m)));
    return;
  }
  for (const m of msgs) {
    console.log(await formatMsgLine(token, m, cache, undefined, cookie));
  }
}

// --- thread ---
async function cmdThread(token: string, target: string, ts: string, limit: number, format: "text" | "jsonl" = "text", cookie?: string): Promise<void> {
  const channelId = await resolveChannel(token, target, cookie);
  const resp = (await replies(token, channelId, parseInputTs(ts), limit, cookie)) as Record<string, Json>;
  const msgs = asArray(resp.messages).map(asRecord);
  if (format === "jsonl") {
    for (const m of msgs) console.log(JSON.stringify(slimMsg(m)));
    return;
  }
  const cache = new Map<string, string>();
  for (const m of msgs) {
    console.log(await formatMsgLine(token, m, cache, undefined, cookie));
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
    // Pass searchCookie: an xoxc- desktop token is rejected by users.info without
    // its session cookie, and both the author handle and every <@UID> mention
    // silently degrade to raw IDs. The DM-label lookup above already forwards it.
    console.log(await formatMsgLine(searchToken, m, cache, chLabel, searchCookie));
  }
}

// --- todo — reaction-backed task tracking (see ts/todo.ts for the state model) ---

/** Resolve a `#chan:<ts>` / permalink target to (channelId, ts) for todo writes. */
async function todoTarget(
  token: string,
  target: string,
  channelIdOpt: string | undefined,
  cookie: string | undefined,
): Promise<{ channelId: string; ts: string }> {
  const { ref, ts } = splitRefTs(target);
  if (!ts) {
    console.error("Error: target must embed a message ts (e.g. #chan:1700000000.000100 or a Slack permalink URL)");
    process.exit(2);
  }
  const channelId = channelIdOpt ?? (await resolveChannelCached(token, ref, resolveChannel, cookie));
  return { channelId, ts };
}

async function cmdTodoLs(
  token: string,
  opts: { state: LsState; in?: string; from?: string; mine: boolean; count: number; json: boolean; cookie?: string },
): Promise<void> {
  const cfg = loadTodoConfig();
  const queryOpts: LsQueryOpts = {};
  // `mine` is the narrow view (`hasmy:` — only reactions this token's user made).
  // Anything else searches anyone's reactions (`has:`).
  if (!opts.mine) queryOpts.shared = true;
  if (opts.in) queryOpts.in = opts.in;
  if (opts.from) queryOpts.from = opts.from;
  const query = buildTodoQuery(opts.state, cfg, queryOpts);
  if (!opts.json) {
    // Name the identity the listing is relative to. `hasmy:` resolves against
    // whoever the token is, so "my tasks" is only meaningful once you know who
    // "my" is — a wrong profile silently lists a different person's tasks.
    // Same From: line the write gates print, for the same reason.
    const self = await selfIdentity(token, opts.cookie);
    const scope = opts.mine ? "your reactions only [hasmy:]" : "anyone's reactions [has:]";
    console.error(`(From: ${senderLabel(self)} · matching ${scope})`);
    console.error(`(query: ${query})`);
  }
  // One search per invocation — search.messages is Tier 2 (~20 req/min), so the
  // priority rule is encoded as negations in the query, not as extra searches.
  await withRateLimitRetry("search.messages", () => cmdSearch(token, query, opts.count, opts.json, opts.cookie));
}

async function cmdTodoSet(
  token: string,
  args: { target: string; state: ProgressState; channelId?: string; cookie?: string },
): Promise<void> {
  const cfg = loadTodoConfig();
  const { channelId, ts } = await todoTarget(token, args.target, args.channelId, args.cookie);
  const res = await todoSet(token, channelId, ts, args.state, cfg, args.cookie);
  if (res.noop) {
    console.log(`= Already ${args.state} (ts: ${ts})`);
    return;
  }
  const removedNote = res.removed.length ? `, removed ${res.removed.map((e) => `:${e}:`).join(" ")}` : "";
  console.log(`✓ ${args.state} :${cfg.progress[args.state]}: (ts: ${ts})${removedNote}`);
  if (res.leftover.length) {
    console.error(
      `⚠ ${res.leftover.map((e) => `:${e}:`).join(" ")} could not be removed — this message now carries more than one ` +
      `progress reaction. Readers collapse by priority so nothing is lost; repair with:  slack todo doctor --in <#chan> --fix`,
    );
  }
}

async function cmdTodoFlag(
  token: string,
  args: { target: string; flag: FlagName; remove?: boolean; channelId?: string; cookie?: string },
): Promise<void> {
  const cfg = loadTodoConfig();
  const { channelId, ts } = await todoTarget(token, args.target, args.channelId, args.cookie);
  const emoji = await todoFlag(token, channelId, ts, args.flag, cfg, args.remove === true, args.cookie);
  console.log(`✓ ${args.remove ? "Cleared" : "Flagged"} ${args.flag} :${emoji}: (ts: ${ts})`);
}

async function cmdTodoDoctor(
  token: string,
  args: { channel: string; fix?: boolean; limit: number; channelId?: string; cookie?: string },
): Promise<void> {
  const cfg = loadTodoConfig();
  const channelId = args.channelId ?? (await resolveChannelCached(token, args.channel, resolveChannel, args.cookie));
  const doctorOpts: { fix?: boolean; limit: number; cookie?: string } = { limit: args.limit };
  if (args.fix) doctorOpts.fix = true;
  if (args.cookie) doctorOpts.cookie = args.cookie;
  const report = await todoDoctor(token, channelId, cfg, doctorOpts);
  if (report.findings.length === 0) {
    console.log(`✓ No multi-state tasks in ${report.scanned} message(s).`);
  } else {
    for (const f of report.findings) {
      const status = f.fixed === true ? "fixed" : f.fixed === false ? `FAILED: ${f.error ?? "?"}` : "needs --fix";
      console.log(
        `${f.ts}  ${f.emoji.map((e) => `:${e}:`).join(" ")} → keep :${f.keep}:  [${status}]  ` +
        `${stripTerminalControls(f.text).slice(0, 60)}`,
      );
    }
    console.log(`${report.findings.length} multi-state task(s) in ${report.scanned} message(s).`);
  }
  if (report.truncated) {
    console.error(
      `⚠ Scan limit reached (${args.limit} messages) — older history was NOT checked. Raise it with --limit N.`,
    );
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
/** The recipient's timezone for the quiet-hours label — DM only.
 *
 *  A channel has many recipients in potentially many zones, and resolving every
 *  member would cost a lookup per person to answer a question that has no single
 *  answer. DMs are also where a 3am notification actually lands on someone's
 *  phone, so this is where the check earns its keep.
 *
 *  Returns null (= "unknown", label says so) for channels, for a self-DM, and
 *  for anyone Slack has no timezone for. */
async function recipientTzFor(token: string, channelId: string, cookie?: string): Promise<string | null> {
  if (!channelId.startsWith("D")) return null;
  try {
    const other = await imCounterpart(token, channelId, cookie);
    if (!other) return null;
    return await userTzCached(token, other, userInfo, cookie);
  } catch {
    return null;
  }
}

/** `when` is the moment the message will ACTUALLY reach the person — which is
 *  now for a send, and `post_at` for a schedule. Judging a scheduled message by
 *  the clock at schedule time answers a question nobody asked: `schedule send`
 *  is the one command where the delivery time is stated outright, and reading
 *  it off `Date.now()` warned about a message set for December because it was
 *  scheduled after 23:00. A warning that is false on the command where the
 *  answer is written in the arguments teaches people to ignore the warning. */
function requireCode(
  provided: string | undefined,
  expected: string,
  contextLines: string[],
  recipientTz?: string | null,
  when: Date = new Date(),
): void {
  // The clock goes to stdout with the rest of the preview, not to stderr with
  // the code. The preview is what you are asked to LOOK at before committing,
  // and "what time is it where they are" is part of that picture — a caller
  // doing `send ... 2>/dev/null` to read the preview would otherwise drop the
  // one line added to stop a 01:00 send.
  for (const line of contextLines) console.log(line);
  const clock = quietHoursNotice(when, recipientTz);
  if (clock) console.log(clock);
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
/** Split a target into "where" and "which thread".
 *
 *  `permalinkThreads` is what separates `send` from `ask`/`poll`. For `send`,
 *  pasting a permalink means "reply to THAT message" — the message you pasted is
 *  the subject. For `ask`/`poll` it does not: the permalink is how you name a DM
 *  or channel you have no handle for, and a question is a new thing being
 *  raised, not a comment on the message that happened to be at hand. Inheriting
 *  the thread there buries a question in an unrelated conversation, where the
 *  people it is addressed to will not see it.
 *
 *  Threading `ask`/`poll` deliberately is still possible — with the explicit
 *  `#chan:<ts>` form, which says so rather than depending on the shape of what
 *  you pasted. */
function parseTargetThread(s: string, permalinkThreads = true): { ref: string; threadTs?: string } {
  const url = parseSlackPermalink(s);
  if (url) {
    if (!permalinkThreads) return { ref: url.channel };
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

/** Human-readable destination label for confirm gates, e.g. "#general (C0123456789)".
 *  When ref is already a #channel/@user label, keep it; otherwise resolve the channel
 *  name via conversations.info (fail-soft: a raw ID is still unambiguous). */
async function destLabel(token: string, channelId: string, ref: string, cookie?: string): Promise<string> {
  let name = ref;
  // `#C0123…` is an ID wearing a `#`, not a channel name — resolveChannel
  // accepts it, so the gate has to look it up like any other ID. Trusting the
  // `#` here would print "#D00000001" for a DM, which tells the reader
  // nothing about who is on the other end.
  const refIsId = /^#?[CDG][A-Z0-9]{8,}$/.test(ref);
  if (refIsId || (!ref.startsWith("#") && !ref.startsWith("@"))) {
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

/** Identity behind the token a write command will act with. */
type Self = { userId: string; user: string; botId: string; team: string };

/** `auth.test` for the token that will perform a write. Every confirm gate names
 *  the acting identity and binds it into the safety hash. Resolves to null
 *  (never throws) when the lookup fails, so a gate still renders and the write
 *  still goes through. */
async function selfIdentity(token: string, cookie?: string): Promise<Self | null> {
  try {
    return await authScopes(token, cookie);
  } catch {
    return null;
  }
}

/** Memoized `selfIdentity`, for commands that consult it more than once (`send`
 *  needs it for the unreplied guard as well as the gate) — a command must never
 *  pay for more than one lookup. */
function selfLookup(token: string, cookie?: string): () => Promise<Self | null> {
  let cache: Self | null | undefined;
  return async () => {
    if (cache === undefined) cache = await selfIdentity(token, cookie);
    return cache;
  };
}

/** Name the identity a write will be performed AS, for confirm gates:
 *  "@snomiao (U0123ABC) — Acme". Slack shows only the author on the resulting
 *  message, so a wrong profile / stale SLACK_TOKEN / unintended --as-bot is
 *  otherwise invisible until after it lands — handle, user id and workspace pin
 *  all three down. `self` is null when the auth.test lookup failed (fail-soft:
 *  the gate still renders, it just can't name the actor). */
function senderLabel(self: Self | null, asBot?: boolean): string {
  const suffix = asBot ? " [as bot]" : "";
  if (!self) return `(unknown — auth.test failed)${suffix}`;
  // Display text is workspace-controlled; strip control chars like the other gates.
  const name = stripTerminalControls(self.user || self.userId || "?");
  const id = self.userId ? ` (${self.userId})` : "";
  const team = self.team ? ` — ${stripTerminalControls(self.team)}` : "";
  return `@${name}${id}${team}${suffix}`;
}

/** The `From:` line every write gate opens its action block with. `pad` is the
 *  label field width, for gates whose other labels sit on a wider column
 *  (`To:`/`At:`/`Message:` on schedule, `Title:`/`Size:` on upload). */
function fromLine(self: Self | null, opts: { asBot?: boolean | undefined; pad?: number } = {}): string {
  return `  ${"From:".padEnd(opts.pad ?? 6)}${senderLabel(self, opts.asBot)}`;
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
  const getSelf = selfLookup(token, args.cookie);
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

  // Identity is part of the hash for the same reason it is on `send`: a code
  // minted while previewing as one identity must not confirm the write as
  // another (Slack only lets you edit your own messages, so a silent profile
  // switch between preview and confirm otherwise turns into a bare API error).
  const self = await getSelf();
  const code = safetyCode(originalText, newText, self?.userId ?? "");
  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Editing as -------------------------------`,
      fromLine(self),
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
  const getSelf = selfLookup(token, args.cookie);
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

  // Identity in the hash: same rule as send/edit — a code minted as one
  // identity can't confirm the delete as another.
  const self = await getSelf();
  const code = safetyCode(channelId, ts, originalText, self?.userId ?? "");
  if (args.code !== code) {
    const dest = await destLabel(token, channelId, ref, args.cookie);
    requireCode(args.code, code, [
      `--- Deleting message -------------------------`,
      fromLine(self),
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
/** Is `channelId` the token owner's DM with themselves?
 *
 *  Decided on the RESOLVED channel rather than the target string. Matching the
 *  target text only catches the spellings someone thought of (`@me`, the exact
 *  handle) and misses every other way the same conversation gets addressed — a
 *  display name, `--user-id`, `--channel-id`, a permalink. Slack's self-DM is an
 *  IM whose counterparty is you, which is true regardless of how it was named.
 *
 *  Fail-soft: an unreadable channel returns false, so the send is never blocked
 *  by a lookup failure. Only asked for `D…` ids, so channel sends pay nothing. */
async function isSelfDmChannel(
  token: string,
  channelId: string,
  selfUserId: string | undefined,
  cookie?: string,
): Promise<boolean> {
  if (!selfUserId || !channelId.startsWith("D")) return false;
  try {
    const info = asRecord((await conversationInfo(token, channelId, cookie)) as Json);
    const ch = asRecord(info.channel);
    return ch.is_im === true && ch.user === selfUserId;
  } catch {
    return false;
  }
}

async function cmdSend(token: string, args: SendArgs): Promise<void> {
  const { ref, threadTs } = parseTargetThread(args.target);
  const cookie = args.cookie;

  // Identity of the token that will actually post — the bot token under
  // --as-bot, the user token otherwise.
  const getSelf = selfLookup(token, cookie);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId, cookie);
  else channelId = await resolveChannel(token, ref, cookie);

  // Self-DM footgun: Slack never notifies you about a message you sent, so a DM
  // to yourself is delivered and then silently never surfaces — the worst shape
  // for an escalation ("I told you" / nobody saw it). Checked after resolution
  // so it fires however the DM was addressed: @me, a handle, a display name,
  // --user-id, --channel-id, or a permalink. --as-bot is exempt: that posts as
  // the app, a different identity, which does notify you.
  if (!args.asBot && await isSelfDmChannel(token, channelId, (await getSelf())?.userId, cookie)) {
    console.error(
      `Warning: "${args.target}" is a DM to yourself — Slack will NOT notify you of your own message.\n` +
      `  To reach yourself with a notification, send as the bot:  slack send '${args.target}' '...' --as-bot`,
    );
  }

  // Convert @handle / @名前 tokens to <@USERID> before hashing/sending so the
  // safety gate covers exactly what will be posted. Unresolved tokens stay as
  // text. The detailed report drives the confirm-gate mention preview below.
  // Escapes first, before mentions and before the safety hash: the hash has to
  // cover the text that will actually be POSTED, and the gate preview has to
  // show the real line breaks so "how many lines is this?" is answered by
  // looking rather than by guessing.
  const rawMessage = unescapeArg(args.message);
  let message = rawMessage;
  let mentionReport: MentionEncodeResult | null = null;
  if (args.mentions) {
    mentionReport = await encodeMentionsDetailed(args.mentionToken ?? token, rawMessage, channelId, args.mentionCookie);
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
      const self = await getSelf();
      // `self` is null when the identity lookup failed — can't tell whose
      // message it is, so stay quiet rather than guess.
      const isSelfAuthor = !!self && (
        (!!lastMsgUserId && !!self.userId && self.userId === lastMsgUserId) ||
        (!!lastMsgBotId && !!self.botId && self.botId === lastMsgBotId));
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

  // Hash covers the destination and the sending identity too — a code minted
  // for one channel/thread cannot confirm a send to another, and one minted
  // while previewing as identity A cannot confirm a send as identity B (a
  // profile / SLACK_TOKEN / --as-bot switch between preview and confirm
  // re-previews instead). Empty on lookup failure, same fail-soft as lastText.
  const self = await getSelf();
  // Resolved before the gate so the clock can name the recipient's zone. DM
  // only; null means "unknown" and the label says so rather than guessing.
  const recipientTz = await recipientTzFor(token, channelId, cookie);
  const code = safetyCode(channelId, threadTs ?? "", lastText, message, self?.userId ?? "");

  if (args.code !== code) {
    const dest = await destLabel(token, channelId, ref, cookie);
    const from = fromLine(self, { asBot: args.asBot });
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
        from,
        `  → ${dest} thread of ${parentLine} — THREAD REPLY`,
        `  Message: ${message}`,
        `--------------------------------────────────`,
      ], recipientTz);
    } else {
      requireCode(args.code, code, [
        `--- Last message in channel ------------------`,
        `  ${lastUser}: ${lastText.split("\n")[0]?.slice(0, 100) ?? "(empty)"}`,
        ...mentionLines,
        `--- Sending ----------------------------------`,
        from,
        `  → ${dest} — NEW top-level message`,
        `  Message: ${message}`,
        `--------------------------------────────────`,
      ], recipientTz);
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

// --- ask ---
//
// Post a question with its choices PRE-SEEDED as 1️⃣..🔟 reactions, so answering
// costs one tap on an existing pill instead of a trip through the emoji picker.
//
// Reactions, not Block Kit buttons: `block_actions` are delivered only to a
// Request URL or a Socket Mode socket, neither of which a short-lived CLI can
// own without losing clicks. A reaction is durable state — any number of
// concurrent waiters can read it back from `conversations.history`, repeatedly,
// long after it was pressed.
//
// Exit codes are the contract for `--wait`, and a non-zero one must never be
// mistakable for "an answer arrived":
//   0  answered   (the answer text is on stdout, and nothing else is)
//   2  timed out   (nobody replied)
//   3  transport/config failure
//   4  replied, but chose none of the offered choices — stdout stays EMPTY
// Everything human-facing goes to stderr, so `ANS=$(slack ask ... --wait)` is safe.

const ASK_EXIT_TIMEOUT = 2;
const ASK_EXIT_ERROR = 3;
/** Somebody replied, and what they wrote picks none of the offered choices.
 *  A THIRD state, distinct from both 0 and 2 on purpose: exit 0 would have an
 *  automated caller act on a decision nobody took, and exit 2 ("nobody
 *  answered") would hide that a human is standing there waiting for something. */
const ASK_EXIT_UNCHOSEN = 4;

const ASK_PHI = 1.618033988749895;
const ASK_POLL_MIN_MS = 1000;
const ASK_POLL_MAX_MS = 5000;
const ASK_MAX_CONSECUTIVE_ERRORS = 8;


interface AskArgs {
  target: string;
  question: string;
  choices: string[];
  body?: string;
  code?: string;
  channelId?: string;
  userId?: string;
  asBot?: boolean;
  wait?: boolean;
  timeout?: number;
  cookie?: string;
  // Token used to resolve the @tags that decide who may answer (needs
  // users:read). Defaults to the ask token; set to the user token under
  // --as-bot so the bot token need not carry users:read. There is no
  // --no-mentions here: the tags ARE the authorization, so leaving them as
  // plain text would leave the question addressed to nobody.
  mentionToken?: string;
  mentionCookie?: string;
}


const askSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A thread reply sent with "also send to channel" ticked arrives as a normal
// message carrying this subtype. Dropping every subtype would discard those —
// and where thread replies are the only text path, that means discarding real
// answers.
const ASK_ANSWERABLE_SUBTYPES = new Set(["thread_broadcast"]);

// `@here` / `@channel` / `@everyone` — Slack's channel-wide tags. Same lookbehind
// guard as the user-mention regex (skips emails, `<!here>` already encoded, `@@`),
// and a lookahead rather than `\b` so a CJK character right after the tag still
// ends it (`\b` is unreliable outside ASCII).
const ASK_BROADCAST_RE = /(?<![A-Za-z0-9._@<-])@(here|channel|everyone)(?![A-Za-z0-9._-])/giu;

/** Rewrite `@here`/`@channel`/`@everyone` to the `<!here>` form Slack actually
 *  broadcasts on, and report which were used. Run BEFORE user-mention encoding
 *  so those tokens are never offered to the directory as if they were handles. */
function askEncodeBroadcasts(s: string): { text: string; kinds: Set<string> } {
  const kinds = new Set<string>();
  const text = s.replace(ASK_BROADCAST_RE, (_m, k: string) => {
    const kind = k.toLowerCase();
    kinds.add(kind);
    return `<!${kind}>`;
  });
  return { text, kinds };
}

/** The other party in a 1:1 DM, or undefined for anything else (including a
 *  failed lookup). Fail-soft on purpose, but note the caller treats "unknown"
 *  as "no implicit audience" — fail-closed on WHO MAY ANSWER, which is the
 *  direction that cannot silently hand a decision to the wrong person. */
async function imCounterpart(token: string, channelId: string, cookie?: string): Promise<string | undefined> {
  if (!channelId.startsWith("D")) return undefined;
  try {
    const info = asRecord((await conversationInfo(token, channelId, cookie)) as Json);
    const ch = asRecord(info.channel);
    return ch.is_im === true && typeof ch.user === "string" ? ch.user : undefined;
  } catch {
    return undefined;
  }
}

/** Everything the answer poller needs. `--wait` fills it in from what it just
 *  posted; `--waitFor` recovers the same fields from the message itself. */
interface AskWaitCtx {
  channelId: string;
  ts: string;
  /** Set only when the question is itself a thread reply. Such a message never
   *  appears in `conversations.history`, so the whole poll has to run through
   *  `conversations.replies` instead. */
  threadParentTs?: string;
  question: string;
  reactable: string[];
  /** Choices past the tenth. They carry NO reaction — text is the only way to
   *  answer them — so they must be in the candidate list the reply is matched
   *  against, or every legitimate answer to a long question reads as "chose
   *  nothing". */
  overflow: string[];
  threadOnly: boolean;
  /** Who may answer. Empty + broadcast=false would accept nobody, which is why
   *  posting an unaddressed question is refused up front. */
  audience: Set<string>;
  broadcast: boolean;
  /** The asker as the POSTED MESSAGE shows them — not the current token. On
   *  resume the two can differ, and taking the current identity would count the
   *  original asker's seeds as answers. */
  askerUserId: string;
  askerBotId: string;
  timeout: number;
  cookie?: string;
  shown: string;
  /** Only so the resume hint printed on timeout names the right identity — the
   *  ✅ rewrite can be done by the original poster alone. */
  asBot: boolean;
}

/** Poll until answered. Never returns: exits 0 with the answer on stdout, or 2
 *  on timeout. A timeout of 0 means "look exactly once", so a caller can poll
 *  cheaply on its own schedule instead of parking a process on `--wait`. */
async function askWaitForAnswer(token: string, ctx: AskWaitCtx): Promise<never> {
  const { channelId, ts, question, reactable, threadOnly, audience, broadcast, cookie, timeout, shown } = ctx;
  const askerUserId = ctx.askerUserId;
  const askerBotId = ctx.askerBotId;

  // Only the people the question actually addresses. Excluding the asker is what
  // stops a seed being counted as an answer; restricting to `audience` is what
  // stops a bystander in a busy channel from deciding it. `@here`/`@channel`
  // deliberately opens it to everyone — that is what the asker asked for.
  const isAnswerer = (user: unknown): user is string =>
    typeof user === "string" && !!user && user !== askerUserId && (broadcast || audience.has(user));

  /** The earliest reply from an answerer that picked none of the choices. Kept
   *  across polls so the timeout can report it, and so the operator is told once
   *  rather than on every tick. */
  let unchosen: { text: string; who: string; ts: string; ambiguous: boolean } | undefined;
  let unchosenReported = "";

  /** Every seed an answerer is on — not just the first. Changing your mind
   *  leaves BOTH reactions in place (Slack only drops one when you actively
   *  un-react), so taking the lowest index would answer with the abandoned
   *  choice. Array order cannot break the tie either: it is add-order, and we
   *  added every seed before anyone touched it. */
  function humanChoices(msg: Record<string, Json>): { index: number; users: string[] }[] {
    const reactions = asArray(msg.reactions).map(asRecord);
    const out: { index: number; users: string[] }[] = [];
    for (let i = 0; i < reactable.length; i++) {
      const r = reactions.find((x) => x.name === ASK_KEYCAPS[i]!.name);
      const users = r ? asArray(r.users).filter(isAnswerer) : [];
      if (users.length) out.push({ index: i, users });
    }
    return out;
  }

  // Two reactions means two answers, and this command exists for decisions that
  // are expensive to get wrong — so an ambiguous state is never resolved by
  // guessing. Say so IN THE QUESTION and keep waiting; removing one reaction (or
  // replying with text) settles it on the next poll.

  /** Bring the question's invalid-ballot line in line with `offenders`. Skips
   *  the API call when nothing changed, which is what makes this safe to run on
   *  every poll tick rather than once per process. */
  async function noteInvalid(msg: Record<string, Json>, offenders: string[]): Promise<void> {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text) return;
    const next = applyInvalidNotice(text, offenders);
    if (next === text) return;
    try {
      await editMessage(token, channelId, ts, next, cookie, true);
    } catch (e: unknown) {
      // Cosmetic: the poller still refuses to guess, and stderr already said so.
      console.error(`  (質問文に注意書きを入れられませんでした: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  async function answerFromReactions(msg: Record<string, Json>): Promise<AskFound | null> {
    const picks = humanChoices(msg);
    // Nothing ambiguous any more — take the notice back down if one is up.
    if (picks.length <= 1 && readInvalidNotice(typeof msg.text === "string" ? msg.text : "").length) {
      await noteInvalid(msg, []);
    }
    if (!picks.length) return null;
    if (picks.length === 1) {
      const { index, users } = picks[0]!;
      return { answer: reactable[index]!, how: `リアクション ${ASK_KEYCAPS[index]!.glyph}`, who: users[0]! };
    }
    const glyphs = picks.map((p) => ASK_KEYCAPS[p.index]!.glyph).join(" / ");
    console.error(`  (${glyphs} が同時に選ばれています。1 つに絞ってもらうまで待ちます)`);
    // Whoever is on more than one pill. Named in the question itself so the
    // person who has to fix it is the person who sees it — and rewritten from
    // the current state each pass, so reruns cannot stack up notices and the
    // line clears itself once a reaction is taken back.
    const offenders = [...new Set(picks.flatMap((p) => p.users))].sort();
    await noteInvalid(msg, offenders);
    return null;
  }

  /** The full candidate list — reactable pills AND the text-only overflow —
   *  empty when the question was asked free-text. */
  const candidates = [...reactable, ...ctx.overflow];

  function answerFromMessages(messages: Record<string, Json>[], before = Infinity): AskFound | null {
    // Oldest first: if someone wrote twice, the first reply is the answer.
    const ordered = [...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const m of ordered) {
      // Strictly after the question. A question posted INTO an existing thread
      // sits among replies that predate it, and those answered something else.
      if (!(Number(m.ts) > Number(ts))) continue;
      if (!isAnswerer(m.user)) continue;
      if (typeof m.subtype === "string" && !ASK_ANSWERABLE_SUBTYPES.has(m.subtype)) continue;
      if (Number(m.ts) >= before) break;
      const t = typeof m.text === "string" ? m.text.trim() : "";
      if (!t) continue;
      // A question asked WITHOUT choices is answered by whatever comes back —
      // there is nothing to match against, and every reply is the answer.
      if (!candidates.length) return { answer: t, how: "返信", who: m.user };
      const match = askMatchChoice(t, candidates);
      if (match.kind === "chosen") {
        // Answer with the CHOICE, not with the reply that selected it: "2" and
        // "2. 中止" have to reach the caller as the same decision a pill would
        // have produced, or the same answer arrives in three spellings.
        return { answer: candidates[match.index - 1]!, how: `返信 (${match.index})`, who: m.user };
      }
      // Replied, but picked nothing. Recorded rather than returned: a later
      // reply may still choose, and the first one is what the operator needs to
      // see — it is usually a question back.
      if (!unchosen || Number(m.ts) < Number(unchosen.ts)) {
        unchosen = { text: t, who: typeof m.user === "string" ? m.user : "", ts: String(m.ts), ambiguous: match.kind === "ambiguous" };
      }
    }
    return null;
  }

  async function poll(): Promise<AskFound | null> {
    // Recomputed every pass rather than accumulated. A reply that has since been
    // DELETED must stop counting: carrying it forward would let the timeout
    // report "somebody replied and chose nothing" about a message that is no
    // longer there, and exit 4 where exit 2 is the truth. `unchosenReported`
    // persists on purpose — it is what keeps the operator from being told the
    // same thing on every tick.
    unchosen = undefined;
    // A question that is itself a thread reply is invisible to
    // `conversations.history`, so the entire poll — reactions included — has to
    // come from the thread.
    if (ctx.threadParentTs) {
      const rep = asRecord((await replies(token, channelId, ctx.threadParentTs, 100, cookie)) as Json);
      const messages = asArray(rep.messages).map(asRecord);
      const own = messages.find((m) => m.ts === ts);
      if (own) {
        const byReaction = await answerFromReactions(own);
        if (byReaction) return byReaction;
      }
      return answerFromMessages(messages);
    }

    // inclusive: `oldest` excludes the message at that exact ts, and that
    // message IS the question — without this the reactions and reply_count we
    // are polling for never come back at all.
    const hist = asRecord((await history(token, channelId, 30, ts, undefined, cookie, true)) as Json);
    const messages = asArray(hist.messages).map(asRecord);
    const own = messages.find((m) => m.ts === ts);

    // A reaction is the intended path, so it wins when both are present.
    if (own) {
      const byReaction = await answerFromReactions(own);
      if (byReaction) return byReaction;
    }

    if (!threadOnly) {
      // A plain DM reply is ambiguous only while several questions are open at
      // once: it belongs to whichever was newest when it was written. Bound the
      // search by the ts of our NEXT question in this conversation, so an older
      // waiter falls back to reactions/thread replies and never steals the
      // newer one's answer.
      const nextQuestionTs = messages
        .filter((m) => Number(m.ts) > Number(ts) && (
          (askerBotId && m.bot_id === askerBotId) || (askerUserId && m.user === askerUserId)))
        .reduce((min, m) => Math.min(min, Number(m.ts)), Infinity);
      const byMessage = answerFromMessages(messages, nextQuestionTs);
      if (byMessage) return byMessage;
    }

    // Thread replies never appear in history; only pay for the extra call once
    // the parent says there is something to fetch.
    if (own && Number(own.reply_count) > 0) {
      const rep = asRecord((await replies(token, channelId, ts, 30, cookie)) as Json);
      const byThread = answerFromMessages(asArray(rep.messages).map(asRecord));
      if (byThread) return byThread;
    }
    return null;
  }

  /** Stamp the question resolved. Removing our seeds clears the pills that still
   *  invite an answer; the answerer's own reaction cannot be removed by us and
   *  stays put — which is exactly what leaves the chosen number visible. */
  async function markResolved(found: AskFound): Promise<void> {
    for (let i = 0; i < reactable.length; i++) {
      try {
        await reactionRemove(token, channelId, ts, ASK_KEYCAPS[i]!.name, cookie);
      } catch {
        // Already removed, or someone else's reaction — neither is fatal.
      }
    }
    let who = "";
    if (found.who) {
      try {
        who = await userName(token, found.who, cookie);
      } catch {
        who = found.who;
      }
    }
    // Who answered never reaches stdout — callers do ANS=$(slack ask --wait ...)
    // and must keep getting the answer body alone.
    if (who) console.error(`  回答者: ${stripTerminalControls(who)}`);
    try {
      await editMessage(token, channelId, ts, askBuildResolvedText(question, found, who), cookie, true);
      // Swap the marker for the resolved one so search reflects reality:
      // `has::question:` should list what still needs answering, not everything
      // ever asked. Removal last — a crash between the two leaves the question
      // findable under BOTH, which is recoverable; the reverse loses it.
      try {
        await reactionAdd(token, channelId, ts, ASK_RESOLVED_MARKER, cookie);
        await reactionRemove(token, channelId, ts, ASK_MARKER, cookie);
      } catch {
        // Cosmetic: the ✅ in the body is what actually marks it resolved.
      }
    } catch (e: unknown) {
      // The edit is bookkeeping, not the answer. It fails whenever the resuming
      // token is not the one that posted (Slack lets only the author update), and
      // that must not cost the caller an answer it already has.
      console.error(`  (元メッセージの更新に失敗: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  const deadline = Date.now() + timeout * 1000;
  let errors = 0;
  let delay = ASK_POLL_MIN_MS;
  for (;;) {
    let found: AskFound | null = null;
    try {
      found = await poll();
      errors = 0;
    } catch (e: unknown) {
      // A dropped poll is expected occasionally; only give up if it keeps failing.
      errors++;
      if (errors >= ASK_MAX_CONSECUTIVE_ERRORS) {
        console.error(`Error: Slack への問い合わせに ${errors} 回連続で失敗しました: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(ASK_EXIT_ERROR);
      }
      console.error(`  (Slack エラー ${errors}/${ASK_MAX_CONSECUTIVE_ERRORS}, 再試行します: ${e instanceof Error ? e.message : String(e)})`);
    }
    if (found) {
      await markResolved(found);
      // stdout gets the answer and nothing else.
      console.log(found.answer);
      process.exit(0);
    }
    // Said as soon as it is seen, not only at the timeout: the reply is usually
    // a question BACK, and the person who can unblock it is the one watching
    // this command. Once per reply — a poller that repeated itself every tick
    // would be noise nobody reads.
    if (unchosen && unchosen.ts !== unchosenReported) {
      unchosenReported = unchosen.ts;
      let who = unchosen.who;
      try {
        if (who) who = await userName(token, who, cookie);
      } catch {
        // the id is still a usable answer to "who"
      }
      console.error(
        unchosen.ambiguous
          ? `  (${stripTerminalControls(who)} の返信は複数の選択肢に一致します。1 つに絞ってもらうまで待ちます)`
          : `  (${stripTerminalControls(who)} が返信しましたが、選択肢のどれでもありません。待機を続けます)`,
      );
      console.error(`    「${stripTerminalControls(unchosen.text)}」`);
    }
    // Checked after the first poll, never before it: `--timeout 0` means one
    // look, and one look must still be a real look.
    if (Date.now() >= deadline) break;
    await askSleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * ASK_PHI, ASK_POLL_MAX_MS);
  }

  // A timeout is the moment the caller most needs the collect command: the
  // question is still standing, and they have just decided not to block on it.
  // Printing only the permalink here leaves them where `ask` used to: holding a
  // link with nothing that reads a pressed pill back.
  // Three states, not two. "Nobody replied" and "somebody replied and chose
  // nothing" need different reactions from whoever reads this — the first waits,
  // the second answers a person — and collapsing them into exit 2 hides a human
  // standing there. stdout stays empty in both: the caller must not be handed
  // something to act on.
  if (unchosen) {
    console.error(
      unchosen.ambiguous
        ? `Error: 返信はありましたが、複数の選択肢に一致するため確定できません (メッセージはそのまま残っています)`
        : `Error: 返信はありましたが、選択肢のどれも選ばれていません (メッセージはそのまま残っています)`,
    );
    console.error(`  返信: 「${stripTerminalControls(unchosen.text)}」`);
    console.error(`  選択肢: ${candidates.map((c, i) => `${i + 1}. ${stripTerminalControls(askFlatten(c))}`).join("  ")}`);
    console.error(`  ${shown}`);
    console.error(`  返答してから回収する:  ${askResumeCommand(shown, ctx.asBot)}`);
    process.exit(ASK_EXIT_UNCHOSEN);
  }
  if (timeout === 0) {
    console.error(`まだ回答がありません: ${shown}`);
  } else {
    console.error(`Error: ${timeout}s 以内に回答がありませんでした (メッセージはそのまま残っています)`);
    console.error(`  ${shown}`);
    console.error(`  あとで回収する:  ${askResumeCommand(shown, ctx.asBot)}`);
  }
  process.exit(ASK_EXIT_TIMEOUT);
}

/** The `slack ask --waitFor=…` line handed to a caller that did not block.
 *  Printed as a runnable command rather than a bare permalink: the collect step
 *  is the half everyone forgets, and a link does not tell you how to collect. */
function askResumeCommand(shown: string, asBot: boolean): string {
  return `slack ask --waitFor='${shown}'${asBot ? " --as-bot" : ""}`;
}

async function cmdAsk(token: string, args: AskArgs): Promise<void> {
  const { ref, threadTs } = parseTargetThread(args.target, false);
  const cookie = args.cookie;
  const getSelf = selfLookup(token, cookie);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId, cookie);
  else channelId = await resolveChannel(token, ref, cookie);

  const selfId = (await getSelf())?.userId ?? "";
  const counterpart = await imCounterpart(token, channelId, cookie);

  // Same silent-delivery footgun as `send`: Slack never notifies you about your
  // own message, so a question asked in your own DM is delivered and then never
  // seen — and `--wait` would sit there until it timed out.
  if (!args.asBot && !!selfId && counterpart === selfId) {
    console.error(
      `Warning: "${args.target}" is a DM to yourself — Slack will NOT notify you of your own message.\n` +
      `  To reach yourself with a notification, ask as the bot:  slack ask '${args.target}' '...' --as-bot`,
    );
  }

  // --- who may answer -------------------------------------------------------
  //
  // A question with no addressee is the actual failure mode this guards: post it
  // into a busy channel and the first person to react has decided something that
  // was never theirs to decide. So the audience is taken from the @tags in the
  // text — the same names the reader sees — and an untargeted ask is refused
  // outright rather than defaulted to "whoever gets there first".
  // Unescaped BEFORE broadcast/mention encoding and before the body is built,
  // which is what makes it work for choices too: `askBuildText` flattens a
  // choice's newlines to spaces (a newline there would split the pill into a
  // line the parser cannot read back), so unescaping afterwards would be a
  // no-op that silently did nothing.
  const qEnc = askEncodeBroadcasts(unescapeArg(args.question));
  const bEnc = askEncodeBroadcasts(unescapeArg(args.body ?? ""));
  const broadcastKinds = new Set([...qEnc.kinds, ...bEnc.kinds]);
  const mentionToken = args.mentionToken ?? token;
  const qRep = await encodeMentionsDetailed(mentionToken, qEnc.text, channelId, args.mentionCookie);
  const bRep = bEnc.text
    ? await encodeMentionsDetailed(mentionToken, bEnc.text, channelId, args.mentionCookie)
    : { text: "", resolved: [], unresolved: [] } as MentionEncodeResult;
  const question = qRep.text;
  const body = bRep.text;
  const resolved = [...qRep.resolved, ...bRep.resolved];
  const unresolved = [...qRep.unresolved, ...bRep.unresolved];
  // An unresolved tag is not just cosmetic here: it names nobody, so it grants
  // nobody the right to answer. Say so before the rejection below.
  for (const line of mentionWarnings(unresolved)) console.error(`⚠ ${stripTerminalControls(line)}`);

  const broadcast = broadcastKinds.size > 0;
  // Tagging yourself grants nothing — your own reactions are the seeds.
  const audience = new Set(resolved.map((r) => r.userId).filter((id) => id !== selfId));
  const audienceNames = new Map(resolved.map((r) => [r.userId, r.display]));
  let audienceLabel: string;
  if (broadcast) {
    audienceLabel = `anyone in ${ref} (${[...broadcastKinds].map((k) => `@${k}`).join(", ")})`;
  } else {
    // 1:1 DM: the other party IS the audience — there is no one else it could
    // be, so requiring a redundant @tag would buy no clarity. Only here; a group
    // DM or channel still has to name someone.
    if (!audience.size && counterpart && counterpart !== selfId) {
      audience.add(counterpart);
      audienceNames.set(counterpart, await userName(token, counterpart, cookie));
    }
    if (!audience.size) {
      console.error(
        `Error: \`ask\` will not post a question nobody is addressed to — no one is tagged.\n` +
        (unresolved.length
          ? `  (${unresolved.map((u) => stripTerminalControls(u.surface)).join(", ")} matched no one, so it names nobody.)\n`
          : "") +
        `  Tag the person who should answer:  slack ask '${args.target}' '@alice ${args.question}' ...\n` +
        `  Or open it to the whole channel:   slack ask '${args.target}' '@here ${args.question}' ...\n` +
        `  (In a 1:1 DM the other person counts automatically.)`,
      );
      process.exit(ASK_EXIT_ERROR);
    }
    audienceLabel = [...audience]
      .map((id) => `@${stripTerminalControls(audienceNames.get(id) ?? id)} (${id})`)
      .join(", ");
  }

  // Choices too: a `\n` a caller put in a pill label is far more likely to be a
  // typo than intent (the label is flattened to one line either way), but
  // leaving it as the two characters `\` `n` in a button someone has to read is
  // worse than turning it into the space it becomes.
  const escChoices = args.choices.map(unescapeArg);
  const reactable = escChoices.slice(0, ASK_MAX_REACTION_CHOICES);
  const overflow = escChoices.slice(ASK_MAX_REACTION_CHOICES);

  // Where free-text answers may come from. A 1:1 DM carries no unrelated
  // traffic, so a plain reply there is an answer. A channel does, so only
  // reactions and thread replies count — both name the message they belong to,
  // which makes channel mode unambiguous by construction. A question posted
  // INTO a thread is thread-scoped for the same reason.
  const threadOnly = !channelId.startsWith("D") || !!threadTs;
  const message = askBuildText(question, body, reactable, overflow, threadOnly);

  // Preview the destination's last message, exactly as `send` does — the gate's
  // job is to make you look at where this is going before it goes. Fail-soft:
  // a token without history scope can still ask; only the preview degrades.
  let lastText = "";
  let lastUser = "?";
  try {
    const ctx = (await history(token, channelId, 1, undefined, undefined, cookie)) as Record<string, Json>;
    const lastMsg = asArray(ctx.messages).map(asRecord).filter((m) => m.subtype === undefined || m.subtype === null)[0];
    lastText = typeof lastMsg?.text === "string" ? lastMsg.text : "";
    lastUser = typeof lastMsg?.user === "string"
      ? await userName(token, lastMsg.user, cookie)
      : typeof lastMsg?.username === "string" ? lastMsg.username : "?";
  } catch {
    // best-effort preview only
  }

  // Same gate as `send`, deliberately: 追記 4 settled that the two-step code is
  // not "a human in the loop" but "look again before committing", which a script
  // satisfies by calling twice. The hash binds destination, thread, the exact
  // posted body (question AND choices) and the asking identity.
  const self = await getSelf();
  // Resolved before the gate so the clock can name the recipient's zone. DM
  // only; null means "unknown" and the label says so rather than guessing.
  const recipientTz = await recipientTzFor(token, channelId, cookie);
  const code = safetyCode(channelId, threadTs ?? "", lastText, message, self?.userId ?? "");
  if (args.code !== code) {
    const dest = await destLabel(token, channelId, ref, cookie);
    const choiceLines = reactable.length
      ? [`--- Choices (seeded as reactions) ------------`,
         // Flattened here for the same reason the body is: the pill WILL be one
         // line, so a preview showing two would be previewing something that
         // never gets posted.
         ...reactable.map((s, i) => `  ${ASK_KEYCAPS[i]!.glyph} ${askFlatten(s)}`),
         ...overflow.map((s, i) => `  (${i + 11}) ${askFlatten(s)} — text answer only`)]
      : [`--- Choices ----------------------------------`, `  (none — free-text reply)`];
    requireCode(args.code, code, [
      `--- Last message in channel ------------------`,
      `  ${lastUser}: ${lastText.split("\n")[0]?.slice(0, 100) ?? "(empty)"}`,
      ...choiceLines,
      `--- Asking -----------------------------------`,
      fromLine(self, { asBot: args.asBot }),
      `  → ${dest}${threadTs ? " — THREAD REPLY" : " — NEW top-level message"}`,
      `  Question: ${question}`,
      // The audience is the part that decides whose answer is binding, so it is
      // shown as its own line rather than left to be inferred from the body.
      `  Answerable by: ${audienceLabel}`,
      `  Via:      ${threadOnly ? "reactions or thread replies" : "reactions or replies in this DM"}`,
      `--------------------------------────────────`,
    ], recipientTz);
  }

  // `plain`: with blocks attached Slack rewrites the stored text (newlines to
  // spaces, emoji to `:one:`) and `--waitFor` can no longer read the question
  // back out of it — which is the entire recovery path.
  const ts = await slackSend(token, channelId, message, threadTs, false, cookie, true);

  // The marker goes on FIRST so it sits left of the pills, and as a reaction so
  // `has::question:` lists every question the way `has::pushpin:` lists every
  // todo. Body text cannot do that job: Slack's index splits on punctuation, so
  // a `:question:` written in the text is indexed as the word "question" and
  // matches unrelated messages (measured). Only a real reaction is searchable.
  //
  // NOTE the colons: the modifier's argument is itself colon-wrapped, and the
  // bare `has:question` form does NOT error — it silently degrades to a
  // full-text search and returns plausible-looking counts. See ts/todo.ts.
  // Marker first, then 1,2,3 — and spaced out. Sequential awaits alone are NOT
  // enough: measured on two real questions from the same build, one came back
  // `two|one|question|three`. See ts/reactionSeed.ts for the evidence and for
  // SLACK_REACTION_SEED_GAP_MS.
  await seedReactionsInOrder(
    [ASK_MARKER, ...reactable.map((_, i) => ASK_KEYCAPS[i]!.name)],
    (name) => reactionAdd(token, channelId, ts, name, cookie),
    (name, e) => {
      const why = e instanceof Error ? e.message : String(e);
      // The marker is cosmetic + searchability; a keycap only costs the
      // answerer a trip to the emoji picker. Neither abandons a posted question.
      if (name === ASK_MARKER) console.error(`  (marker ${name} を付けられませんでした: ${why})`);
      else console.error(`  (リアクション ${name} を付けられませんでした: ${why})`);
    },
  );

  let permalink = "";
  try {
    permalink = await getPermalink(token, channelId, ts, cookie);
  } catch {
    // fail-soft, same as send: a permalink lookup failure must not mask success
  }
  const shown = permalink || `${channelId}:${ts}`;
  console.error(`✓ Asked: ${shown}`);

  if (!args.wait) {
    // Not waiting. stdout is the RESUME COMMAND, not just a link: nothing else
    // reads a pressed pill back — `tail` only sees `type: "message"` events and
    // drops `message_changed`, so both the reaction and the ✅ rewrite are
    // invisible to it. A question posted with no way to collect it is how an
    // answer gets pressed and nobody ever hears about it.
    console.log(askResumeCommand(shown, !!args.asBot));
    return;
  }

  const timeout = args.timeout ?? 3600;
  console.error(`  回答を待っています (最大 ${timeout}s)… Ctrl-C で中断`);

  const ctx: AskWaitCtx = {
    channelId,
    ts,
    question,
    reactable,
    overflow,
    threadOnly,
    audience,
    broadcast,
    askerUserId: self?.userId ?? "",
    askerBotId: self?.botId ?? "",
    timeout,
    shown,
    asBot: !!args.asBot,
  };
  if (threadTs) ctx.threadParentTs = threadTs;
  if (cookie) ctx.cookie = cookie;
  await askWaitForAnswer(token, ctx);
}



/** `slack ask --waitFor <permalink>` — collect the answer to a question that was
 *  posted without blocking.
 *
 *  Nothing about the question is stored locally, so everything the poller needs
 *  is read back out of the message itself. That is a deliberate trade: no state
 *  file to go stale, lose, or disagree with Slack, and any machine holding the
 *  permalink can collect — at the cost of the body being a parseable format
 *  (`askBuildText` ⇄ `askParseMessage`). */
async function cmdAskWaitFor(token: string, args: { link: string; timeout: number; asBot: boolean; cookie?: string }): Promise<void> {
  const url = parseSlackPermalink(args.link);
  let channelId: string;
  let ts: string;
  let threadTs: string | undefined;
  if (url?.ts) {
    channelId = url.channel;
    ts = url.ts;
    threadTs = url.threadTs && url.threadTs !== url.ts ? url.threadTs : undefined;
  } else {
    // `C…:1700000000.000100` — the fallback `ask` prints when the permalink
    // lookup itself failed, so it has to be collectable too.
    const m = args.link.match(/^([A-Za-z0-9]+):(\d{10}\.\d{6})$/);
    if (!m) {
      console.error(
        `Error: --waitFor needs the permalink of a question (or 'C…:1700000000.000100').\n` +
        `  Got: ${stripTerminalControls(args.link)}`,
      );
      process.exit(ASK_EXIT_ERROR);
    }
    channelId = m[1]!;
    ts = m[2]!;
  }

  // Fetch the one message. A question posted into a thread is not in history at
  // all, so where the permalink says it is a reply, read it from the thread.
  let msg: Record<string, Json> | undefined;
  if (threadTs) {
    const rep = asRecord((await replies(token, channelId, threadTs, 100, args.cookie)) as Json);
    msg = asArray(rep.messages).map(asRecord).find((m) => m.ts === ts);
  } else {
    const hist = asRecord((await history(token, channelId, 1, ts, undefined, args.cookie, true)) as Json);
    msg = asArray(hist.messages).map(asRecord).find((m) => m.ts === ts);
  }
  if (!msg) {
    console.error(`Error: そのメッセージが見つかりません: ${stripTerminalControls(args.link)}`);
    process.exit(ASK_EXIT_ERROR);
  }

  const text = typeof msg.text === "string" ? msg.text : "";
  const parsed = askParseMessage(text);
  if (parsed.kind === "other") {
    console.error(
      `Error: これは \`slack ask\` の質問として読み取れません。\n` +
      `  理由: ${askExplainReject(text)}\n` +
      `  ${stripTerminalControls(args.link)}\n` +
      // The pills are still readable by hand, so a failure here is not a dead
      // end — say so, because the reported cost was not knowing that.
      `  (押されたリアクションは残っています: slack read '${stripTerminalControls(args.link)}' で確認できます)`,
    );
    process.exit(ASK_EXIT_ERROR);
  }
  if (parsed.kind === "resolved") {
    // Answered while nobody was watching — the case that makes fire-and-forget
    // safe. Report it exactly as `--wait` would have.
    console.error(`✓ 回答済み: ${stripTerminalControls(parsed.question)}`);
    console.log(parsed.answer);
    return;
  }

  // Who may answer, recovered from the tags the readers can see. They are
  // already `<@U…>`-encoded in the stored text, so no directory lookup is
  // needed — and the asker is excluded here for the same reason as when
  // posting: their tag of themselves grants nothing, and their reactions are
  // the seeds.
  const askerUserId = typeof msg.user === "string" ? msg.user : "";
  const askerBotId = typeof msg.bot_id === "string" ? msg.bot_id : "";
  const broadcast = /<!(here|channel|everyone)(\^[^>]*)?(\|[^>]*)?>/.test(text);
  const audience = new Set<string>();
  for (const m of text.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
    if (m[1] !== askerUserId) audience.add(m[1]!);
  }
  if (!audience.size && !broadcast) {
    // A 1:1 DM needs no tag — the other party is the only person it could be.
    const counterpart = await imCounterpart(token, channelId, args.cookie);
    if (counterpart && counterpart !== askerUserId) audience.add(counterpart);
  }
  if (!audience.size && !broadcast) {
    console.error(`Error: この質問は誰にも宛てられていないため、有効な回答者を判定できません: ${stripTerminalControls(args.link)}`);
    process.exit(ASK_EXIT_ERROR);
  }

  if (args.timeout > 0) {
    console.error(`  回答を待っています (最大 ${args.timeout}s)… Ctrl-C で中断`);
  }
  const ctx: AskWaitCtx = {
    channelId,
    ts,
    question: parsed.question,
    reactable: parsed.reactable,
    overflow: parsed.overflow,
    threadOnly: parsed.threadOnly,
    audience,
    broadcast,
    askerUserId,
    askerBotId,
    timeout: args.timeout,
    shown: args.link,
    asBot: args.asBot,
  };
  if (threadTs) ctx.threadParentTs = threadTs;
  if (args.cookie) ctx.cookie = args.cookie;
  await askWaitForAnswer(token, ctx);
}

// --- poll ---
//
// `ask` decides something: the FIRST answer wins and settles the question.
// `poll` measures something: every pill is counted and nobody's press is
// binding. That difference in termination is why this is its own command and
// not a flag on `ask` — the two cannot share a "when is this done?".
//
// Same seeded-pill trick, for the same reason: answering costs one tap on a
// reaction that is already there, not a trip through the emoji picker.
//
// THE POSTER IS NEVER COUNTED. Their reaction sits on every choice because they
// seeded it, so it cannot be told apart from a vote — there is no flag to opt
// back in, because there is nothing coherent to opt into. Someone who wants
// their own preference on the record posts `--as-bot` and votes as themselves,
// or just says it in the thread.
//
// Exit codes: 0 ok, 3 transport/config failure (no timeout path — `poll` never
// blocks; `--results` is a single read).

const POLL_EXIT_ERROR = 3;

interface PollArgs {
  target: string;
  question: string;
  choices: string[];
  body?: string;
  multi?: boolean;
  until?: string;
  code?: string;
  channelId?: string;
  userId?: string;
  asBot?: boolean;
  cookie?: string;
  mentionToken?: string;
  mentionCookie?: string;
}

/** The `slack poll --results=…` line handed back after posting. Printed as a
 *  runnable command rather than a bare permalink for the same reason `ask`
 *  does it: nothing else reads pressed pills back, and a link does not tell you
 *  how to count them. */
function pollResultsCommand(shown: string): string {
  // No `--as-bot` here even for a poll the bot posted: counting is a READ, and
  // the user token is the one that carries `reactions:read`. `--close` is the
  // half that needs the bot back (only the poster may rewrite the message), and
  // it takes care of that split itself.
  return `slack poll --results='${shown}'`;
}

async function cmdPoll(token: string, args: PollArgs): Promise<void> {
  const { ref, threadTs } = parseTargetThread(args.target, false);
  const cookie = args.cookie;
  const getSelf = selfLookup(token, cookie);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId, cookie);
  else channelId = await resolveChannel(token, ref, cookie);

  const selfId = (await getSelf())?.userId ?? "";
  const counterpart = await imCounterpart(token, channelId, cookie);

  // Same silent-delivery footgun as `send`/`ask`: Slack never notifies you about
  // your own message, so a poll posted into your own DM reaches nobody.
  if (!args.asBot && !!selfId && counterpart === selfId) {
    console.error(
      `Warning: "${args.target}" is a DM to yourself — Slack will NOT notify you of your own message.\n` +
      `  To reach yourself with a notification, post as the bot:  slack poll '${args.target}' '...' --as-bot`,
    );
  }

  // No addressee gate here, deliberately — this is where `poll` and `ask` part.
  // `ask` refuses an unaddressed question because the first answer DECIDES
  // something, so it matters whose it is. A poll reports a distribution: an
  // extra voter changes the numbers, never the outcome's legitimacy. Tags are
  // still encoded so a poll CAN be pointed at people; they just are not required.
  // Unescaped BEFORE broadcast/mention encoding and before the body is built,
  // which is what makes it work for choices too: `askBuildText` flattens a
  // choice's newlines to spaces (a newline there would split the pill into a
  // line the parser cannot read back), so unescaping afterwards would be a
  // no-op that silently did nothing.
  const qEnc = askEncodeBroadcasts(unescapeArg(args.question));
  const bEnc = askEncodeBroadcasts(unescapeArg(args.body ?? ""));
  const mentionToken = args.mentionToken ?? token;
  const qRep = await encodeMentionsDetailed(mentionToken, qEnc.text, channelId, args.mentionCookie);
  const bRep = bEnc.text
    ? await encodeMentionsDetailed(mentionToken, bEnc.text, channelId, args.mentionCookie)
    : { text: "", resolved: [], unresolved: [] } as MentionEncodeResult;
  const question = qRep.text;
  const body = bRep.text;
  for (const line of mentionWarnings([...qRep.unresolved, ...bRep.unresolved])) {
    console.error(`⚠ ${stripTerminalControls(line)}`);
  }

  const choices = args.choices.map(unescapeArg);
  const multi = !!args.multi;
  const until = args.until ?? "";
  const message = pollBuildText(question, body, choices, { multi, deadline: until });

  // Preview the destination's last message, exactly as `send`/`ask` do. Fail-soft.
  let lastText = "";
  let lastUser = "?";
  try {
    const ctx = (await history(token, channelId, 1, undefined, undefined, cookie)) as Record<string, Json>;
    const lastMsg = asArray(ctx.messages).map(asRecord).filter((m) => m.subtype === undefined || m.subtype === null)[0];
    lastText = typeof lastMsg?.text === "string" ? lastMsg.text : "";
    lastUser = typeof lastMsg?.user === "string"
      ? await userName(token, lastMsg.user, cookie)
      : typeof lastMsg?.username === "string" ? lastMsg.username : "?";
  } catch {
    // best-effort preview only
  }

  const self = await getSelf();
  // Resolved before the gate so the clock can name the recipient's zone. DM
  // only; null means "unknown" and the label says so rather than guessing.
  const recipientTz = await recipientTzFor(token, channelId, cookie);
  const code = safetyCode(channelId, threadTs ?? "", lastText, message, self?.userId ?? "");
  if (args.code !== code) {
    const dest = await destLabel(token, channelId, ref, cookie);
    requireCode(args.code, code, [
      `--- Last message in channel ------------------`,
      `  ${lastUser}: ${lastText.split("\n")[0]?.slice(0, 100) ?? "(empty)"}`,
      `--- Ballot (seeded as reactions) -------------`,
      // As posted: one line per pill (see the ask gate).
      ...choices.map((s, i) => `  ${POLL_KEYCAPS[i]!.glyph} ${pollFlatten(s)}`),
      `--- Posting ----------------------------------`,
      fromLine(self, { asBot: args.asBot }),
      `  → ${dest}${threadTs ? " — THREAD REPLY" : " — NEW top-level message"}`,
      `  Question: ${question}`,
      `  Rule:     ${multi ? "1 人 何票でも (--multi)" : "1 人 1 票"}${until ? ` — 締切 ${until}` : ""}`,
      // Said out loud at the gate: this is the surprising half of the command.
      `  Note:     あなた自身の票は数えません (ピルはあなたが付けた種なので区別できません)`,
      `--------------------------------────────────`,
    ], recipientTz);
  }

  // `plain`: no blocks, or Slack rewrites the stored text and the ballot
  // stops parsing on the way back.
  const ts = await slackSend(token, channelId, message, threadTs, false, cookie, true);

  // Marker first, for the same reason as `ask`: it is what makes
  // `has::ballot_box_with_ballot:` list every poll. An unrelated reaction on the message is
  // already ignored by the tally (it counts keycap names only), so this costs
  // the ballot nothing.
  // Marker first, then 1,2,3 — and spaced out, for the reason `ask` documents
  // at its own seeding call and ts/reactionSeed.ts documents in full.
  await seedReactionsInOrder(
    [POLL_MARKER, ...choices.map((_, i) => POLL_KEYCAPS[i]!.name)],
    (name) => reactionAdd(token, channelId, ts, name, cookie),
    (name, e) => {
      const why = e instanceof Error ? e.message : String(e);
      // A missing seed costs a voter a trip to the emoji picker; it does not
      // invalidate a poll that is already posted.
      if (name === POLL_MARKER) console.error(`  (marker ${name} を付けられませんでした: ${why})`);
      else console.error(`  (リアクション ${name} を付けられませんでした: ${why})`);
    },
  );

  let permalink = "";
  try {
    permalink = await getPermalink(token, channelId, ts, cookie);
  } catch {
    // fail-soft, same as send
  }
  const shown = permalink || `${channelId}:${ts}`;
  console.error(`✓ Posted: ${shown}`);
  console.log(pollResultsCommand(shown));
  console.error(`  締め切る:  slack poll --close='${shown}'${args.asBot ? " --as-bot" : ""}`);
}

/** Locate + read back one posted poll. Shared by `--results` and `--close`,
 *  which differ only in whether they write the tally back into the message. */
async function pollFetch(token: string, link: string, cookie?: string): Promise<{ channelId: string; ts: string; msg: Record<string, Json> }> {
  const url = parseSlackPermalink(link);
  let channelId: string;
  let ts: string;
  let threadTs: string | undefined;
  if (url?.ts) {
    channelId = url.channel;
    ts = url.ts;
    threadTs = url.threadTs && url.threadTs !== url.ts ? url.threadTs : undefined;
  } else {
    // `C…:1700000000.000100` — the fallback printed when the permalink lookup
    // itself failed, so it has to be readable too.
    const m = link.match(/^([A-Za-z0-9]+):(\d{10}\.\d{6})$/);
    if (!m) {
      console.error(
        `Error: --results/--close needs the permalink of a poll (or 'C…:1700000000.000100').\n` +
        `  Got: ${stripTerminalControls(link)}`,
      );
      process.exit(POLL_EXIT_ERROR);
    }
    channelId = m[1]!;
    ts = m[2]!;
  }

  // A poll posted into a thread is not in history at all.
  let msg: Record<string, Json> | undefined;
  if (threadTs) {
    const rep = asRecord((await replies(token, channelId, threadTs, 100, cookie)) as Json);
    msg = asArray(rep.messages).map(asRecord).find((m) => m.ts === ts);
  } else {
    const hist = asRecord((await history(token, channelId, 1, ts, undefined, cookie, true)) as Json);
    msg = asArray(hist.messages).map(asRecord).find((m) => m.ts === ts);
  }
  if (!msg) {
    console.error(`Error: そのメッセージが見つかりません: ${stripTerminalControls(link)}`);
    process.exit(POLL_EXIT_ERROR);
  }
  return { channelId, ts, msg };
}

/** Render a tally. Bars are proportional to the leader, not to the total, so a
 *  three-way split still reads as three different lengths. */
function pollFormatTallies(tallies: { choice: string; count: number }[]): string[] {
  const max = Math.max(1, ...tallies.map((t) => t.count));
  return tallies.map((t, i) =>
    `${POLL_KEYCAPS[i]!.glyph} ${String(t.count).padStart(3)}  ${"█".repeat(Math.round((t.count / max) * 20))}${t.count ? " " : ""}${t.choice}`,
  );
}

/** `slack poll --results <permalink>` — count the pills. READ-ONLY: it posts
 *  nothing and edits nothing, so it is safe to run on a schedule, and it is the
 *  main path (`--close` is the one-time end of a poll, not how you check it). */
async function cmdPollResults(token: string, args: { link: string; close?: boolean; cookie?: string; names?: boolean; writeToken?: string; writeCookie?: string; noNotify?: boolean }): Promise<void> {
  const { channelId, ts, msg } = await pollFetch(token, args.link, args.cookie);
  const text = typeof msg.text === "string" ? msg.text : "";
  const parsed = pollParseMessage(text);
  if (parsed.kind === "other") {
    console.error(
      `Error: これは \`slack poll\` の投票ではありません (票の数え方が分かりません)。\n` +
      `  ${stripTerminalControls(args.link)}`,
    );
    process.exit(POLL_EXIT_ERROR);
  }
  if (parsed.kind === "closed") {
    // Already closed: report what was RECORDED, never a fresh count. A pill
    // pressed after closing would otherwise silently change a settled result.
    console.error(`✓ 投票終了: ${stripTerminalControls(parsed.question)}`);
    for (const line of pollFormatTallies(parsed.tallies)) console.log(line);
    return;
  }

  // The seeder is whoever POSTED — not whoever is running this command. On a
  // later run the two differ (and under --as-bot they always do), so taking the
  // current identity would count the seeds as votes.
  const exclude = new Set<string>();
  if (typeof msg.user === "string" && msg.user) exclude.add(msg.user);
  const reactions = await reactionsGet(token, channelId, ts, args.cookie);
  const counted = pollTally(parsed.choices, reactions, exclude, parsed.multi);

  console.error(`${stripTerminalControls(parsed.question)}${parsed.deadline ? ` (締切 ${parsed.deadline})` : ""}`);
  for (const line of pollFormatTallies(counted.tallies)) console.log(line);
  const total = counted.tallies.reduce((n, t) => n + t.count, 0);
  console.error(`  計 ${total} 票${parsed.multi ? " (複数選択可)" : ""}`);
  if (args.names) {
    for (let i = 0; i < counted.voters.length; i++) {
      if (!counted.voters[i]!.length) continue;
      const names = await Promise.all(counted.voters[i]!.map((u) => userName(token, u, args.cookie)));
      console.error(`  ${POLL_KEYCAPS[i]!.glyph} ${names.map((n) => `@${stripTerminalControls(n)}`).join(", ")}`);
    }
  }
  // Same notice as `ask`, for the same reason: the voter is the one who has to
  // fix it, and the voter is in Slack. Idempotent — rebuilt from this count, so
  // running `--results` on a schedule neither stacks notices up nor leaves a
  // stale one behind once the extra pill is taken back.
  const wanted = parsed.multi ? [] : counted.ambiguous;
  const nextText = applyInvalidNotice(text, wanted);
  if (nextText !== text && !args.noNotify) {
    try {
      await editMessage(args.writeToken ?? token, channelId, ts, nextText, args.writeToken ? args.writeCookie : args.cookie, true);
    } catch (e: unknown) {
      console.error(
        `  (投票文に注意書きを入れられませんでした: ${e instanceof Error ? e.message : String(e)})\n` +
        `   メッセージを書き換えられるのは投稿者だけです — bot が投稿した投票なら --as-bot を付けてください。`,
      );
    }
  }
  if (counted.ambiguous.length) {
    // Not counted for anything, and said so out loud: a reaction carries no
    // timestamp anywhere in the Slack API, so "the latest one" does not exist.
    const names = await Promise.all(counted.ambiguous.map((u) => userName(token, u, args.cookie)));
    console.error(`⚠ 1 人 1 票なのに複数押している人がいます (無効票): ${names.map((n) => `@${stripTerminalControls(n)}`).join(", ")}`);
  }

  if (!args.close) return;

  // Freeze it. The edit is what makes the result final — after this the body no
  // longer parses as an open poll, so a late pill changes nothing.
  // Counting and closing can need DIFFERENT tokens: `reactions.get` lives on
  // the user token, but only the poster may rewrite the message — and for a
  // `--as-bot` poll the poster is the bot. Same split as `ask`'s mention token.
  await editMessage(args.writeToken ?? token, channelId, ts, pollBuildClosedText(parsed.question, counted.tallies), args.writeToken ? args.writeCookie : args.cookie, true);
  try {
    await reactionAdd(args.writeToken ?? token, channelId, ts, POLL_CLOSED_MARKER, args.writeToken ? args.writeCookie : args.cookie);
    await reactionRemove(args.writeToken ?? token, channelId, ts, POLL_MARKER, args.writeToken ? args.writeCookie : args.cookie);
  } catch {
    // Cosmetic: the 📊 body is what makes it closed.
  }
  console.error(`✓ 投票を締め切りました: ${stripTerminalControls(args.link)}`);
}

async function cmdDoctor(token: string): Promise<void> {
  const diag = await diagnoseBotMessaging(token);
  for (const line of formatDiagnosis(diag, false)) console.log(line);
  if (!diag.ok) process.exit(1);
}

// --- schedule ---

/** The xoxb bot token, or a clean exit. `--as-bot` is only ever a token switch,
 *  and its failure is always the same one: the env var is not set. */
function requireBotToken(): string {
  const botToken = resolveBotToken();
  if (!botToken) {
    console.error(
      "Error: --as-bot needs a bot token, but no xoxb- token was found.\n" +
      "  Set SLACK_BOT_TOKEN=xoxb-... in ~/.config/slack-cli/.env (or your shell).",
    );
    process.exit(1);
  }
  return botToken;
}

/** The bot↔user DM for an `@handle`. The handle is resolved on the USER token
 *  (which has users:read) and the DM is opened on the BOT token, so the channel
 *  is the bot's IM with that person and not the person's own self-DM. That
 *  distinction is the entire point of `--as-bot` here: Slack never notifies you
 *  about your own message, so a digest scheduled into a self-DM is delivered
 *  into silence at the one moment nobody is at the terminal to notice. */
async function botDmForTarget(
  target: string,
  botToken: string,
  userToken: string,
  userCookie?: string,
): Promise<string> {
  const userId = await resolveUserId(userToken, target, userCookie);
  return openDm(botToken, userId);
}

function parsePostAt(at: string): number {
  if (/^\d{10,}$/.test(at)) return parseInt(at, 10);
  const d = new Date(at.replace(" ", "T"));
  if (isNaN(d.getTime())) throw new Error(`Cannot parse time: ${at}`);
  return Math.floor(d.getTime() / 1000);
}

/** Render a scheduled post time as local AND UTC: "2026-08-10 18:00:00 GMT+9
 *  (local) / 2026-08-10T09:00:00.000Z (Unix: 1786352400)". A schedule gate is
 *  exactly where an off-by-a-timezone mistake gets locked in — `--at` accepts
 *  both bare local times and `Z`-suffixed UTC, so showing only one form leaves
 *  the reader doing the conversion in their head. Local is first: it's the form
 *  the sender thinks in. */
function fmtPostAt(postAt: number): string {
  const d = new Date(postAt * 1000);
  const local = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZoneName: "short",
  })
    .format(d)
    // sv-SE renders a west-of-UTC offset with U+2212 MINUS SIGN ("GMT−4"), which
    // survives copy/paste into a shell or a grep as a non-ASCII byte. Plain hyphen.
    .replace(/−/g, "-");
  return `${local} (local) / ${d.toISOString()} (Unix: ${postAt})`;
}

interface ScheduleSendArgs {
  target: string;
  message: string;
  at: string;
  code?: string;
  channelId?: string;
  userId?: string;
  cookie?: string;
  asBot?: boolean;
  /** How the caller overrode the target text, e.g. `--user-id U0123`. Set only
   *  when a FLAG supplied it — never when the command resolved the id itself. */
  targetOverride?: string;
}
async function cmdScheduleSend(token: string, args: ScheduleSendArgs): Promise<void> {
  const getSelf = selfLookup(token, args.cookie);
  const { ref, threadTs } = parseTargetThread(args.target);

  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else if (args.userId) channelId = await openDm(token, args.userId, args.cookie);
  else channelId = await resolveChannel(token, ref, args.cookie);

  const postAt = parsePostAt(args.at);
  const postAtDate = new Date(postAt * 1000).toISOString();
  // Identity in the hash, same as the other gated writes. It matters more here
  // than anywhere else: the message goes out later, unattended, under whichever
  // identity was current at schedule time.
  const self = await getSelf();

  // Self-DM is worst here: the message fires later, unattended, and Slack never
  // notifies you about your own post — so a scheduled reminder to yourself is
  // delivered into silence at exactly the moment you were counting on it.
  // --as-bot is exempt: that posts as the app, a different identity, which does
  // notify you. Being unable to say that is what made this warning a dead end —
  // it named the problem and offered no way out.
  if (!args.asBot && await isSelfDmChannel(token, channelId, self?.userId, args.cookie)) {
    console.error(
      `Warning: "${args.target}" is a DM to yourself — Slack will NOT notify you when this fires.\n` +
      `  To be notified, schedule it as the bot:  slack schedule send '${args.target}' '...' --at '${args.at}' --as-bot`,
    );
  }

  const code = safetyCode(channelId, args.message, String(postAt), self?.userId ?? "");

  // `--channel-id` / `--user-id` win over the target text, so the target stops
  // being where this goes the moment the two disagree — and the gate printed
  // only the target. `schedule send @alice … --user-id <bob>` read "To: @alice"
  // and went to bob. A confirm gate that names the wrong recipient with no sign
  // it was overridden is worse than no gate: it gets read, and it gets passed.
  const destOverride = args.targetOverride ? `  [${args.targetOverride} → ${channelId}]` : "";

  if (args.code !== code) {
    // Quiet hours are judged on post_at, in the recipient's zone — the two facts
    // that decide whether a phone buzzes at 3am, and the two this gate was
    // guessing at. `send` already resolves the zone; here the time is known
    // exactly, which is the one command where it is.
    const recipientTz = await recipientTzFor(token, channelId, args.cookie);
    requireCode(args.code, code, [
      `--- Scheduling message -----------------------`,
      fromLine(self, { asBot: args.asBot, pad: 9 }),
      `  To:      ${ref}${threadTs ? ` (thread ${threadTs})` : ""}${destOverride}`,
      `  At:      ${fmtPostAt(postAt)}`,
      `  Message: ${args.message}`,
      `---------------------------------------------`,
    ], recipientTz, new Date(postAt * 1000));
  }
  const id = await scheduleMessage(token, channelId, args.message, postAt, threadTs, args.cookie);
  console.log(`✓ Scheduled (id: ${id}, at: ${postAtDate})`);

  if (args.asBot) {
    // The message now belongs to the BOT, so `schedule ls` on the user token
    // cannot see it and `schedule rm` cannot cancel it. Said at the only moment
    // the id is in front of the reader.
    console.error(
      `  Scheduled as the bot — the user token cannot see or cancel it. Use the same flag:\n` +
      `    slack schedule ls --as-bot\n` +
      `    slack schedule rm '${args.target}' ${id} --as-bot`,
    );
    // A scheduled bot DM fires unattended, so an app that cannot actually carry
    // a DM fails at the one moment nobody is watching. Same check `send --as-bot`
    // runs after the fact; here it is the difference between finding out now and
    // finding out from an empty inbox.
    if (channelId.startsWith("D")) {
      try {
        const diag = await diagnoseBotMessaging(token);
        if (!diag.ok) {
          for (const line of formatDiagnosis(diag, true)) console.error(line);
        } else {
          const appUrl = diag.appId ? `https://api.slack.com/apps/${diag.appId}` : "https://api.slack.com/apps";
          console.error(
            `Note: if ${args.target} can't reply (app messaging may be off), ` +
            `enable Messages Tab: ${appUrl} → App Home.`,
          );
        }
      } catch {
        // diagnosis is best-effort; never turn a successful schedule into a failure.
      }
    }
  }
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
  asBot?: boolean;
  /** How the caller overrode the target text, e.g. `--channel-id C0123`. */
  targetOverride?: string;
}
async function cmdScheduleRm(token: string, args: ScheduleRmArgs): Promise<void> {
  let channelId: string;
  if (args.channelId) channelId = args.channelId;
  else channelId = await resolveChannel(token, args.target, args.cookie);

  const self = await selfIdentity(token, args.cookie);
  const code = safetyCode(channelId, args.id, self?.userId ?? "");
  if (args.code !== code) {
    requireCode(args.code, code, [
      `--- Deleting scheduled message ---------------`,
      fromLine(self, { asBot: args.asBot, pad: 9 }),
      `  Channel: ${args.target}${args.targetOverride ? `  [${args.targetOverride} → ${channelId}]` : ""}`,
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
  const getSelf = selfLookup(token, args.cookie);
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

  // Same silent-delivery footgun as `send`: a file uploaded to your own DM
  // notifies nobody, so it lands and is never seen.
  if (await isSelfDmChannel(token, channelId, (await getSelf())?.userId, args.cookie)) {
    console.error(`Warning: "${args.target}" is a DM to yourself — Slack will NOT notify you of your own upload.`);
  }

  const isBatch = args.filePaths.length > 1;
  const files = args.filePaths.map((fp) => {
    const filename = basename(fp);
    const title = isBatch ? filename : (args.title ?? filename);
    return { fp, filename, title, sizeFmt: fmtSize(statSync(fp).size) };
  });

  // Safety code covers the full batch, plus the uploading identity (same rule
  // as send/edit/delete — the file lands under whoever the token is).
  const self = await getSelf();
  const code = safetyCode(channelId, ...files.flatMap((f) => [f.fp, f.title]), self?.userId ?? "");
  if (args.code !== code) {
    const destLine = `  To:    ${ref}${threadTs ? ` (thread ${threadTs})` : ""}`;
    const lines = isBatch
      ? [
          `--- Uploading ${files.length} files ------------------------`,
          fromLine(self, { pad: 7 }),
          destLine,
          ...files.map((f) => `    ${f.filename}  (${f.sizeFmt})`),
          `--------------------------------────────────`,
        ]
      : [
          `--- Uploading file ---------------------------`,
          fromLine(self, { pad: 7 }),
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

// --- lists <ref> — read a Slack List's rows (read-only) ---
// ref: a list URL (…/lists/<TEAM>/<F-id> or …/lists/<F-id>) or a bare F-id.
// There is no list-enumeration API, so the id must come from the list's URL.
function parseListId(ref: string): string | undefined {
  if (/^F[A-Z0-9]+$/i.test(ref)) return ref;
  return ref.match(/\/lists\/[A-Za-z0-9]+\/(F[A-Za-z0-9]+)/i)?.[1]
    ?? ref.match(/\/lists\/(F[A-Za-z0-9]+)/i)?.[1];
}

// Best-effort display of a Slack List cell across the value shapes the API uses
// (plain text, typed value, arrays of {text|name|value}, typed sub-objects).
function listFieldValue(f: Record<string, Json>): string {
  if (typeof f.text === "string" && f.text) return f.text;
  const v = f.value;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v.map((x) => typeof x === "string" ? x : String(asRecord(x).text ?? asRecord(x).name ?? asRecord(x).value ?? "")).filter(Boolean).join(", ");
  }
  for (const k of ["rich_text", "select", "user", "date", "number", "checkbox", "email", "phone"]) {
    const tv = f[k];
    if (tv != null) return typeof tv === "object" ? JSON.stringify(tv) : String(tv);
  }
  return "";
}

async function cmdLists(
  token: string,
  cookie: string | undefined,
  ref: string,
  opts: { limit: number; format: string },
): Promise<void> {
  const listId = parseListId(ref);
  if (!listId) {
    throw new Error(
      `Not a list ID or list URL: ${ref}\n` +
      `Expected F… or https://<ws>.slack.com/lists/<TEAM>/<F-id>`,
    );
  }
  const records: Record<string, Json>[] = [];
  let cursor: string | undefined;
  do {
    const listOpts: { limit: number; cursor?: string } = { limit: 200 };
    if (cursor) listOpts.cursor = cursor;
    const resp = asRecord((await listRecords(token, listId, listOpts, cookie)) as Json);
    for (const it of asArray(resp.items ?? resp.records)) records.push(asRecord(it));
    const next = asRecord(resp.response_metadata).next_cursor;
    cursor = typeof next === "string" && next ? next : undefined;
  } while (cursor && records.length < opts.limit);
  const shown = records.slice(0, opts.limit);

  if (opts.format === "jsonl") {
    for (const r of shown) console.log(JSON.stringify(r));
    return;
  }
  for (const r of shown) {
    const id = String(r.id ?? "");
    const cells = asArray(r.fields)
      .map(asRecord)
      .map((f) => {
        const col = String(f.key ?? f.column_id ?? "?");
        const val = listFieldValue(f);
        return val ? `${col}=${val}` : "";
      })
      .filter(Boolean);
    console.log(`${id}  ${cells.join(" | ")}`);
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

  // `todo ls` and `mytodo ls` are the same listing over two different search
  // scopes — `has:` (anyone's reactions) vs `hasmy:` (only this token's). They
  // share one definition so the flags can never drift apart; `mine` is the only
  // difference. Splitting them into separate commands is deliberate: the old
  // single `todo ls` defaulted to `hasmy:` with a `--shared` opt-in, and "is
  // this everyone's list or just mine?" is not a question a flag answers at a
  // glance.
  const TODO_LS_OPTIONS: Record<string, Options> = {
    state: {
      type: "string",
      choices: ["open", "untriaged", "pending", "doing", "done", "dropped", "stuck"],
      default: "open",
      describe: "open (default) = marked and not done/dropped; untriaged = marked with no progress; stuck = unfinished with a reason flag",
    },
    in: { type: "string", describe: "Limit to a channel (#chan)" },
    from: { type: "string", describe: "Limit to a sender (@user, or 'me') — usually the person a task is waiting on" },
    n: { alias: "count", type: "number", default: 50, describe: "Max results" },
    json: { type: "boolean", default: false },
  };
  // Runs both listings. `mine` fixes the search scope per command; `--mine` on
  // `todo ls` is the one-off escape hatch to the narrow view.
  const runTodoLs = async (
    argv: W & { state?: string; in?: string; from?: string; mine?: boolean; n?: number; json?: boolean },
    mine: boolean,
  ) => {
    const opts: { state: LsState; in?: string; from?: string; mine: boolean; count: number; json: boolean; cookie?: string } = {
      state: (argv.state ?? "open") as LsState,
      mine: mine || argv.mine === true,
      count: argv.n ?? 50,
      json: argv.json === true,
    };
    if (argv.in) opts.in = argv.in;
    if (argv.from) opts.from = argv.from;
    const cookie = ck(argv);
    if (cookie) opts.cookie = cookie;
    await cmdTodoLs(tok(argv), opts);
  };

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
        .option("json", { type: "boolean", default: false, describe: "Alias for --format=jsonl" })
        .option("unreplied", { type: "boolean", default: false, describe: "Only messages whose last word (incl. thread replies) is not yours — i.e. awaiting your answer" }),
      async (argv) => {
        const token = tok(argv as W);
        const format = argv.json ? "jsonl" : (argv.format as "text" | "jsonl");
        if (argv.target) await cmdMsgsTarget(token, argv.target, argv.limit, format, argv.unreplied, ck(argv as W));
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
        await cmdThread(tok(argv as W), argv.target!, argv.ts!, argv.limit, format, ck(argv as W));
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
            // The creator becomes the channel's owner and the inviter of record —
            // so the gate names them, and the code is bound to them.
            const self = await selfIdentity(token, cookie);
            const code = safetyCode(name, String(isPrivate), invites.join(","), self?.userId ?? "");
            if (argv.code !== code) requireCode(argv.code, code, [
              `--- Creating channel -------------------------`,
              fromLine(self, { pad: 9 }),
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
            .option("json", { type: "boolean", default: false, describe: "Alias for --format=jsonl" })
            .option("external", { type: "boolean", default: false, describe: "Also include people reachable only through Slack Connect shared channels — they are in ANOTHER workspace, so users.list never returns them (costs one API call per shared channel)" }),
          async (argv) => {
            const format = argv.json ? "jsonl" : argv.format;
            const lsToken = tok(argv as W);
            const lsCookie = ck(argv as W);
            // The cookie is not optional on a desktop (xoxc-) token: `users.list` is a
            // public Web API call, and without it Slack answers `invalid_auth`.
            const resp = (await listUsers(lsToken, lsCookie)) as Record<string, Json>;
            const filter = argv.filter?.toLowerCase();
            let all = asArray(resp.members).map(asRecord);
            if (argv.external) {
              // `users.list` is scoped to YOUR workspace. A Slack Connect
              // counterpart belongs to a different team, so they are absent from
              // it entirely — no flag on the call changes that. The only place
              // they exist is the membership of the channel you share, which is
              // why this walks the externally-shared channels instead.
              const known = new Set(all.map((u) => String(u.id)));
              const conv = asRecord((await listConversations(lsToken, lsCookie)) as Json);
              const shared = asArray(conv.channels).map(asRecord).filter((c) => c.is_ext_shared === true && !!c.name);
              const extra = new Set<string>();
              for (const c of shared) {
                try {
                  for (const id of await listConversationMembers(lsToken, String(c.id), lsCookie)) {
                    if (!known.has(id)) extra.add(id);
                  }
                } catch {
                  // A channel we cannot read the roster of costs us its members,
                  // not the whole listing.
                }
              }
              for (const id of extra) {
                try {
                  const info = asRecord((await userInfo(lsToken, id, lsCookie)) as Json);
                  const u = asRecord(info.user);
                  if (u.id) all.push(u);
                } catch {
                  // ditto: skip the one we cannot resolve
                }
              }
            }
            const members = all
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
            // Whose workspace this is, so a Connect counterpart can be told from
            // a guest: both are "not a normal colleague", but only one of them
            // is someone your admin can actually manage.
            const myTeam = members.length
              ? String(asRecord(asArray(resp.members).map(asRecord)[0] ?? {}).team_id ?? "")
              : "";
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
              // Said out loud, because it changes what you may assume about the
              // person: a single-channel guest cannot see anything but the one
              // channel, and an external user is not in your workspace at all.
              const team = String(u.team_id ?? "");
              const kind = u.is_stranger === true || (myTeam && team && team !== myTeam)
                ? `external:${team || "?"}`
                : u.is_ultra_restricted === true ? "single-channel guest"
                : u.is_restricted === true ? "guest"
                : "";
              const meta = [email, tzPart].filter(Boolean).join("  ");
              console.log(`@${handle}  ${id}  ${parts}${meta ? "  " + meta : ""}${kind ? `  [${kind}]` : ""}`);
            }
          },
        )
        .command(
          "get <user>",
          "Show user details",
          (y2) => y2.positional("user", { type: "string", demandOption: true, describe: "@handle or user ID" }),
          async (argv) => {
            const token = tok(argv as W);
            const cookie = ck(argv as W);
            const ref = argv.user!.startsWith("@") ? argv.user! : `@${argv.user!}`;
            // resolveUserId owns every population: the id form, self, the
            // workspace roster, and the Slack Connect partners users.list cannot
            // see. Matching `u.name` against this list by hand — as this used to
            // — missed display names, real names, and everyone from another team.
            let userId = "";
            try {
              userId = await resolveUserId(token, ref, cookie);
            } catch (e) {
              console.error(e instanceof Error ? e.message : String(e));
              process.exit(1);
            }
            // The cookie is not optional here: on a desktop (xoxc-) token the
            // public Web API answers invalid_auth without it, which read as
            // "your token is wrong" on a lookup that was about to succeed.
            const resp = asRecord((await userInfo(token, userId, cookie)) as Json);
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
      "ask [target] [question] [choices..]",
      "Ask a question with its choices pre-seeded as 1️⃣..🔟 reactions (confirm-hash safety gate)",
      (y) => y
        .positional("target", { type: "string", describe: "#chan, @user, #chan:thread_ts, or permalink (omit with --waitFor)" })
        .positional("question", { type: "string", describe: "The question. Must @tag whoever may answer (@alice), or the whole channel (@here / @channel / @everyone) — only their answer counts. In a 1:1 DM the other party counts automatically." })
        .positional("choices", { type: "string", array: true, describe: "Up to 10 choices, seeded as 1️⃣..🔟 reactions. Beyond 10 they are listed but answerable only by text. With none, the question asks for a free-text reply." })
        .option("code", { type: "string", describe: "Safety hash to confirm the ask" })
        .option("body", { type: "string", describe: "Extra context shown under the question" })
        .option("wait", { type: "boolean", default: false, describe: "Block until answered; print ONLY the answer on stdout. Exit 0 = answered, 2 = nobody replied, 3 = transport failure, 4 = somebody replied but picked none of the choices (stdout empty — do not act on it)." })
        .option("waitFor", { type: "string", describe: "Collect the answer to a question already posted: pass its permalink. Nothing is posted. Same stdout/exit contract as --wait; --timeout 0 checks once and exits 2 if still open." })
        .option("timeout", { type: "number", default: 3600, describe: "Overall limit for --wait / --waitFor, in seconds (0 with --waitFor = check once)" })
        .option("channel-id", { type: "string", describe: "Raw channel ID" })
        .option("user-id", { type: "string", describe: "Raw user ID (opens DM)" })
        .option("as-bot", { type: "boolean", default: false, describe: "Ask via the bot token (xoxb / SLACK_BOT_TOKEN) so a DM notifies the recipient" }),
      async (argv) => {
        const waitFor = argv.waitFor ? String(argv.waitFor) : "";
        const timeout = Number(argv.timeout);
        // 0 is a real value only for --waitFor ("look once"). For --wait it would
        // mean "give up before asking", which is never what anyone meant.
        if (!Number.isFinite(timeout) || timeout < 0 || (timeout === 0 && !waitFor)) {
          console.error("Error: --timeout must be a positive number of seconds");
          process.exit(ASK_EXIT_ERROR);
        }
        if (waitFor) {
          // Collect-only: nothing is posted, so there is no confirm gate and no
          // question to supply. Anything that would have been posted is a sign
          // the caller mixed the two modes up.
          if (argv.target || argv.question || (argv.choices as string[] | undefined)?.length) {
            console.error("Error: --waitFor collects an existing question — do not also pass a target/question/choices.");
            process.exit(ASK_EXIT_ERROR);
          }
          let waitToken: string;
          let waitCookie: string | undefined;
          if (argv["as-bot"]) {
            const botToken = resolveBotToken();
            if (!botToken) {
              console.error(
                "Error: --as-bot needs a bot token, but no xoxb- token was found.\n" +
                "  Set SLACK_BOT_TOKEN=xoxb-... in ~/.config/slack-cli/.env (or your shell).",
              );
              process.exit(ASK_EXIT_ERROR);
            }
            waitToken = botToken;
          } else {
            waitToken = tok(argv as W);
            waitCookie = ck(argv as W);
          }
          try {
            const a: { link: string; timeout: number; asBot: boolean; cookie?: string } = { link: waitFor, timeout, asBot: !!argv["as-bot"] };
            if (waitCookie) a.cookie = waitCookie;
            await cmdAskWaitFor(waitToken, a);
          } catch (e: unknown) {
            console.error(friendlySlackError(e));
            process.exit(ASK_EXIT_ERROR);
          }
          return;
        }
        if (!argv.target) {
          console.error("Error: target is required (or use --waitFor <permalink> to collect an answer)");
          process.exit(ASK_EXIT_ERROR);
        }
        const question = String(argv.question ?? "").trim();
        if (!question) {
          console.error("Error: question is empty");
          process.exit(ASK_EXIT_ERROR);
        }
        const args: AskArgs = {
          target: argv.target!,
          question,
          choices: ((argv.choices as string[] | undefined) ?? []).map((s) => String(s).trim()).filter(Boolean),
          timeout,
        };
        if (argv.code) args.code = argv.code;
        if (argv.body) args.body = argv.body;
        if (argv.wait) args.wait = true;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        if (argv["user-id"]) args.userId = argv["user-id"];
        // Always resolve @tags with the user token (it has users:read), even
        // when the question itself is posted by the bot.
        args.mentionToken = tok(argv as W);
        const mc = ck(argv as W);
        if (mc) args.mentionCookie = mc;

        let askToken: string;
        if (argv["as-bot"]) {
          const botToken = resolveBotToken();
          if (!botToken) {
            console.error(
              "Error: --as-bot needs a bot token, but no xoxb- token was found.\n" +
              "  Set SLACK_BOT_TOKEN=xoxb-... in ~/.config/slack-cli/.env (or your shell).",
            );
            process.exit(ASK_EXIT_ERROR);
          }
          // Resolve @user with the *user* token (has users:read), then let cmdAsk
          // open the DM with the bot token — same split as `send --as-bot`.
          if (!args.channelId && !args.userId && args.target.startsWith("@")) {
            try {
              args.userId = await resolveUserId(tok(argv as W), args.target, ck(argv as W));
            } catch (e: unknown) {
              console.error(
                `Error: could not resolve ${args.target} to a user for the bot DM.\n` +
                `  ${e instanceof Error ? e.message : String(e)}\n` +
                `  Tip: pass --user-id <Uxxxx> to skip the lookup.`,
              );
              process.exit(ASK_EXIT_ERROR);
            }
          }
          askToken = botToken;
          args.asBot = true;
        } else {
          askToken = tok(argv as W);
          const sc = ck(argv as W);
          if (sc) args.cookie = sc;
        }
        try {
          await cmdAsk(askToken, args);
        } catch (e: unknown) {
          console.error(friendlySlackError(e));
          // 3, not 1: `--wait` callers branch on the exit code, and a transport
          // failure must be distinguishable from "timed out" (2).
          process.exit(ASK_EXIT_ERROR);
        }
      },
    )
    .command(
      ["poll [target] [question] [choices..]", "vote [target] [question] [choices..]"],
      "Post a poll with its choices pre-seeded as 1️⃣..🔟 reactions, then count them (confirm-hash safety gate)",
      (y) => y
        .positional("target", { type: "string", describe: "#chan, @user, #chan:thread_ts, or permalink (omit with --results/--close)" })
        .positional("question", { type: "string", describe: "The question. @tags are optional here — unlike `ask`, a poll needs no addressee: anyone who can see it may vote." })
        .positional("choices", { type: "string", array: true, describe: "2..10 choices, seeded as 1️⃣..🔟 reactions for voters to click" })
        .option("multi", { type: "boolean", default: false, describe: "Let one person pick several choices (default: 1 人 1 票)" })
        .option("until", { type: "string", describe: "Deadline shown in the message (display only — closing is still `--close`)" })
        .option("results", { type: "string", describe: "Count an existing poll: pass its permalink. Posts nothing; only edit is the invalid-ballot notice in the poll itself (--no-notify to suppress)." })
        .option("close", { type: "string", describe: "Count an existing poll AND freeze the tally into the message. Only the poster can do this." })
        .option("names", { type: "boolean", default: false, describe: "Also list who voted for what (stderr)" })
        .option("no-notify", { type: "boolean", default: false, describe: "With --results: do not write the invalid-ballot notice back into the message (keeps it strictly read-only)" })
        .option("code", { type: "string", describe: "Safety hash to confirm the post" })
        .option("body", { type: "string", describe: "Extra context shown under the question" })
        .option("channel-id", { type: "string", describe: "Raw channel ID" })
        .option("user-id", { type: "string", describe: "Raw user ID (opens DM)" })
        .option("as-bot", { type: "boolean", default: false, describe: "Post via the bot token (xoxb / SLACK_BOT_TOKEN) so a DM notifies the recipient — and so YOUR OWN vote counts, since the seeds are then the bot's" }),
      async (argv) => {
        const readLink = argv.close ? String(argv.close) : argv.results ? String(argv.results) : "";
        if (argv.results && argv.close) {
          console.error("Error: pass --results or --close, not both (--close counts as well).");
          process.exit(POLL_EXIT_ERROR);
        }
        const botTokenOrExit = (): string => {
          const botToken = resolveBotToken();
          if (!botToken) {
            console.error(
              "Error: --as-bot needs a bot token, but no xoxb- token was found.\n" +
              "  Set SLACK_BOT_TOKEN=xoxb-... in ~/.config/slack-cli/.env (or your shell).",
            );
            process.exit(POLL_EXIT_ERROR);
          }
          return botToken;
        };
        if (readLink) {
          if (argv.target || argv.question || (argv.choices as string[] | undefined)?.length) {
            console.error("Error: --results/--close reads an existing poll — do not also pass a target/question/choices.");
            process.exit(POLL_EXIT_ERROR);
          }
          // Counting always runs on the USER token: `reactions.get` is a user
          // scope, and a bot that can post a poll usually cannot read its pills.
          // `--as-bot` here means only "the bot is the poster", which matters
          // solely for the `--close` rewrite.
          const readToken = tok(argv as W);
          const readCookie = ck(argv as W);
          try {
            const a: { link: string; close?: boolean; cookie?: string; names?: boolean; writeToken?: string; writeCookie?: string; noNotify?: boolean } = { link: readLink };
            if (argv.close) a.close = true;
            if (argv.names) a.names = true;
            if (argv["no-notify"]) a.noNotify = true;
            if (readCookie) a.cookie = readCookie;
            // The tally is READ with the user token but WRITTEN by the poster —
            // for a `--as-bot` poll those are two different identities.
            if (argv["as-bot"]) a.writeToken = botTokenOrExit();
            await cmdPollResults(readToken, a);
          } catch (e: unknown) {
            console.error(friendlySlackError(e));
            process.exit(POLL_EXIT_ERROR);
          }
          return;
        }
        if (!argv.target) {
          console.error("Error: target is required (or use --results <permalink> to count a poll)");
          process.exit(POLL_EXIT_ERROR);
        }
        const question = String(argv.question ?? "").trim();
        if (!question) {
          console.error("Error: question is empty");
          process.exit(POLL_EXIT_ERROR);
        }
        const choices = ((argv.choices as string[] | undefined) ?? []).map((s) => String(s).trim()).filter(Boolean);
        // Two is the floor: a one-choice ballot measures nothing, and the ten
        // ceiling is where the keycap emoji stop — there is no text path here to
        // overflow into, so an eleventh choice would be unvotable.
        if (choices.length < 2 || choices.length > POLL_MAX_CHOICES) {
          console.error(`Error: poll needs 2..${POLL_MAX_CHOICES} choices (got ${choices.length}). For a free-text question use \`slack ask\`.`);
          process.exit(POLL_EXIT_ERROR);
        }
        const args: PollArgs = { target: argv.target!, question, choices };
        if (argv.multi) args.multi = true;
        if (argv.until) args.until = String(argv.until);
        if (argv.code) args.code = argv.code;
        if (argv.body) args.body = argv.body;
        if (argv["channel-id"]) args.channelId = argv["channel-id"];
        if (argv["user-id"]) args.userId = argv["user-id"];
        // Always resolve @tags with the user token (it has users:read), even
        // when the poll itself is posted by the bot.
        args.mentionToken = tok(argv as W);
        const mc = ck(argv as W);
        if (mc) args.mentionCookie = mc;

        let pollToken: string;
        if (argv["as-bot"]) {
          const botToken = botTokenOrExit();
          if (!args.channelId && !args.userId && args.target.startsWith("@")) {
            try {
              args.userId = await resolveUserId(tok(argv as W), args.target, ck(argv as W));
            } catch (e: unknown) {
              console.error(
                `Error: could not resolve ${args.target} to a user for the bot DM.\n` +
                `  ${e instanceof Error ? e.message : String(e)}\n` +
                `  Tip: pass --user-id <Uxxxx> to skip the lookup.`,
              );
              process.exit(POLL_EXIT_ERROR);
            }
          }
          pollToken = botToken;
          args.asBot = true;
        } else {
          pollToken = tok(argv as W);
          const sc = ck(argv as W);
          if (sc) args.cookie = sc;
        }
        try {
          await cmdPoll(pollToken, args);
        } catch (e: unknown) {
          console.error(friendlySlackError(e));
          process.exit(POLL_EXIT_ERROR);
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
            .option("user-id", { type: "string", describe: "Raw user ID (opens DM)" })
            .option("as-bot", { type: "boolean", default: false, describe: "Schedule via the bot token (xoxb / SLACK_BOT_TOKEN) so a DM notifies the recipient. Without it a scheduled DM to yourself is posted by you, and Slack never notifies you of your own message — it fires into silence." }),
          async (argv) => {
            const args: ScheduleSendArgs = { target: argv.target!, message: argv.message!, at: argv.at! };
            if (argv.code) args.code = argv.code;
            // Recorded here, not in the command, because only a flag counts as an
            // override — under --as-bot the command sets args.userId itself from
            // the target, and claiming THAT was an override would be a new lie.
            if (argv["channel-id"]) {
              args.channelId = argv["channel-id"];
              args.targetOverride = `--channel-id ${argv["channel-id"]}`;
            }
            if (argv["user-id"]) {
              args.userId = argv["user-id"];
              args.targetOverride = `--user-id ${argv["user-id"]}`;
            }
            let scheduleToken: string;
            if (argv["as-bot"]) {
              const botToken = requireBotToken();
              // Resolve @user → user_id with the *user* token (has users:read),
              // then let cmdScheduleSend open the DM with the bot token
              // (im:write). Same split as `send --as-bot`: the bot never needs
              // users:read, and the DM is bot↔user rather than a self-DM.
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
              scheduleToken = botToken;
              args.asBot = true;
            } else {
              scheduleToken = tok(argv as W);
              // Session cookie for the token that will actually schedule — an
              // xoxc- desktop token is rejected by the public API without it.
              // Bot tokens need none.
              const cookie = ck(argv as W);
              if (cookie) args.cookie = cookie;
            }
            await cmdScheduleSend(scheduleToken, args);
          },
        )
        .command(
          ["ls", "list"],
          "List pending scheduled messages",
          (y2) => y2
            .positional("target", { type: "string", describe: "#channel to filter by" })
            .option("channel-id", { type: "string", describe: "Raw channel ID" })
            .option("as-bot", { type: "boolean", default: false, describe: "List what the BOT token scheduled. A message from `schedule send --as-bot` belongs to the app, so the user token's listing does not contain it — and an invisible pending message cannot be cancelled." }),
          async (argv) => {
            const target = argv.target as string | undefined;
            if (argv["as-bot"]) {
              const botToken = requireBotToken();
              let channelId = argv["channel-id"] as string | undefined;
              if (!channelId && target?.startsWith("@")) {
                channelId = await botDmForTarget(target, botToken, tok(argv as W), ck(argv as W));
              }
              await cmdScheduleList(botToken, target, channelId);
              return;
            }
            await cmdScheduleList(tok(argv as W), target, argv["channel-id"], ck(argv as W));
          },
        )
        .command(
          "rm <target> <id>",
          "Delete a scheduled message",
          (y2) => y2
            .positional("target", { type: "string", demandOption: true, describe: "#channel or @user" })
            .positional("id", { type: "string", demandOption: true, describe: "Scheduled message ID" })
            .option("code", { type: "string", describe: "Safety hash to confirm" })
            .option("channel-id", { type: "string", describe: "Raw channel ID" })
            .option("as-bot", { type: "boolean", default: false, describe: "Cancel a message scheduled with `schedule send --as-bot`. It belongs to the bot token, so the user token cannot delete it." }),
          async (argv) => {
            const args: ScheduleRmArgs = { target: argv.target!, id: argv.id! };
            if (argv.code) args.code = argv.code;
            if (argv["channel-id"]) {
              args.channelId = argv["channel-id"];
              args.targetOverride = `--channel-id ${argv["channel-id"]}`;
            }
            if (argv["as-bot"]) {
              const botToken = requireBotToken();
              if (!args.channelId && args.target.startsWith("@")) {
                args.channelId = await botDmForTarget(args.target, botToken, tok(argv as W), ck(argv as W));
              }
              args.asBot = true;
              await cmdScheduleRm(botToken, args);
              return;
            }
            const cookie = ck(argv as W);
            if (cookie) args.cookie = cookie;
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
      "todo",
      "Reaction-backed task tracking (:pushpin: marks a task, progress lives in a second reaction)",
      (y) => y
        // yargs turns this into --no-cache automatically (boolean negation).
        .option("cache", { type: "boolean", default: true, describe: "Use ~/.config/slack-cli/cache.json for channel/user lookups (--no-cache to bypass)" })
        .middleware((argv) => { if (argv.cache === false) setCacheEnabled(false); })
        .command(
          ["ls", "list"],
          "List everyone's tasks (has: — read-only, one search per run)",
          (y2) => y2
            .options(TODO_LS_OPTIONS)
            .option("mine", { type: "boolean", default: false, describe: "Only your own reactions (hasmy:) — same as `slack mytodo ls`" })
            // Accepted for compatibility: it used to opt in to `has:`, which is
            // now the default here. .strict() rejects unknown flags, so scripts
            // still passing --shared keep working instead of hard-failing.
            .option("shared", { type: "boolean", default: false, hidden: true, describe: "Deprecated — anyone's reactions is the default for `todo ls`" }),
          async (argv) => { await runTodoLs(argv as W & { state?: string }, false); },
        )
        .command(
          "set <target> <state>",
          "Move a task to a progress state (adds the new reaction before removing the old one)",
          (y2) => y2
            .positional("target", { type: "string", demandOption: true, describe: "#chan:ts or permalink" })
            .positional("state", { type: "string", demandOption: true, choices: ["pending", "doing", "done", "dropped"] })
            .option("channel-id", { type: "string", describe: "Raw channel ID" }),
          async (argv) => {
            const args: { target: string; state: ProgressState; channelId?: string; cookie?: string } = {
              target: argv.target!,
              state: argv.state as ProgressState,
            };
            if (argv["channel-id"]) args.channelId = argv["channel-id"];
            const cookie = ck(argv as W);
            if (cookie) args.cookie = cookie;
            try {
              await cmdTodoSet(tok(argv as W), args);
            } catch (e: unknown) {
              console.error(friendlySlackError(e));
              process.exit(1);
            }
          },
        )
        .command(
          "flag <target> <flag>",
          "Add (or --remove) a reason flag (alert | needs-discussion | waiting | blocked) — flags stack, independent of progress",
          (y2) => y2
            .positional("target", { type: "string", demandOption: true, describe: "#chan:ts or permalink" })
            .positional("flag", {
              type: "string",
              demandOption: true,
              choices: ["alert", "needs-discussion", "waiting", "blocked"],
              describe: "waiting = the other party in this conversation owes a reply; blocked = stuck on something outside it",
            })
            .option("remove", { type: "boolean", default: false, describe: "Remove the flag instead of adding it" })
            .option("channel-id", { type: "string", describe: "Raw channel ID" }),
          async (argv) => {
            const args: { target: string; flag: FlagName; remove?: boolean; channelId?: string; cookie?: string } = {
              target: argv.target!,
              flag: argv.flag as FlagName,
            };
            if (argv.remove) args.remove = true;
            if (argv["channel-id"]) args.channelId = argv["channel-id"];
            const cookie = ck(argv as W);
            if (cookie) args.cookie = cookie;
            try {
              await cmdTodoFlag(tok(argv as W), args);
            } catch (e: unknown) {
              console.error(friendlySlackError(e));
              process.exit(1);
            }
          },
        )
        .command(
          "doctor",
          "Find messages carrying two or more progress reactions (--fix repairs them)",
          (y2) => y2
            .option("in", { type: "string", demandOption: true, describe: "Channel to scan (#chan)" })
            .option("fix", { type: "boolean", default: false, describe: "Repair findings (keeps the highest-priority state)" })
            .option("limit", { type: "number", default: DOCTOR_DEFAULT_LIMIT, describe: "Max messages to scan" })
            .option("channel-id", { type: "string", describe: "Raw channel ID" }),
          async (argv) => {
            const args: { channel: string; fix?: boolean; limit: number; channelId?: string; cookie?: string } = {
              channel: argv.in!,
              limit: argv.limit,
            };
            if (argv.fix) args.fix = true;
            if (argv["channel-id"]) args.channelId = argv["channel-id"];
            const cookie = ck(argv as W);
            if (cookie) args.cookie = cookie;
            await cmdTodoDoctor(tok(argv as W), args);
          },
        )
        .demandCommand(1, "Specify a todo subcommand (ls, set, flag, doctor)"),
      () => {},
    )
    .command(
      "mytodo",
      "Tasks carrying YOUR reactions (hasmy:) — the my-only half of `todo`",
      (y) => y
        .option("cache", { type: "boolean", default: true, describe: "Use ~/.config/slack-cli/cache.json for channel/user lookups (--no-cache to bypass)" })
        .middleware((argv) => { if (argv.cache === false) setCacheEnabled(false); })
        .command(
          ["ls", "list"],
          "List tasks you have reacted to (hasmy: — read-only, one search per run)",
          (y2) => y2.options(TODO_LS_OPTIONS),
          async (argv) => { await runTodoLs(argv as W & { state?: string }, true); },
        )
        // Only `ls` is split. set/flag/doctor act on one identified message, so
        // "mine vs everyone's" does not apply to them — they stay under `todo`.
        .demandCommand(1, "Specify a mytodo subcommand (ls)"),
      () => {},
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
      "lists <ref>",
      "Read a Slack List's rows (by list URL or F-id) — read-only",
      (y) => y
        .positional("ref", { type: "string", demandOption: true, describe: "List URL (…/lists/<TEAM>/<F-id>) or bare F-id" })
        .option("limit", { alias: "l", type: "number", default: 100, describe: "Max rows to show" })
        .option("format", { type: "string", choices: ["text", "jsonl"], default: "text" })
        .option("json", { type: "boolean", default: false, describe: "Alias for --format=jsonl (raw records)" }),
      async (argv) => {
        const format = argv.json ? "jsonl" : (argv.format as string);
        try {
          await cmdLists(tok(argv as W), ck(argv as W), argv.ref!, { limit: argv.limit as number, format });
        } catch (e: unknown) {
          console.error(friendlySlackError(e));
          process.exit(1);
        }
      },
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
            const self = await selfIdentity(token, cookie);
            const code = safetyCode(prevText, text, self?.userId ?? "");
            if (argv.code !== code) requireCode(argv.code, code, [
              `--- Editing draft as -------------------------`,
              fromLine(self),
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
            const self = await selfIdentity(token, cookie);
            const code = safetyCode(argv.id!, prevText, self?.userId ?? "");
            if (argv.code !== code) requireCode(argv.code, code, [
              `─-- Deleting draft ───────────────────────────`,
              fromLine(self),
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
