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

// --- untagged-mention lint (warn-only) -------------------------------------
// Flags names written as plain text that map to a known workspace member but
// carry no <@USERID> tag in the same message — the footgun where "山田さん"
// reads fine to a human but never actually notifies 山田. Never blocks a send.

// Person-reference cues. Honorific *suffixes* follow a name (JP + ZH); greeting
// *prefixes* precede one (EN, handled by regex below). Extend freely.
const HONORIFIC_SUFFIXES = [
  "さん", "さま", "様", "君", "くん", "ちゃん", "氏", "先生", "先輩", "殿",  // JP
  "老师", "老師", "兄", "姐", "哥", "姐妹",                                  // ZH
];

const NAME_CHARS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}A-Za-z0-9";

function isCjk(s: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s);
}

type PersonRef = { ref: string; honorific: string };

/** Extract candidate person-references from plain text. CJK matches by honorific
 *  suffix; EN by "Dear/Hi/Hello/Hey <Name>" and a leading "<Name>," salutation.
 *  Over-capture on the CJK side is harmless: a ref matching no member is dropped,
 *  and the warning's surface is rebuilt from the matched member name. */
function extractPersonRefs(text: string): PersonRef[] {
  const refs: PersonRef[] = [];
  const honRe = new RegExp(`([${NAME_CHARS}]{1,12})(${HONORIFIC_SUFFIXES.join("|")})`, "gu");
  for (const m of text.matchAll(honRe)) refs.push({ ref: m[1]!, honorific: m[2]! });
  for (const m of text.matchAll(/\b(?:dear|hi|hello|hey)\b[ \t]+([A-Z][A-Za-z'’-]{1,20})/gi)) {
    refs.push({ ref: m[1]!, honorific: "" });
  }
  for (const m of text.matchAll(/(?:^|\n)[ \t]*([A-Z][A-Za-z'’-]{1,20}),/g)) {
    refs.push({ ref: m[1]!, honorific: "" });
  }
  return refs;
}

/** Normalized name forms of a member (name / real_name / display_name plus their
 *  whitespace-split parts), lowercased+stripped, length ≥ 2. */
function nameFormsOf(u: Record<string, Json>): string[] {
  const profile = asRecord(u.profile);
  const forms = new Set<string>();
  for (const v of [u.name, u.real_name, profile.display_name, profile.real_name]) {
    if (typeof v !== "string" || !v) continue;
    for (const piece of [v, ...v.split(/\s+/)]) {
      const n = normHandle(piece);
      if (n.length >= 2) forms.add(n);
    }
  }
  return [...forms];
}

/** The member name-form that a ref matches, or undefined. CJK allows substring
 *  either direction (tolerates over-capture / compound names); Latin requires an
 *  exact form match to avoid "Ai" ⊂ "Aiden" style false positives. */
function matchMemberForm(ref: string, forms: string[]): string | undefined {
  const nr = normHandle(ref);
  if (nr.length < 2) return undefined;
  // Exact first so the surface rebuilds to the tightest name (e.g. an
  // over-captured "ください山田" still reports "山田", not the whole run).
  for (const f of forms) if (nr === f) return f;
  if (isCjk(ref)) {
    for (const f of forms) if (nr.includes(f) || f.includes(nr)) return f;
  }
  return undefined;
}

function displayNameOf(u: Record<string, Json>): string {
  const profile = asRecord(u.profile);
  const names = [profile.display_name, u.real_name, u.name].filter(
    (v): v is string => typeof v === "string" && v !== "",
  );
  return names[0] ?? String(u.id ?? "?");
}

export type UntaggedMention = { surface: string; display: string; userId: string };

/** Warn-only lint: person-references in `text` that resolve to a workspace
 *  member but carry no <@USERID> tag. Returns [] cheaply (no users.list fetch)
 *  when the text has no person-reference cue. */
export async function findUntaggedMentions(token: string, text: string): Promise<UntaggedMention[]> {
  const refs = extractPersonRefs(text);
  if (refs.length === 0) return [];

  const taggedIds = new Set<string>();
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) taggedIds.add(m[1]!);

  const wsResp = (await listUsers(token)) as { members?: Json[] };
  const pool = (wsResp.members ?? [])
    .map(asRecord)
    .filter((u) => u.deleted !== true && u.is_bot !== true && u.id !== "USLACKBOT")
    .map((u) => ({ id: typeof u.id === "string" ? u.id : "", forms: nameFormsOf(u), display: displayNameOf(u) }))
    .filter((p) => p.id !== "");

  const out: UntaggedMention[] = [];
  const seen = new Set<string>();
  for (const { ref, honorific } of refs) {
    for (const p of pool) {
      const form = matchMemberForm(ref, p.forms);
      if (!form) continue;
      if (taggedIds.has(p.id) || seen.has(p.id)) break;
      seen.add(p.id);
      out.push({ surface: isCjk(ref) ? `${form}${honorific}` : ref, display: p.display, userId: p.id });
      break;
    }
  }
  return out;
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
