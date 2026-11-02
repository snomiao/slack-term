// Did Slack store what we sent? Ported from symphr-thread's read-back check
// (2026-10-14 / 10-30), for `pinlog set`.
//
// Slack rewrites text when it stores it:
//   * unicode emoji become :shortcodes: (🧭 → :compass:, 1️⃣ → :one:, a skin
//     tone as :+1::skin-tone-4:); the rich_text block Slack generates keeps
//     the mapping as {type: "emoji", name, unicode: "1f9ed"};
//   * & < > that are not markup become &amp; &lt; &gt;;
//   * a bare URL becomes <url>; a bare domain or e-mail <http://d|d> / <mailto:a|a>.
// So a read-back is compared normalised, never byte for byte: Slack's own
// wrappers undone (an explicit <url|label> is kept), shortcodes mapped back to
// emoji through the message's rich_text, variation selectors and skin tones
// dropped, whitespace runs as one space.

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const EMOJI_SHORTCODE = /:([a-z0-9_+'-]+):((?::skin-tone-[2-6]:)?)/g;
// No "<" inside: Slack escapes one in a link as &lt;, and allowing it makes
// the match quadratic on "<a:<a:<a:…".
const SLACK_LINK = /<([A-Za-z][A-Za-z0-9+.-]*:[^|<>\s]*)(?:\|([^<>]*))?>/g;
const ENTITY = /&(amp|lt|gt);/g;
const VARIATION = /[︎️]/gu;
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const SC = String.raw`:[a-z0-9_+'-]+:(?::skin-tone-[2-6]:)?`;
const EMOJI_BASE = String.raw`©®‼⁉™ℹ←-⇿⌀-⏿Ⓜ■-➿⤀-⥿⬀-⯿〰〽㊗㊙\u{1F000}-\u{1FAFF}`;
const PICT = String.raw`[${EMOJI_BASE}][\u{E0020}-\u{E007F}]*`;
const PIECE = new RegExp(
  String.raw`(?<sc>${SC}(?:‍${SC})*)|(?<emoji>[0-9#*]⃣|[\u{1F1E6}-\u{1F1FF}]{2}|${PICT}(?:‍${PICT})*)|(?<char>[\s\S])`,
  "gu",
);

/** {shortcode name: emoji} from the rich_text emoji elements of a message. */
export function emojiMap(blocks: Json | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const stack: Json[] = [blocks ?? null];
  let seen = 0;
  while (stack.length && seen++ < 100_000) {
    const o = stack.pop();
    if (Array.isArray(o)) stack.push(...o);
    else if (o && typeof o === "object") {
      const name = o.name;
      const uni = o.unicode;
      if (o.type === "emoji" && typeof name === "string" && typeof uni === "string") {
        try {
          out.set(name.split("::")[0]!, uni.split("-").filter(Boolean).map((h) => String.fromCodePoint(parseInt(h, 16))).join(""));
        } catch { /* a bad code point: no mapping */ }
      }
      stack.push(...Object.values(o));
    }
  }
  return out;
}

function unlink(all: string, url: string, label: string | undefined): string {
  if (label === undefined) return url; // <url>: Slack's wrapper around a bare URL
  // Slack's own links around a bare domain / e-mail. Any other <url|label> is
  // explicit: <https://d|d> ≠ <http://d|d>, and /x ≠ /x/.
  for (const auto of ["http://", "mailto:"]) {
    if (url.slice(0, auto.length).toLowerCase() === auto && label === url.slice(auto.length)) return label;
  }
  return all;
}

export function normText(text: string, names: Map<string, string>): string {
  let s = text.normalize("NFC");
  s = s.replace(SLACK_LINK, (all, url: string, label: string | undefined) => unlink(all, url, label));
  s = s.replace(ENTITY, (_, e: string) => ({ amp: "&", lt: "<", gt: ">" })[e as "amp" | "lt" | "gt"]);
  s = s.replace(EMOJI_SHORTCODE, (all, name: string) => names.get(name) ?? all);
  s = s.replace(VARIATION, "").replace(SKIN_TONE, "");
  return s.split(/\s+/).filter(Boolean).join(" ");
}

function tokens(s: string): [string, string][] {
  return [...s.matchAll(PIECE)].map((m) => {
    const g = m.groups!;
    return g.sc !== undefined ? ["sc", g.sc] : g.emoji !== undefined ? ["emoji", g.emoji] : ["char", g.char!];
  });
}

/** True when the stored message (its text and rich_text blocks) carries `sent`. */
export function storedAsSent(sent: string, msg: { text?: Json; blocks?: Json }): boolean {
  const names = emojiMap(msg.blocks);
  const a = normText(sent, names);
  const b = normText(typeof msg.text === "string" ? msg.text : "", names);
  if (a === b) return true;
  // A :shortcode: no rich_text element maps back stays as :name:. Then compare
  // piece by piece: such a stored shortcode may stand for exactly one emoji we
  // sent; every other piece must be equal.
  EMOJI_SHORTCODE.lastIndex = 0;
  if (!EMOJI_SHORTCODE.test(b)) return false;
  const ta = tokens(a);
  const tb = tokens(b);
  return ta.length === tb.length && ta.every(([ka, va], i) => va === tb[i]![1] || (tb[i]![0] === "sc" && ka === "emoji"));
}

/** Where two normalised texts first differ, for the error line. */
export function firstDifference(sent: string, stored: string): string {
  let i = 0;
  while (i < sent.length && i < stored.length && sent[i] === stored[i]) i++;
  const lo = Math.max(0, i - 10);
  return `char ${i}: sent ${JSON.stringify(sent.slice(lo, i + 30))}, stored ${JSON.stringify(stored.slice(lo, i + 30))}`;
}
