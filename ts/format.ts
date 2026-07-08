// Text-formatting helpers: mention/date-markup resolution, day grouping.

import { listConversationMembers, listUsers, userInfo, userName, type Json } from "./slack.ts";

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

export type MentionResolution = { surface: string; display: string; userId: string };
export type UnresolvedMention = { surface: string; reason: "no-match" | "ambiguous" | "no-directory" };
/** Structured outcome of mention encoding, so callers (the send confirm gate)
 *  can preview exactly who will — and won't — be notified. */
export type MentionEncodeResult = {
  text: string;
  resolved: MentionResolution[];
  unresolved: UnresolvedMention[];
};

/** Full normalized name-forms of a member — the WHOLE display_name / real_name /
 *  name, never split into parts. An explicit `@name` mention must match a full
 *  name (`@柏原大空`), never a bare surname fragment (`@柏原`), which would be
 *  ambiguous. Length ≥ 2. */
function fullNameForms(u: Record<string, Json>): string[] {
  const profile = asRecord(u.profile);
  const forms = new Set<string>();
  for (const v of [profile.display_name, u.real_name, u.name, profile.real_name]) {
    if (typeof v === "string" && v) {
      const n = normHandle(v);
      if (n.length >= 2) forms.add(n);
    }
  }
  return [...forms];
}

type CjkMatch = { userId: string; matchLen: number; display: string } | "ambiguous" | undefined;

/** Directory longest-prefix match for a CJK `@名前` run. `run` is the raw text
 *  after `@` (e.g. "柏原大空さん"); the longest member full-name that is a prefix
 *  of it wins, so a trailing honorific / particle ("さん", "は") is left in the
 *  message text rather than swallowed into the tag. Because the run is drawn from
 *  a space/punctuation-free character class, normalized length == raw length, so
 *  `matchLen` (a normalized-form length) also indexes the raw run. Returns
 *  "ambiguous" when two distinct users tie on the longest match. */
function matchCjkRun(run: string, dir: Record<string, Json>[]): CjkMatch {
  const nr = normHandle(run);
  let best: { userId: string; matchLen: number; display: string } | undefined;
  let ambiguous = false;
  for (const u of dir) {
    const id = typeof u.id === "string" ? u.id : "";
    if (!id) continue;
    for (const form of fullNameForms(u)) {
      if (!nr.startsWith(form)) continue;
      // A prefix shorter than the whole run only counts when what immediately
      // follows is a CURATED particle or honorific — NOT any hiragana. Accepting
      // arbitrary hiragana would still mis-tag a hiragana given name: "@山田たろう"
      // would let a member named just "山田" match on the leading "た". So we
      // resolve only on an exact full-name match, or a prefix followed by a known
      // particle ("@柏原大空は") / honorific ("@山田さん", "@田中様"); anything else
      // (more kanji/katakana, or a hiragana given name) stays literal.
      const rest = nr.slice(form.length);
      if (rest.length > 0 && !CJK_MENTION_CONTINUATIONS.some((s) => rest.startsWith(s))) continue;
      if (!best || form.length > best.matchLen) {
        best = { userId: id, matchLen: form.length, display: displayNameOf(u) };
        ambiguous = false;
      } else if (form.length === best.matchLen && best.userId !== id) {
        ambiguous = true;
      }
    }
  }
  if (!best) return undefined;
  return ambiguous ? "ambiguous" : best;
}

/**
 * Rewrite `@handle` / `@名前` tokens in `text` to `<@USERID>` so Slack renders
 * them as real mentions, returning a structured report of what did and did not
 * resolve. Two kinds of token are recognized:
 *   - ASCII handles (`@alice`, `@t.matsuda19790127`) — matched whole against
 *     name / real_name / display_name / email.
 *   - CJK names (`@柏原大空`, `@柏原大空さん`) — matched by directory longest-prefix
 *     so a display name written in kanji/kana (which the old ASCII-only regex
 *     could not even capture) resolves, with any trailing honorific left intact.
 * Resolution order: (1) workspace users.list, then (2) the target channel's
 * members (reaches Slack Connect guests absent from users.list). users.list is
 * fail-soft: a token lacking `users:read` yields a "no-directory" report entry
 * instead of aborting the send. Unresolved tokens are never destroyed.
 */
export async function encodeMentionsDetailed(
  token: string,
  text: string,
  channelId: string | undefined,
  cookie?: string,
): Promise<MentionEncodeResult> {
  const ASCII = "[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*";
  const CJK = `[${NAME_CHARS}ー]+`;
  // Lookbehind guard matches the old mentionRe(): skip emails (`a@b`), already-
  // encoded `<@U…>`, and doubled `@@`. ASCII alternative is tried first so a pure
  // ASCII handle keeps its exact old behavior; the CJK run only fires when ASCII
  // cannot start (the char after `@` is a Han/Hiragana/Katakana glyph).
  const tokenRe = new RegExp(`(?<![A-Za-z0-9._@<-])@(${ASCII}|${CJK})`, "gu");

  const tokens = new Set<string>();
  for (const m of text.matchAll(tokenRe)) tokens.add(m[1]!);
  if (tokens.size === 0) return { text, resolved: [], unresolved: [] };

  type R =
    | { status: "resolved"; userId: string; matchLen: number; display: string }
    | { status: "ambiguous" }
    | { status: "pending" };
  const res = new Map<string, R>();
  for (const t of tokens) res.set(t, { status: "pending" });

  const resolveAgainst = (dir: Record<string, Json>[]): void => {
    for (const t of tokens) {
      if (res.get(t)!.status !== "pending") continue;
      if (isCjk(t)) {
        const m = matchCjkRun(t, dir);
        if (m === "ambiguous") res.set(t, { status: "ambiguous" });
        else if (m) res.set(t, { status: "resolved", userId: m.userId, matchLen: m.matchLen, display: m.display });
      } else {
        const hit = dir.find((u) => userMatchesHandle(u, t));
        const id = hit && typeof hit.id === "string" ? hit.id : "";
        if (id) res.set(t, { status: "resolved", userId: id, matchLen: t.length, display: displayNameOf(hit!) });
      }
    }
  };

  // Step 1: workspace users.list (fail-soft — a token without users:read must
  // not abort the send; mentions stay literal and are reported as no-directory).
  let directoryUnavailable = false;
  try {
    const wsResp = (await listUsers(token, cookie)) as { members?: Json[] };
    resolveAgainst((wsResp.members ?? []).map(asRecord));
  } catch {
    directoryUnavailable = true;
  }

  // Step 2: channel members (fetched once) — covers external/Connect guests.
  const stillPending = [...tokens].some((t) => res.get(t)!.status === "pending");
  if (stillPending && channelId) {
    try {
      const memberIds = await listConversationMembers(token, channelId, cookie);
      const infos: Record<string, Json>[] = [];
      for (const uid of memberIds) {
        const info = asRecord((await userInfo(token, uid, cookie)) as Json);
        const u = asRecord(info.user);
        if (typeof u.id !== "string") u.id = uid;
        infos.push(u);
      }
      resolveAgainst(infos);
    } catch {
      // best-effort; a preview degrading is fine, aborting a send is not.
    }
  }

  const resolved: MentionResolution[] = [];
  const unresolved: UnresolvedMention[] = [];
  for (const t of tokens) {
    const r = res.get(t)!;
    if (r.status === "resolved") {
      resolved.push({ surface: `@${t.slice(0, r.matchLen)}`, display: r.display, userId: r.userId });
    } else if (r.status === "ambiguous") {
      unresolved.push({ surface: `@${t}`, reason: "ambiguous" });
    } else {
      unresolved.push({ surface: `@${t}`, reason: directoryUnavailable ? "no-directory" : "no-match" });
    }
  }

  const out = text.replace(tokenRe, (full, tk: string) => {
    const r = res.get(tk);
    // For a CJK match, keep the un-matched tail (honorific/particle) as text.
    if (r && r.status === "resolved") return `<@${r.userId}>${tk.slice(r.matchLen)}`;
    return full;
  });

  return { text: out, resolved, unresolved };
}

/** String-returning wrapper over {@link encodeMentionsDetailed}: rewrites tokens
 *  and emits a `warn` line per token that stayed literal. Preserved for callers
 *  (and tests) that only need the encoded text. */
export async function encodeMentions(
  token: string,
  text: string,
  channelId: string | undefined,
  opts: { warn?: (msg: string) => void; cookie?: string } = {},
): Promise<string> {
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const rep = await encodeMentionsDetailed(token, text, channelId, opts.cookie);
  let saidNoDir = false;
  for (const u of rep.unresolved) {
    if (u.reason === "ambiguous") {
      warn(`warn: ambiguous mention ${u.surface} matches multiple users (left as text)`);
    } else if (u.reason === "no-directory") {
      if (!saidNoDir) {
        warn(`warn: cannot resolve @mentions — users.list unavailable (token needs users:read); left as text`);
        saidNoDir = true;
      }
    } else {
      warn(`warn: unresolved mention ${u.surface} (left as text)`);
    }
  }
  return rep.text;
}

// --- untagged-mention lint (warn-only) -------------------------------------
// Flags names written as plain text that map to a known workspace member but
// carry no <@USERID> tag in the same message — the footgun where "松田さん"
// reads fine to a human but never actually notifies 松田. Never blocks a send.

// Person-reference cues. Honorific *suffixes* follow a name (JP + ZH); greeting
// *prefixes* precede one (EN, handled by regex below). Extend freely.
const HONORIFIC_SUFFIXES = [
  "さん", "さま", "様", "君", "くん", "ちゃん", "氏", "先生", "先輩", "殿",  // JP
  "老师", "老師", "兄", "姐", "哥", "姐妹",                                  // ZH
];

// Particles that idiomatically follow a name right after an `@mention`. Together
// with HONORIFIC_SUFFIXES these are the ONLY continuations that let a shorter
// full-name prefix match in matchCjkRun — deliberately a curated set, not "any
// hiragana", so a hiragana given name ("@山田たろう") can never let a surname-only
// member "山田" mis-match. (Given names starting with a bare particle like の are
// a rare residual we accept.)
const CJK_MENTION_CONTINUATIONS = [
  ...HONORIFIC_SUFFIXES,
  "から", "まで", "は", "が", "を", "に", "へ", "と", "も", "で", "や", "の",
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
  // over-captured "ください松田" still reports "松田", not the whole run).
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
export async function findUntaggedMentions(token: string, text: string, cookie?: string): Promise<UntaggedMention[]> {
  const refs = extractPersonRefs(text);
  if (refs.length === 0) return [];

  const taggedIds = new Set<string>();
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) taggedIds.add(m[1]!);

  const wsResp = (await listUsers(token, cookie)) as { members?: Json[] };
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
