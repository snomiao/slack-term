// The `ask` message format — builder and parser in one place, on purpose.
//
// `ask` keeps no local record of a question, so `--waitFor` recovers everything
// it needs by reading the posted message back. That makes this body a wire
// format: `askParseMessage` must be the exact inverse of `askBuildText`, and the
// round-trip test in tests/ask-format.test.ts is what holds the two together.
// Answer order. Ten is the ceiling because keycap emoji stop there; choice 11+
// is listed in the body but can only be answered with text.
export const ASK_KEYCAPS = [
  { name: "one", glyph: "1️⃣" },
  { name: "two", glyph: "2️⃣" },
  { name: "three", glyph: "3️⃣" },
  { name: "four", glyph: "4️⃣" },
  { name: "five", glyph: "5️⃣" },
  { name: "six", glyph: "6️⃣" },
  { name: "seven", glyph: "7️⃣" },
  { name: "eight", glyph: "8️⃣" },
  { name: "nine", glyph: "9️⃣" },
  { name: "keycap_ten", glyph: "🔟" },
] as const;
export const ASK_MAX_REACTION_CHOICES = ASK_KEYCAPS.length;

export type AskFound = { answer: string; how: string; who?: string };

/** The marker that says "this message is an `ask`". A shortcode, so it is the
 *  SAME token in every language — that is the whole point of it.
 *
 *  Identity used to live in the trailing Japanese instruction line, which made
 *  the format untranslatable: rewording it in any language would have made every
 *  in-flight question unparseable. The marker carries identity now, and the
 *  instruction is free to be translated.
 *
 *  It is also seeded as a REACTION, which is what makes `has:question` list
 *  every question the way `has:pushpin` lists every todo. `todo` gave this
 *  emoji up (its needs-discussion flag moved to :thinking_face:) precisely so
 *  the two would not collide in search. */
export const ASK_MARKER = "question";
export const ASK_MARKER_PREFIX = `:${ASK_MARKER}: `;

// The copy a reader sees, per language. Japanese is the default and its
// strings are a WIRE FORMAT: questions already in flight were posted with them
// and are recognised by them, so they must never be reworded. Adding a language
// is safe — the parser accepts every language's instruction lines — but once a
// language has shipped, its instruction and overflow lines are frozen the same
// way. Everything else here (the other line, the answered stamp) is matched by
// prefix or not at all, and is free to change.
export const ASK_LANGS = ["ja", "en"] as const;
export type AskLang = (typeof ASK_LANGS)[number];

/** Where the language came from — shown on the confirm gate, so a surprising
 *  choice can be traced and overridden before anything is posted. */
export type AskLangSource = "flag" | "env" | "readers" | "content" | "system" | "default";

/** Pick the language the body's own copy is written in. In order:
 *
 *  1. `--lang`, else `SLACK_TERM_LANG` — explicit. A value naming no supported
 *     language is an error (null): a typo must not quietly post in the wrong one.
 *  2. The READERS' Slack locale (`users.info?include_locale`) — the people the
 *     question is addressed to, who are the ones who have to read the copy.
 *     Slack exposes no workspace-wide language to an ordinary token, but it does
 *     expose each person's. Used only when every reader maps to the SAME
 *     supported language: a mixed group has no single right answer, and an
 *     `@here` audience is not a known set of people (the caller passes none).
 *  3. The CONTENT — what the asker wrote (question, body, choices). Instructions
 *     in a different language from the question they sit under read as noise.
 *  4. The system locale (`LC_ALL` → `LC_MESSAGES` → `LANG`), for content with no
 *     letters at all (emoji, numbers).
 *  5. `ja`, the copy `ask` has always posted — so a machine nobody configured,
 *     asking someone whose locale cannot be read, keeps doing what it did. */
export function askResolveLang(
  opts: { flag?: string | undefined; readerLocales?: (string | undefined)[]; content?: string[] },
  env: NodeJS.ProcessEnv = process.env,
): { lang: AskLang; source: AskLangSource } | null {
  for (const [raw, source] of [[opts.flag, "flag"], [env.SLACK_TERM_LANG, "env"]] as const) {
    if (raw === undefined || raw.trim() === "") continue;
    const v = raw.trim().toLowerCase();
    return (ASK_LANGS as readonly string[]).includes(v) ? { lang: v as AskLang, source } : null;
  }
  const readers = (opts.readerLocales ?? []).map(askLangOfLocale);
  if (readers.length && readers[0] && readers.every((l) => l === readers[0])) return { lang: readers[0], source: "readers" };
  const fromContent = askDetectLang((opts.content ?? []).join("\n"));
  if (fromContent) return { lang: fromContent, source: "content" };
  const sys = askLangOfLocale(env.LC_ALL || env.LC_MESSAGES || env.LANG);
  if (sys) return { lang: sys, source: "system" };
  return { lang: "ja", source: "default" };
}

/** `ja-JP` (Slack), `ja_JP.UTF-8` (POSIX), `en` → the language we have copy
 *  for, or null (C/POSIX, unset, or a language not listed). */
export function askLangOfLocale(locale: string | undefined): AskLang | null {
  const v = (locale ?? "").toLowerCase();
  return ASK_LANGS.find((l) => v === l || /^[_.\-@]/.test(v.slice(l.length)) && v.startsWith(l)) ?? null;
}

/** The language `text` is written in, or null when it has no letters to tell
 *  by. Two languages only, so a script check is exact enough: kana or kanji
 *  means Japanese (kanji alone could be Chinese, but `ja` is the nearest copy
 *  we have), and Latin letters with neither mean English. */
export function askDetectLang(text: string): AskLang | null {
  const words = text
    .replace(/<[^>\s]*>/g, " ") // <@U…>, <#C…|name>, <!here>, <https://…|label>
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/:[a-z0-9_+-]+:/g, " "); // :shortcode: emoji
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(words)) return "ja";
  if (/\p{Script=Latin}/u.test(words)) return "en";
  return null;
}

interface AskCopy {
  instructionReactionThread: string;
  instructionReactionHere: string;
  instructionTextThread: string;
  instructionTextHere: string;
  overflowNote: string;
  otherThread: string;
  otherHere: string;
  invalidPrefix: string;
  answeredVia: (how: string, who: string) => string;
  howReaction: (glyph: string) => string;
  howReply: string;
  howReplyN: (n: number) => string;
}

/** The standing "none of these" choice (`otherThread` / `otherHere`), listed
 *  after the numbered ones. It is the ❓ marker pill, which is seeded LAST so
 *  the reaction row reads the same as the body: 1️⃣ 2️⃣ 3️⃣ ❓. People already
 *  pressed ❓ to mean "none of these fit" — the line makes that an explicit
 *  choice, and says where the actual answer has to go: ❓ itself carries no
 *  answer text, so it never resolves the question; the reply that follows it
 *  does (exit 5, delivered as free text). Optional on the way in: questions
 *  posted before it existed have no such line and must stay collectable.
 *
 *  The invalid-ballot prefix is shared with `poll`, which posts it in Japanese. */
export const ASK_COPY: Record<AskLang, AskCopy> = {
  ja: {
    instructionReactionThread:
      "_下のリアクションを 1 つ押すと回答になります。当てはまるものがなければ、このメッセージの *スレッド* で返信してください (チャンネルへの通常投稿は回答として拾いません)。_",
    instructionReactionHere:
      "_下のリアクションを 1 つ押すと回答になります。当てはまるものがなければ、このメッセージに返信してください。_",
    instructionTextThread:
      "_このメッセージの *スレッド* で返信してください。本文がそのまま回答になります (チャンネルへの通常投稿は回答として拾いません)。_",
    instructionTextHere: "_このメッセージに返信してください。本文がそのまま回答になります。_",
    overflowNote: "_11 番目以降はリアクションがないので、返信で答えてください。_",
    otherThread: `${ASK_MARKER_PREFIX}その他 — スレッドで返信してください`,
    otherHere: `${ASK_MARKER_PREFIX}その他 — このメッセージに返信してください`,
    invalidPrefix: "_:warning: 同時に複数選ばれているため回答として数えていません — どれか 1 つだけ残してください: ",
    answeredVia: (how, who) => `_${how}で回答済み${who ? ` (${who})` : ""}_`,
    howReaction: (glyph) => `リアクション ${glyph}`,
    howReply: "返信",
    howReplyN: (n) => `返信 (${n})`,
  },
  en: {
    instructionReactionThread:
      "_Press one of the reactions below to answer. If none fits, reply in this message's *thread* (ordinary channel posts are not picked up as answers)._",
    instructionReactionHere:
      "_Press one of the reactions below to answer. If none fits, reply to this message._",
    instructionTextThread:
      "_Reply in this message's *thread* — your reply is the answer (ordinary channel posts are not picked up as answers)._",
    instructionTextHere: "_Reply to this message — your reply is the answer._",
    overflowNote: "_Choices 11 and up have no reaction — answer them with a reply._",
    otherThread: `${ASK_MARKER_PREFIX}Other — reply in the thread`,
    otherHere: `${ASK_MARKER_PREFIX}Other — reply to this message`,
    invalidPrefix: "_:warning: Several choices are selected, so this is not counted as an answer — keep only one: ",
    answeredVia: (how, who) => `_Answered by ${how}${who ? ` (${who})` : ""}_`,
    howReaction: (glyph) => `reaction ${glyph}`,
    howReply: "reply",
    howReplyN: (n) => `reply (${n})`,
  },
};

/** True for the "other" line in either spelling — the shortcode we write, or the
 *  glyph a body hand-edited in the Slack UI can carry. Matched by prefix, not
 *  verbatim, so the copy stays free to change. */
function askIsOtherLine(line: string | undefined): boolean {
  return line !== undefined && (line.startsWith(ASK_MARKER_PREFIX) || line.startsWith("❓ "));
}

// The invalid-ballot notice, shared by `ask` and `poll` and written INTO the
// message rather than only onto the collector's terminal. The person who has to
// fix it is the voter, and the voter is in Slack — a warning that only the
// collector sees never reaches them.
//
// A line in the body, not a thread reply, and that is the whole point: it is
// rewritten from the CURRENT state on every collection pass, so it cannot
// duplicate across reruns and it disappears by itself the moment the extra
// reaction is taken back. A reply, once posted, is a permanent record of a
// situation that has since been fixed.
const INVALID_SUFFIX = "_";

function invalidLang(line: string | undefined): AskLang | null {
  if (line === undefined || !line.endsWith(INVALID_SUFFIX)) return null;
  return ASK_LANGS.find((l) => line.startsWith(ASK_COPY[l].invalidPrefix)) ?? null;
}

/** The IDs named by a message's invalid-ballot line, or [] if it has none. */
export function readInvalidNotice(text: string): string[] {
  const lines = text.split("\n");
  const line = lines[lines.length - 2];
  if (!invalidLang(line)) return [];
  return [...line!.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]!);
}

/** Put `invalid` into the body — inserting, replacing or REMOVING the notice so
 *  the result depends only on the current state, never on how many times this
 *  has run. Returns the text unchanged when nothing needs to move, which is the
 *  caller's signal to skip the edit entirely.
 *
 *  The notice sits directly above the instruction line because that line has to
 *  stay last: it is what identifies the message as an `ask`/`poll` at all. */
export function applyInvalidNotice(text: string, invalid: string[], lang: AskLang = "ja"): string {
  const lines = text.split("\n");
  if (lines.length < 2) return text;
  if (readInvalidNotice(text).length) lines.splice(lines.length - 2, 1);
  if (invalid.length) {
    lines.splice(lines.length - 1, 0, `${ASK_COPY[lang].invalidPrefix}${invalid.map((u) => `<@${u}>`).join(", ")}${INVALID_SUFFIX}`);
  }
  const out = lines.join("\n");
  return out === text ? text : out;
}

/** True if this line is the notice — parsers skip it when walking up. */
export function isInvalidNotice(line: string | undefined): boolean {
  return invalidLang(line) !== null;
}

/** Prefix `markResolved` stamps on a settled question. `--waitFor` keys "this
 *  was already answered while nobody was watching" off it, which is the whole
 *  reason a fire-and-forget ask can be collected later at all. */
export const ASK_RESOLVED_MARKER = "white_check_mark";
export const ASK_RESOLVED_PREFIX = `:${ASK_RESOLVED_MARKER}: `;

/** How a keycap is WRITTEN into the body, and how it is read back.
 *
 *  Slack NORMALISES a unicode keycap in the stored `text`: post `1️⃣` and
 *  `conversations.history` returns `:one:`. So a body built with glyphs never
 *  reads back as what was sent, and `--waitFor` cannot recognise its own
 *  question. `poll` already handled this; `ask` did not, which made every
 *  pill-answered question uncollectable (reported from real use 2026-08-31:
 *  four questions answered, nothing collected for ~20 minutes).
 *
 *  Both spellings are accepted on the way in: the shortcode is what Slack
 *  stores, and the glyph is what a body hand-edited in the Slack UI can be. */
/** How a keycap is WRITTEN into the body: the shortcode, because that is the
 *  form Slack stores and therefore the form that reads back unchanged. */
function askPill(i: number): string {
  return `:${ASK_KEYCAPS[i]!.name}:`;
}

function askStripPill(line: string, i: number): string | null {
  const k = ASK_KEYCAPS[i]!;
  for (const pre of [askPill(i), k.glyph]) {
    if (line.startsWith(`${pre} `)) return line.slice(pre.length + 1);
    if (line === pre) return "";
  }
  return null;
}

/** True if the line opens with ANY keycap — used only to find where the choice
 *  block starts; WHICH keycap it is gets checked afterwards, in order. */
function askIsPillLine(line: string): boolean {
  return ASK_KEYCAPS.some((_k, i) => askStripPill(line, i) !== null);
}

/** One line, always: newlines inside a choice would break the line-based body. */
export function askFlatten(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}

/** Question body: the prompt, the numbered choices matching the seeded pills,
 *  and an instruction naming the answer paths this command actually reads.
 *  `askParseMessage` is its inverse — keep the two in step. */
export function askBuildText(question: string, body: string, reactable: string[], overflow: string[], threadOnly: boolean, lang: AskLang = "ja"): string {
  const c = ASK_COPY[lang];
  const lines: string[] = [`${ASK_MARKER_PREFIX}*${question}*`];
  if (body) lines.push("", body);
  if (reactable.length) {
    lines.push("");
    // Flattened: a choice is a pill label, and a newline in one would split it
    // into a line the parser cannot tell from body text.
    // Built with the SHORTCODE, matching what Slack stores. Building with the
    // glyph worked only because the parser now accepts both — the body still
    // came back as `:one:` and never matched what was sent. Writing the stored
    // form keeps posted and read-back bytes identical, which is what the
    // round-trip test can actually check. (`poll` already did this.)
    lines.push(...reactable.map((s, i) => `${askPill(i)} ${askFlatten(s)}`));
    // Directly under the pills, matching the ❓ seeded right after them.
    lines.push(threadOnly ? c.otherThread : c.otherHere);
    if (overflow.length) {
      lines.push("");
      lines.push(...overflow.map((s, i) => `(${i + 11}) ${askFlatten(s)}`));
      lines.push(c.overflowNote);
    }
    lines.push("");
    // The instruction must name the exact path the poller reads. Where only
    // thread replies are picked up, telling people to "reply to this message"
    // would get in-channel answers silently ignored.
    lines.push(threadOnly ? c.instructionReactionThread : c.instructionReactionHere);
  } else {
    lines.push("");
    lines.push(threadOnly ? c.instructionTextThread : c.instructionTextHere);
  }
  return lines.join("\n");
}

/** Resolved-question body. Every answer line is quoted, not just the first —
 *  a multi-line reply left unquoted after the first line cannot be told back
 *  apart from the surrounding text when `--waitFor` reads it. */
export function askBuildResolvedText(question: string, found: AskFound, who: string, lang: AskLang = "ja"): string {
  const quoted = found.answer.split("\n").map((l) => `> ${l}`).join("\n");
  return `${ASK_RESOLVED_PREFIX}*${question}*\n${ASK_COPY[lang].answeredVia(found.how, who)}\n\n${quoted}`;
}

/** Undo Slack's storage escaping. Only these three are ever escaped, and `&amp;`
 *  goes LAST so an answer that literally contains `&lt;` is not decoded twice. */
function askDecodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export type AskParsed =
  | { kind: "open"; question: string; reactable: string[]; overflow: string[]; threadOnly: boolean; lang: AskLang }
  | { kind: "resolved"; question: string; answer: string }
  | { kind: "other" };

/** Read an `ask` message back out of Slack. The inverse of `askBuildText` /
 *  `askBuildResolvedText`, and the reason `--waitFor` needs nothing on disk.
 *
 *  "Is this even a question?" is decided by the trailing instruction line, not
 *  by a loose heuristic: it is the one part of the body this command wrote
 *  verbatim, so matching it exactly is what keeps an unrelated message from
 *  being polled as if it were an ask. */
/** Why `askParseMessage` rejected a body, in the reader's terms.
 *
 *  The single generic "this is not an ask" line sent a real user re-checking
 *  permalinks that were fine, and cost ~20 minutes while pressed answers went
 *  uncollected (2026-08-31). A rejection has to say WHICH check failed, because
 *  the three causes have completely different fixes: wrong link, a body someone
 *  edited, or a bug here. */
export function askExplainReject(text: string): string {
  if (!text.trim()) return "本文が空です (bot 投稿や添付のみのメッセージかもしれません)";
  const lines = text.split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (text.startsWith(ASK_RESOLVED_PREFIX)) {
    return "回答済みマーク付きですが、引用された回答本文が見つかりません";
  }
  if (!/_$/.test(last)) {
    return "末尾が `ask` の案内文ではありません — このメッセージは `slack ask` で投稿されたものではないか、本文が編集されています";
  }
  if (!lines[0]!.startsWith(ASK_MARKER_PREFIX) && !lines[0]!.startsWith("*")) {
    return "先頭が質問文 (太字) ではありません — 本文が編集されている可能性があります";
  }
  return "選択肢の並びを読み取れません — 番号が 1 から連番になっていないか、本文が編集されています";
}

export function askParseMessage(text: string): AskParsed {
  const lines = text.split("\n");

  // Resolved is checked FIRST: a settled question carries the ✅ prefix where an
  // open one carries the ❓ marker, and reading a resolved body as an open one
  // would re-poll a question that already has its answer.
  if (text.startsWith(ASK_RESOLVED_PREFIX)) {
    const head = lines[0]!.slice(ASK_RESOLVED_PREFIX.length);
    const question = askDecodeEntities(head.replace(/^\*/, "").replace(/\*$/, ""));
    // `&gt; `, not only `> `: Slack HTML-escapes `&`, `<` and `>` in the text it
    // hands back, so the quote we wrote as `> ` is STORED as `&gt; `. Matching
    // only the raw form made every collected question unreadable — re-running
    // `--waitFor` on one exited 3 (measured 2026-09-27: 40 of 71 asks).
    const answer = lines
      .map((l) => (l.startsWith("> ") ? l.slice(2) : l.startsWith("&gt; ") ? l.slice(5) : null))
      .filter((l): l is string => l !== null)
      .map(askDecodeEntities)
      .join("\n");
    // A ✅-stamped body with no quoted answer is not a settled question we can
    // report; treat it as unknown rather than answer with an empty string.
    if (!answer) return { kind: "other" };
    return { kind: "resolved", question, answer };
  }

  const last = lines[lines.length - 1] ?? "";
  let threadOnly: boolean;
  let hasChoices: boolean;
  // Old-format fallback. A question posted before the marker existed is
  // identified the only way it can be: by the instruction line it was built
  // with. Never delete these cases — they are what keeps those questions
  // collectable.
  // Every language's lines are accepted, whatever this machine would post in:
  // the question may have been asked from somewhere else.
  const lang = ASK_LANGS.find((l) => [
    ASK_COPY[l].instructionReactionThread, ASK_COPY[l].instructionReactionHere,
    ASK_COPY[l].instructionTextThread, ASK_COPY[l].instructionTextHere,
  ].includes(last));
  if (!lang) return { kind: "other" };
  const c = ASK_COPY[lang];
  // `last` is one of this language's four instruction lines (checked above).
  threadOnly = last === c.instructionReactionThread || last === c.instructionTextThread;
  hasChoices = last === c.instructionReactionThread || last === c.instructionReactionHere;

  // The question is the leading bold run. Taking it up to the first line that
  // closes the `*` keeps a multi-line question intact instead of truncating it
  // to its first line.
  // Strip the marker before reading the question, so the bold run starts at
  // index 0 either way and a pre-marker body still parses.
  const head = lines[0]!.startsWith(ASK_MARKER_PREFIX) ? lines[0]!.slice(ASK_MARKER_PREFIX.length) : lines[0]!;
  lines[0] = head;
  if (!lines[0]!.startsWith("*")) return { kind: "other" };
  let end = 0;
  while (end < lines.length && !(lines[end]!.endsWith("*") && (end > 0 || lines[0]!.length > 1))) end++;
  if (end >= lines.length) return { kind: "other" };
  const question = lines.slice(0, end + 1).join("\n").replace(/^\*/, "").replace(/\*$/, "");

  const reactable: string[] = [];
  const overflow: string[] = [];
  if (hasChoices) {
    // Walk UP from the instruction line rather than down from the question. The
    // choice block is anchored to the bottom of the body, and scanning downward
    // would let a body line that merely starts with a keycap ("1️⃣ これは本文です")
    // steal a choice slot and shift every number after it.
    let i = lines.length - 2; // the instruction itself is lines[length-1]
    if (isInvalidNotice(lines[i])) i--;
    if (lines[i] !== "") return { kind: "other" };
    i--;
    if (lines[i] === c.overflowNote) {
      i--;
      while (i >= 0 && /^\(\d+\) /.test(lines[i]!)) { overflow.unshift(lines[i]!.replace(/^\(\d+\) /, "")); i--; }
      if (lines[i] !== "") return { kind: "other" };
      i--;
    }
    if (askIsOtherLine(lines[i])) i--;
    const raw: string[] = [];
    while (i >= 0) {
      const line = lines[i]!;
      if (!askIsPillLine(line)) break;
      raw.unshift(line);
      i--;
    }
    // The block has to be keycaps 1..n IN ORDER and separated from the body by a
    // blank line — anything else is a body that only resembles one. Order is not
    // cosmetic: each pill's position is the reaction the poller watches, so a
    // block starting at 2️⃣ would have it waiting on a pill nobody can press.
    if (!raw.length || raw.length > ASK_MAX_REACTION_CHOICES) return { kind: "other" };
    for (let k = 0; k < raw.length; k++) {
      const rest = askStripPill(raw[k]!, k);
      if (rest === null) return { kind: "other" };
      reactable.push(rest);
    }
    if (lines[i] !== "") return { kind: "other" };
    if (i < end + 1) return { kind: "other" };
    // Overflow numbering starts at 11 and runs contiguously.
    for (let n = 0; n < overflow.length; n++) {
      if (!lines.includes(`(${n + 11}) ${overflow[n]}`)) return { kind: "other" };
    }
  }

  return { kind: "open", question, reactable, overflow, threadOnly, lang };
}

/** Did a free-text reply actually PICK one of the offered choices?
 *
 *  Reported from real use 2026-09-04: three options were offered, the answerer
 *  replied 「没懂，能给我讲前因后果吗」 ("I don't follow — can you explain the
 *  background?"), and `--waitFor` exited 0 with that stored AS the decision. Any
 *  reply from an addressed person counted, because nothing compared the reply to
 *  the candidates. A lane harvesting that unparks the work and proceeds with
 *  nothing behind it, and the recorded answer reads as though he had chosen.
 *
 *  Deliberately NARROW. Every loosening here re-creates the same defect one step
 *  further out, and the two error directions are not symmetric: calling a
 *  non-answer an answer makes an automated flow act on a decision nobody took,
 *  while calling an answer a non-answer parks it in front of a human who can
 *  settle it with one reaction. So: an exact choice, a bare number, a keycap, or
 *  a number introducing its own choice text. Nothing fuzzy, nothing partial —
 *  "the second one" and "option B" are NOT matches, on purpose.
 *
 *  `choices` is the full candidate list, reactable and overflow together, in
 *  presentation order. The overflow ones (11+) can only ever be answered as
 *  text, so a matcher that ignored them would call every legitimate answer to a
 *  long question "not chosen" — the failure the caller cannot see. */
export type AskChoiceMatch =
  | { kind: "chosen"; index: number }        // 1-based, matching the printed numbering
  | { kind: "none" }
  | { kind: "ambiguous"; indexes: number[] };

/** Lowercase, NFKC-fold (full-width ７ and ７．become 7), strip decoration and
 *  one trailing sentence mark, collapse runs of space. NFKC is what lets a reply
 *  typed on a Japanese IME match a choice typed on an ASCII keyboard. */
function askNormalizeChoice(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[*_`~]/g, "")
    .trim()
    // Brackets and sentence marks are stripped in ONE class at each end rather
    // than in two passes: 「中止」。 puts the full stop OUTSIDE the quote, so
    // stripping quotes and then punctuation leaves the closing 」 behind and the
    // reply stops matching a choice it plainly names.
    .replace(/^[\s"'`「『（(\[]+/, "")
    .replace(/[\s"'`」』）)\]。．.!！?？、,]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function askMatchChoice(reply: string, choices: string[]): AskChoiceMatch {
  const norm = askNormalizeChoice(reply);
  if (!norm) return { kind: "none" };
  const normChoices = choices.map(askNormalizeChoice);

  const hits = new Set<number>();

  // 1. The reply IS the choice text.
  normChoices.forEach((c, i) => { if (c && c === norm) hits.add(i + 1); });

  // 2. A keycap glyph, which is what someone copies out of the message when they
  //    cannot react (a thread on mobile, or a choice past the tenth).
  ASK_KEYCAPS.forEach((k, i) => {
    if (i < choices.length && reply.trim() === k.glyph) hits.add(i + 1);
  });

  // 3. A number: bare, or introducing the choice it names. `1` and `1. foo` are
  //    the same act. A number followed by DIFFERENT text is not a match — that
  //    is someone writing prose that happens to start with a digit.
  //
  //    The separator is REQUIRED once text follows, and matched as its own
  //    alternative rather than as an optional group. With it optional, `100`
  //    parsed as choice 10 followed by "0" — so a ten-option question whose
  //    tenth choice is "0" matched a reply nobody meant as a choice. That is the
  //    expensive direction of the error, invented while fixing the same one.
  //    (cross-vendor review, 2026-09-05)
  let n = 0;
  let rest = "";
  let m = norm.match(/^(\d{1,2})$/);
  if (m) {
    n = Number(m[1]);
  } else if ((m = norm.match(/^(\d{1,2})(?:\s*[.):：、。\-\]]\s*|\s+)(.*)$/))) {
    n = Number(m[1]);
    // Normalised AGAIN, not merely trimmed: `1. (Release)` reaches here as
    // `(release` — the number kept the opening bracket from being stripped at
    // the head of the string while the closing one went at the tail, leaving an
    // unbalanced remainder that matched nothing. Re-running the same normaliser
    // on the remainder is what makes a bracketed choice answerable by number.
    rest = askNormalizeChoice(m[2]!);
    // A separator with NOTHING after it is not a choice: `1 -` is someone who
    // started typing and stopped, and selecting option 1 for them is the
    // expensive error. `1.` and `1)` still work — their punctuation is stripped
    // at the tail, so they arrive at the bare-number branch above.
    if (!rest) return { kind: "none" };
    // An all-digit remainder is a range or a score (`1-2`), not a numbered
    // choice. Without this, a question whose options are themselves numbers
    // matched `1-2` as "option 1, whose text is 2". Rejecting it fails to the
    // CHEAP side: a genuine `1. 2` re-asks, a false selection does not.
    if (/^\d+$/.test(rest)) return { kind: "none" };
  }
  if (n >= 1 && n <= choices.length && (rest === "" || rest === normChoices[n - 1])) hits.add(n);

  const indexes = [...hits].sort((a, b) => a - b);
  if (!indexes.length) return { kind: "none" };
  // Two distinct choices matched — the same refusal-to-guess the poller already
  // applies when someone presses two pills. Identical choice TEXT is the usual
  // cause, and picking the lower index would answer with a coin flip.
  if (indexes.length > 1) return { kind: "ambiguous", indexes };
  return { kind: "chosen", index: indexes[0]! };
}
