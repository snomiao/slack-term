// Turning a literal `\n` in an argument into a real newline.
//
// WHY this exists at all: this CLI is driven by agents at least as often as by
// people, and an agent composing a message emits `\n` the way it would in JSON —
// it has no shell to interpret it. A person typing into a shell can produce a
// real newline ($'a\nb', or just quoting across lines); an agent building an
// argv array cannot. Without this, every multi-line message an agent sends
// arrives as one line with `\n` printed in it.
//
// WHY `¥n` too: on a Japanese keyboard the ¥ key produces U+00A5 YEN SIGN, not
// U+005C REVERSE SOLIDUS — they are different characters that merely LOOK
// interchangeable, a holdover from Shift-JIS where 0x5C rendered as ¥. Someone
// intending an escape reliably types the one that does nothing. Supporting it
// costs one character in a regex and removes a whole class of "why is my
// message on one line" confusion.
//
// The full-width ￥ (U+FFE5) is deliberately NOT accepted: it is a genuine
// currency glyph that no keyboard produces where a backslash is meant.

/** `\` U+005C, `¥` U+00A5. Not `￥` U+FFE5 — see above. */
const ESCAPE_LEAD = "\\\\\u00A5";

/** Interpret `\n`, `\t` and `\\` (and their ¥ spellings) in text the user
 *  supplied as a command-line argument.
 *
 *  Consumes the lead character in ALL cases, which is what makes `\\n` an
 *  escape hatch for a literal backslash-n rather than a special case: the pair
 *  `\\` collapses to one `\`, and the following `n` is then ordinary text.
 *  A lead followed by anything else is left alone, so `C:\path` and `¥1000`
 *  pass through untouched — the latter matters, because a yen sign in this
 *  workspace is overwhelmingly a price, not an escape. */
export function unescapeArg(s: string): string {
  return s.replace(new RegExp(`[${ESCAPE_LEAD}](.)`, "gs"), (whole, next: string) => {
    switch (next) {
      case "n": return "\n";
      case "t": return "\t";
      case "\\": case "\u00A5": return next === "\u00A5" ? "\u00A5" : "\\";
      default: return whole;
    }
  });
}

/** True if `unescapeArg` would change this string — i.e. it carries an escape
 *  the sender probably meant. Used to decide whether the confirm gate needs to
 *  say so out loud. */
export function hasEscapes(s: string): boolean {
  return unescapeArg(s) !== s;
}
