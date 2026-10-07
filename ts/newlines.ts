// Line breaks for messages Slack stored flattened.
//
// WHY: `send`/`edit`/`schedule` attach a `markdown` block so Slack renders
// markdown. Whenever a message has blocks, Slack stores its top-level `text`
// with every newline turned into a space. The rendered message looks right,
// but every reader of `.text` sees one long line: `read --format jsonl`, ask's
// parser, and any script on conversations.history.
// Measured 2026-10-07:
// - 126 of 127 multi-line sends were stored that way;
// - the stored text is the source with `\n` → ` ` plus Slack's escaping;
// - a live send with our own rich_text blocks was flattened the same way, so
//   no blocks keep `.text`, only a plain post does (`ask`, `poll`).
//
// The blocks still carry the breaks. Readers use them to put the breaks back.

import type { Json } from "./slack.ts";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** The characters of `blocks` that must appear, in order, in the message's
 *  stored `text`, with `null` wherever the blocks put a line break. */
function anchors(blocks: Json[]): Array<string | null> {
  const out: Array<string | null> = [];
  const chars = (s: string) => { for (const ch of s) { if (ch === "\n") out.push(null); else if (!/\s/u.test(ch)) out.push(...(ESC[ch] ?? ch)); } };
  const inline = (e: Record<string, Json>) => {
    switch (e.type) {
      case "text": chars(String(e.text ?? "")); break;
      case "link": case "message_mention": chars(String(e.url ?? "")); break;
      case "user": chars(String(e.user_id ?? "")); break;
      case "channel": chars(String(e.channel_id ?? "")); break;
      case "usergroup": chars(String(e.usergroup_id ?? "")); break;
      case "broadcast": chars(String(e.range ?? "")); break;
      case "emoji": chars(String(e.name ?? "")); break;
      default: break;
    }
  };
  const container = (b: Record<string, Json>) => {
    const els = Array.isArray(b.elements) ? (b.elements as Record<string, Json>[]) : [];
    if (b.type === "rich_text_list" || b.type === "rich_text") {
      els.forEach((x, k) => { if (k > 0) out.push(null); container(x); });
    } else {
      els.forEach(inline);
    }
  };
  blocks.forEach((b, k) => {
    if (k > 0) out.push(null);
    const r = b as Record<string, Json>;
    if (r.type === "rich_text") container(r);
  });
  return out;
}

/** `text` with its line breaks put back, for a message Slack stored flattened
 *  (it had blocks — see the top of this file). Slack replaced
 *  every `\n` of the source with one space; the `rich_text` blocks still carry
 *  the breaks. Walk the blocks' visible characters through `text` and, at each
 *  place the blocks break a line, turn the spaces there back into newlines.
 *
 *  Only ever turns spaces into newlines, so the result is the stored text when
 *  breaks are ignored — what a reader saw before, never anything new. Returns
 *  `text` unchanged unless it is single-line and the blocks are multi-line,
 *  or when the two cannot be aligned. */
export function restoreNewlines(text: string, blocks: Json | undefined): string {
  if (text.includes("\n") || !Array.isArray(blocks) || !blocks.some((b) => (b as Record<string, Json>)?.type === "rich_text")) return text;
  const seq = anchors(blocks);
  if (!seq.includes(null)) return text;
  const chars = [...text];
  // Map each anchor to its position in `text`; a code block at either end
  // also has a break between its fence and its first/last character.
  const elems = (blocks[0] as Record<string, Json>).elements;
  const lastBlock = blocks[blocks.length - 1] as Record<string, Json>;
  const lastElems = lastBlock.elements;
  const startsPre = Array.isArray(elems) && (elems[0] as Record<string, Json>)?.type === "rich_text_preformatted";
  const endsPre = Array.isArray(lastElems) && (lastElems[lastElems.length - 1] as Record<string, Json>)?.type === "rich_text_preformatted";
  let p = 0, last = startsPre ? -1 : -2, pendingBreak = startsPre;
  const breaks: Array<[number, number]> = [];
  for (const a of seq) {
    if (a === null) { if (last >= -1) pendingBreak = true; continue; }
    let q = p;
    while (q < chars.length && chars[q] !== a) q++;
    if (q >= chars.length) return text;
    if (pendingBreak) { breaks.push([last + 1, q]); pendingBreak = false; }
    last = q; p = q + 1;
  }
  if (endsPre && last >= 0) breaks.push([last + 1, chars.length]);
  const MARKER = /^(?:[-*+•]|\d{1,9}[.)]|&gt;|>)$/;
  for (const [gapFrom, to] of breaks) {
    // The gap between two visible characters holds the old newline(s) as
    // spaces plus markup: the rest of a `<url|label>` (skip past its `>`),
    // emphasis, `- `/`1. `/`&gt; ` markers, code fences. A space after a
    // marker that itself starts a line is the marker's own, not a break.
    let k = gapFrom;
    // Inside a `<url|label>` token (its `<` opened before the gap and is not
    // yet closed) the rest of the token up to its `>` is not a line break.
    if (chars.lastIndexOf("<", gapFrom - 1) > chars.lastIndexOf(">", gapFrom - 1)) {
      const close = chars.indexOf(">", gapFrom);
      if (close !== -1 && close < to) k = close + 1;
    }
    let word = "", lineStart = false;
    while (k < to) {
      if (chars[k] === " ") {
        let e = k; while (e < to && chars[e] === " ") e++;
        if (lineStart && MARKER.test(word)) {
          lineStart = false;
        } else {
          // One space per old newline — but three or more are a newline
          // followed by indentation (`\n   - nested`), not a run of blank lines.
          const n = e - k <= 2 ? e - k : 1;
          for (let x = k; x < k + n; x++) chars[x] = "\n";
          lineStart = true;
        }
        word = ""; k = e;
      } else { word += chars[k]; k++; }
    }
  }
  return chars.join("");
}

/** `restoreNewlines` applied in place to a conversations.history /
 *  conversations.replies message, so every reader of `.text` sees the breaks. */
export function repairMessageText(m: Json): void {
  if (!m || typeof m !== "object" || Array.isArray(m)) return;
  const r = m as Record<string, Json>;
  if (typeof r.text === "string") r.text = restoreNewlines(r.text, r.blocks);
}
