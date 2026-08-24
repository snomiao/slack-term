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

/** One line, always: newlines inside a choice would break the line-based body. */
function askFlatten(s: string): string {
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
    lines.push(...reactable.map((s, i) => `${ASK_KEYCAPS[i]!.glyph} ${askFlatten(s)}`));
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
      if (!ASK_KEYCAPS.some((k) => line.startsWith(`${k.glyph} `) || line === k.glyph)) break;
      raw.unshift(line);
      i--;
    }
    // The block has to be keycaps 1..n IN ORDER and separated from the body by a
    // blank line — anything else is a body that only resembles one. Order is not
    // cosmetic: each pill's position is the reaction the poller watches, so a
    // block starting at 2️⃣ would have it waiting on a pill nobody can press.
    if (!raw.length || raw.length > ASK_MAX_REACTION_CHOICES) return { kind: "other" };
    for (let k = 0; k < raw.length; k++) {
      const glyph = ASK_KEYCAPS[k]!.glyph;
      if (!(raw[k]!.startsWith(`${glyph} `) || raw[k] === glyph)) return { kind: "other" };
      reactable.push(raw[k]!.slice(glyph.length + 1));
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
