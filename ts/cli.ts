#!/usr/bin/env bun
// Slack CLI entry — mirrors the Rust impl in src/main.rs.

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  history,
  listConversations,
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

function loadEnv(): string {
  loadDotenv(join(homedir(), ".config/slack-cli/.env.local"));
  loadDotenv(join(process.cwd(), ".env.local"));
  loadDotenv(join(process.cwd(), ".env"));
  const token = process.env.SLACK_MCP_XOXP_TOKEN;
  if (!token) throw new Error("Missing SLACK_MCP_XOXP_TOKEN env var");
  return token;
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

// --- send ---
interface SendArgs {
  target: string;
  message: string;
  thread?: string;
  confirm?: string;
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

  const ctx = (await history(token, channelId, 5)) as Record<string, Json>;
  const ctxMsgs = asArray(ctx.messages)
    .map(asRecord)
    .filter((m) => m.subtype === undefined || m.subtype === null)
    .slice(0, 5);
  const stable = ctxMsgs
    .map((m) => `${typeof m.ts === "string" ? m.ts : ""}:${typeof m.text === "string" ? m.text : ""}`)
    .join("\n");
  const hash = sha256Hex(stable + args.message).slice(0, 4);

  if (args.confirm === undefined) {
    if (process.stderr.isTTY) {
      console.log("─── Recent context ──────────────────────────");
      for (const m of ctxMsgs) {
        const user = typeof m.user === "string" ? m.user : "?";
        const line = (typeof m.text === "string" ? m.text : "").split("\n")[0] ?? "";
        console.log(`  ${user}: ${line}`);
      }
      console.log("─── Message preview ─────────────────────────");
      console.log(
        `  To:      ${args.target}${args.thread ? ` (thread ${args.thread})` : ""}`,
      );
      console.log(`  Message: ${args.message}`);
      console.log("─────────────────────────────────────────────");
    }
    console.error(`Rerun with --confirm=${hash}`);
    process.exit(1);
  }
  if (args.confirm !== hash) {
    console.error(`Confirm hash mismatch. Expected: ${hash}`);
    process.exit(1);
  }
  const ts = await slackSend(token, channelId, args.message, args.thread);
  console.log(`✓ Sent (ts: ${ts})`);
}

// --- dispatch ---
function usage(): never {
  console.error(
    [
      "Usage: slack <command> [args]",
      "Commands:",
      "  msgs [<#channel|@user|url>] [-n|--limit N]",
      "  thread <#channel|@user|url> <ts> [-n|--limit N]",
      "  news [-l|--limit N]",
      "  search <query> [-n|--count N]",
      "  send <target> <message> [--thread TS] [--confirm HASH] [--channel-id ID] [--user-id ID]",
      "  dump [-d|--days N] [-l|--limit N] [-f|--filter STR]",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const token = loadEnv();
  const [, , cmd, ...rest] = process.argv;
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
          confirm: { type: "string" },
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
      if (values.confirm !== undefined) sendArgs.confirm = values.confirm;
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
