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

// The instruction lines. These are ordinary copy now — translate them freely.
// They are still matched verbatim when reading a message posted BEFORE the
// marker existed, which is the only reason the exact old strings survive here:
// deleting them would strand every question still in flight.
const ASK_INSTRUCTION_REACTION_THREAD =
  "_下のリアクションを 1 つ押すと回答になります。当てはまるものがなければ、このメッセージの *スレッド* で返信してください (チャンネルへの通常投稿は回答として拾いません)。_";
const ASK_INSTRUCTION_REACTION_HERE =
  "_下のリアクションを 1 つ押すと回答になります。当てはまるものがなければ、このメッセージに返信してください。_";
const ASK_INSTRUCTION_TEXT_THREAD =
  "_このメッセージの *スレッド* で返信してください。本文がそのまま回答になります (チャンネルへの通常投稿は回答として拾いません)。_";
const ASK_INSTRUCTION_TEXT_HERE =
  "_このメッセージに返信してください。本文がそのまま回答になります。_";
const ASK_OVERFLOW_NOTE = "_11 番目以降はリアクションがないので、返信で答えてください。_";

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
const INVALID_PREFIX = "_:warning: 同時に複数選ばれているため回答として数えていません — どれか 1 つだけ残してください: ";
const INVALID_SUFFIX = "_";

/** The IDs named by a message's invalid-ballot line, or [] if it has none. */
export function readInvalidNotice(text: string): string[] {
  const lines = text.split("\n");
  const line = lines[lines.length - 2];
  if (line === undefined || !line.startsWith(INVALID_PREFIX) || !line.endsWith(INVALID_SUFFIX)) return [];
  return [...line.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]!);
}

/** Put `invalid` into the body — inserting, replacing or REMOVING the notice so
 *  the result depends only on the current state, never on how many times this
 *  has run. Returns the text unchanged when nothing needs to move, which is the
 *  caller's signal to skip the edit entirely.
 *
 *  The notice sits directly above the instruction line because that line has to
 *  stay last: it is what identifies the message as an `ask`/`poll` at all. */
export function applyInvalidNotice(text: string, invalid: string[]): string {
  const lines = text.split("\n");
  if (lines.length < 2) return text;
  if (readInvalidNotice(text).length) lines.splice(lines.length - 2, 1);
  if (invalid.length) {
    lines.splice(lines.length - 1, 0, `${INVALID_PREFIX}${invalid.map((u) => `<@${u}>`).join(", ")}${INVALID_SUFFIX}`);
  }
  const out = lines.join("\n");
  return out === text ? text : out;
}

/** True if this line is the notice — parsers skip it when walking up. */
export function isInvalidNotice(line: string | undefined): boolean {
  return line !== undefined && line.startsWith(INVALID_PREFIX) && line.endsWith(INVALID_SUFFIX);
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
export function askBuildText(question: string, body: string, reactable: string[], overflow: string[], threadOnly: boolean): string {
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
    if (overflow.length) {
      lines.push("");
      lines.push(...overflow.map((s, i) => `(${i + 11}) ${askFlatten(s)}`));
      lines.push(ASK_OVERFLOW_NOTE);
    }
    lines.push("");
    // The instruction must name the exact path the poller reads. Where only
    // thread replies are picked up, telling people to "reply to this message"
    // would get in-channel answers silently ignored.
    lines.push(threadOnly ? ASK_INSTRUCTION_REACTION_THREAD : ASK_INSTRUCTION_REACTION_HERE);
  } else {
    lines.push("");
    lines.push(threadOnly ? ASK_INSTRUCTION_TEXT_THREAD : ASK_INSTRUCTION_TEXT_HERE);
  }
  return lines.join("\n");
}

/** Resolved-question body. Every answer line is quoted, not just the first —
 *  a multi-line reply left unquoted after the first line cannot be told back
 *  apart from the surrounding text when `--waitFor` reads it. */
export function askBuildResolvedText(question: string, found: AskFound, who: string): string {
  const quoted = found.answer.split("\n").map((l) => `> ${l}`).join("\n");
  return `${ASK_RESOLVED_PREFIX}*${question}*\n_${found.how}で回答済み${who ? ` (${who})` : ""}_\n\n${quoted}`;
}

export type AskParsed =
  | { kind: "open"; question: string; reactable: string[]; overflow: string[]; threadOnly: boolean }
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
    const question = head.replace(/^\*/, "").replace(/\*$/, "");
    const answer = lines
      .filter((l) => l.startsWith("> "))
      .map((l) => l.slice(2))
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
  switch (last) {
    case ASK_INSTRUCTION_REACTION_THREAD: threadOnly = true; hasChoices = true; break;
    case ASK_INSTRUCTION_REACTION_HERE: threadOnly = false; hasChoices = true; break;
    case ASK_INSTRUCTION_TEXT_THREAD: threadOnly = true; hasChoices = false; break;
    case ASK_INSTRUCTION_TEXT_HERE: threadOnly = false; hasChoices = false; break;
    default: return { kind: "other" };
  }

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
    if (lines[i] === ASK_OVERFLOW_NOTE) {
      i--;
      while (i >= 0 && /^\(\d+\) /.test(lines[i]!)) { overflow.unshift(lines[i]!.replace(/^\(\d+\) /, "")); i--; }
      if (lines[i] !== "") return { kind: "other" };
      i--;
    }
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

  return { kind: "open", question, reactable, overflow, threadOnly };
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
  const m = norm.match(/^(\d{1,2})\s*[.):：、。]?\s*(.*)$/);
  if (m) {
    const n = Number(m[1]);
    const rest = m[2]!.trim();
    if (n >= 1 && n <= choices.length && (rest === "" || rest === normChoices[n - 1])) hits.add(n);
  }

  const indexes = [...hits].sort((a, b) => a - b);
  if (!indexes.length) return { kind: "none" };
  // Two distinct choices matched — the same refusal-to-guess the poller already
  // applies when someone presses two pills. Identical choice TEXT is the usual
  // cause, and picking the lower index would answer with a coin flip.
  if (indexes.length > 1) return { kind: "ambiguous", indexes };
  return { kind: "chosen", index: indexes[0]! };
}
