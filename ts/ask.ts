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

// The instruction line is the wire contract. `ask` keeps no local record of a
// question, so `--waitFor` has to recover everything from the posted message —
// and this line is what identifies it as an ask at all, and which answer paths
// it promised to read. Change the wording and old in-flight questions become
// unparseable, so treat these strings as a format version, not as copy.
const ASK_INSTRUCTION_REACTION_THREAD =
  "_下のリアクションを 1 つ押すと回答になります。当てはまるものがなければ、このメッセージの *スレッド* で返信してください (チャンネルへの通常投稿は回答として拾いません)。_";
const ASK_INSTRUCTION_REACTION_HERE =
  "_下のリアクションを 1 つ押すと回答になります。当てはまるものがなければ、このメッセージに返信してください。_";
const ASK_INSTRUCTION_TEXT_THREAD =
  "_このメッセージの *スレッド* で返信してください。本文がそのまま回答になります (チャンネルへの通常投稿は回答として拾いません)。_";
const ASK_INSTRUCTION_TEXT_HERE =
  "_このメッセージに返信してください。本文がそのまま回答になります。_";
const ASK_OVERFLOW_NOTE = "_11 番目以降はリアクションがないので、返信で答えてください。_";

/** Prefix `markResolved` stamps on a settled question. `--waitFor` keys "this
 *  was already answered while nobody was watching" off it, which is the whole
 *  reason a fire-and-forget ask can be collected later at all. */
export const ASK_RESOLVED_PREFIX = ":white_check_mark: ";

/** One line, always: newlines inside a choice would break the line-based body. */
function askFlatten(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}

/** Question body: the prompt, the numbered choices matching the seeded pills,
 *  and an instruction naming the answer paths this command actually reads.
 *  `askParseMessage` is its inverse — keep the two in step. */
export function askBuildText(question: string, body: string, reactable: string[], overflow: string[], threadOnly: boolean): string {
  const lines: string[] = [`*${question}*`];
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
