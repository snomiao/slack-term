// `slack tick`: turn a "⬜ <n>." item of a posted checklist into "✅ <n>.",
// changing nothing else (taku 10-30: when an announced ⬜ criterion is done,
// edit the original to ✅ rather than only posting a new "done" reply).
// Slack may store the box as the shortcode, so both spellings are handled and
// the tick keeps the spelling it found.

const BOX = /(⬜️?|:white_large_square:)(\s*)(\d+)\./g;
const DONE = /(✅|:white_check_mark:)\s*(\d+)\./g;

export type TickResult =
  | { kind: "ticked"; text: string; n: number }
  | { kind: "already"; n: number }
  | { kind: "none" }
  | { kind: "ambiguous"; open: number[] }
  | { kind: "missing"; n: number };

/** Tick item `n`, or — without `n` — the one open item there is. */
export function tickText(text: string, n?: number): TickResult {
  const open = [...text.matchAll(BOX)].map((m) => Number(m[3]));
  const done = [...text.matchAll(DONE)].map((m) => Number(m[2]));
  if (n === undefined) {
    if (open.length === 0) return done.length ? { kind: "already", n: done[0]! } : { kind: "none" };
    if (open.length > 1) return { kind: "ambiguous", open };
    n = open[0]!;
  }
  if (!open.includes(n)) return done.includes(n) ? { kind: "already", n } : { kind: "missing", n };
  let hit = false;
  const out = text.replace(BOX, (all, box: string, sp: string, num: string) => {
    if (hit || Number(num) !== n) return all;
    hit = true;
    return `${box.startsWith(":") ? ":white_check_mark:" : "✅"}${sp}${num}.`;
  });
  return { kind: "ticked", text: out, n };
}

/** An edit keeps the lane tag the message was posted with (`[lane] ` or
 *  `[lane@host] `), so a rewrite cannot drop or change who said it. Only when
 *  `lanePrefix` (the scope's prefix) is the tag the original starts with. */
export function keepLanePrefix(original: string, next: string, lanePrefix: string | undefined): string {
  const m = /^\[([^\]@\s]+)\]$/.exec(lanePrefix?.trim() ?? "");
  if (!m) return next;
  const lane = m[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = new RegExp(`^\\[${lane}(?:@[a-z0-9-]{1,16})?\\][ \\t]*`);
  const had = tag.exec(original);
  if (!had) return next;
  return had[0] + next.replace(tag, "");
}
