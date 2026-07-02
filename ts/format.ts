// Text-formatting helpers: mention/date-markup resolution, day grouping.

import { listConversationMembers, listUsers, userInfo, userName, type Json } from "./slack.ts";

/** Match an `@handle` token at a word boundary, capturing the handle.
 *  - The negative lookbehind keeps `@` inside emails (`a@b.com`) from matching,
 *    and the `<` keeps already-encoded mentions (`<@U0123>`) from being picked up
 *    as a handle named after the user ID (Slack resolves those natively).
 *  - Each `.` must be followed by more handle chars, so a trailing sentence dot
 *    (`thanks @alice.`) is left out of the capture. */
function mentionRe(): RegExp {
  return /(?<![A-Za-z0-9._@<-])@([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g;
}

/** Lowercase + strip hyphens/underscores/whitespace for loose handle matching. */
function normHandle(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

function asRecord(v: Json | undefined): Record<string, Json> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {};
}

/** True when a user record matches `@handle` by name / real_name / display_name / email. */
function userMatchesHandle(u: Record<string, Json>, handle: string): boolean {
  const nh = normHandle(handle);
  const profile = asRecord(u.profile);
  for (const v of [u.name, u.real_name, profile.display_name, profile.real_name]) {
    if (typeof v === "string" && v && normHandle(v) === nh) return true;
  }
  const email = typeof profile.email === "string" ? profile.email.toLowerCase() : "";
  return email !== "" && email === handle.toLowerCase();
}

/**
 * Rewrite `@handle` tokens in `text` to `<@USERID>` so Slack renders them as
 * real mentions. Resolution order per handle:
 *   1. workspace users.list (name / real_name / display_name / email)
 *   2. the target channel's members (conversations.members → users.info) — this
 *      reaches Slack Connect guests absent from the workspace users.list
 * Handles that resolve to nothing are left as plain text (never destroyed) and
 * reported via `warn`. Lookups are cached so each API call runs at most once.
 */
export async function encodeMentions(
  token: string,
  text: string,
  channelId: string | undefined,
  opts: { warn?: (msg: string) => void } = {},
): Promise<string> {
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  const handles = new Set<string>();
  for (const m of text.matchAll(mentionRe())) handles.add(m[1]!);
  if (handles.size === 0) return text;

  const resolved = new Map<string, string>(); // handle -> user ID

  // Step 1: workspace users.list (fetched once).
  const wsResp = (await listUsers(token)) as { members?: Json[] };
  const wsUsers = (wsResp.members ?? []).map(asRecord);
  const unresolved: string[] = [];
  for (const handle of handles) {
    const hit = wsUsers.find((u) => userMatchesHandle(u, handle));
    const id = hit && typeof hit.id === "string" ? hit.id : "";
    if (id) resolved.set(handle, id);
    else unresolved.push(handle);
  }

  // Step 2: channel members (fetched once) — covers external/Connect guests.
  if (unresolved.length > 0 && channelId) {
    const memberIds = await listConversationMembers(token, channelId);
    const infos: Record<string, Json>[] = [];
    for (const uid of memberIds) {
      const info = asRecord((await userInfo(token, uid)) as Json);
      const u = asRecord(info.user);
      if (typeof u.id !== "string") u.id = uid;
      infos.push(u);
    }
    for (const handle of unresolved) {
      const hit = infos.find((u) => userMatchesHandle(u, handle));
      const id = hit && typeof hit.id === "string" ? hit.id : "";
      if (id) resolved.set(handle, id);
    }
  }

  for (const handle of handles) {
    if (!resolved.has(handle)) warn(`warn: unresolved mention @${handle} (left as text)`);
  }

  return text.replace(mentionRe(), (full, handle: string) => {
    const id = resolved.get(handle);
    return id ? `<@${id}>` : full;
  });
}

export async function resolveMentions(
  token: string,
  text: string,
  cache: Map<string, string>,
): Promise<string> {
  let result = text;
  const ids: string[] = [];
  let search = result;
  let searchOffset = 0;
  while (true) {
    const pos = search.indexOf("<@U", searchOffset);
    if (pos === -1) break;
    const rest = search.slice(pos + 2);
    const endIdx = rest.search(/[>|]/);
    const uid = endIdx === -1 ? rest : rest.slice(0, endIdx);
    if (uid.length >= 9) ids.push(uid);
    searchOffset = pos + 1;
  }
  for (const uid of ids) {
    if (!cache.has(uid)) cache.set(uid, await userName(token, uid));
    const display = cache.get(uid) ?? uid;
    result = result.replaceAll(`<@${uid}>`, `@${display}`);
    // Handle <@UID|label> form — drop label.
    result = result.replace(new RegExp(`<@${uid}\\|[^>]*>`, "g"), `@${display}`);
  }
  return result;
}

export function resolveDateMarkup(text: string): string {
  // <!date^EPOCH^{format}|fallback>  →  formatted date (or fallback)
  return text.replace(/<!date\^(\d+)\^[^|>]*(?:\|([^>]*))?>/g, (_m, epochStr, fallback) => {
    const epoch = Number(epochStr);
    if (!Number.isFinite(epoch)) return fallback ?? "date";
    const d = new Date(epoch * 1000);
    if (Number.isNaN(d.getTime())) return fallback ?? "date";
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayName = days[d.getUTCDay()] ?? "";
    const mon = months[d.getUTCMonth()] ?? "";
    return `${dayName}, ${mon} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()}`;
  });
}

export function dayLabel(epochSec: number, now: Date = new Date()): string {
  const d = new Date(epochSec * 1000);
  const today = dateKey(now);
  const yesterday = dateKey(new Date(now.getTime() - 86400_000));
  const key = dateKey(d);
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const month = d.toLocaleDateString("en-US", { month: "short" });
  return `${weekday}, ${month} ${String(d.getDate()).padStart(2, "0")}`;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatHm(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatYmdHm(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi}`;
}
