/** Bare Unicode URL text has an ambiguous boundary for Slack's autolinker.
 * Explicit Slack links delimit the URL, including intentional Unicode paths.
 * ASCII whitespace (especially newlines) is a safe boundary; Unicode spaces
 * should be made explicit too. Do not rewrite the message or its newlines.
 *
 * Both ends matter. A URL glued to the text AFTER it (`https://x/内容`) gets the
 * text swallowed into the link; a URL glued to the text BEFORE it
 * (`说明：https://x/`) is not autolinked at all — Slack stores it as a plain
 * `text` element and every client shows it as dead text. The markdown
 * autolinker (GFM rules) only starts a link at the start of a line, after
 * ASCII whitespace, or after one of `( * _ ~`. */

const URL_TOKEN = /<https?:\/\/[^\s<>|]+(?:\|[^<>\r\n]*)?>|https?:\/\/[^\t\n\v\f\r <]+/gi;
/** What may sit right before a bare URL and still let it autolink. */
const SAFE_BEFORE = /[\t\n\v\f\r (*_~]/;

export type UrlBoundaryIssue = { url: string; side: "before" | "after"; char: string };

/** Code spans and fences are shown verbatim and never autolinked, so a URL in
 *  one is not a boundary problem; neither is a `[label](url)` link, which is
 *  explicit. Blanked (length-preserving, newlines kept) rather than removed so
 *  indices still line up with the original text; the filler is a non-space so a
 *  URL glued to the END of a span is still caught.
 *
 *  A small CommonMark-shaped scanner, not a regex: a backslash escapes the
 *  next character (`\`` is a literal backtick, not a span opener), a span
 *  opened by a run of N backticks closes only at the next run of exactly N,
 *  and an unclosed run is literal text. A fence is ``` or ~~~ at line start
 *  and runs to a matching fence line, or to the end. */
function maskCode(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = "\x00";
  };
  let i = 0;
  while (i < text.length) {
    const lineStart = i === 0 || text[i - 1] === "\n";
    const fence = lineStart ? /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i)) : null;
    if (fence) {
      const marker = fence[1]!;
      const close = new RegExp(`\n {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \t]*(?=\n|$)`, "g");
      close.lastIndex = i + fence[0].length;
      const m = close.exec(text);
      const end = m ? m.index + m[0].length : text.length;
      blank(i, end);
      i = end;
      continue;
    }
    const ch = text[i]!;
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") {
      let n = 0;
      while (text[i + n] === "`") n++;
      let j = i + n;
      let end = -1;
      while (j < text.length) {
        if (text[j] !== "`") { j++; continue; }
        let r = 0;
        while (text[j + r] === "`") r++;
        if (r === n) { end = j + r; break; }
        j += r;
      }
      if (end < 0) { i += n; continue; }
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "[") {
      const link = /^\[[^\]\n]*\]\([^()\s]*\)/.exec(text.slice(i));
      if (link) { blank(i, i + link[0].length); i += link[0].length; continue; }
    }
    i++;
  }
  return out.join("");
}

export function urlBoundaryIssues(text: string): UrlBoundaryIssue[] {
  const masked = maskCode(text);
  const issues: UrlBoundaryIssue[] = [];
  for (const m of masked.matchAll(URL_TOKEN)) {
    const url = m[0];
    if (url.startsWith("<")) continue;
    const at = m.index ?? 0;
    const before = at > 0 ? masked[at - 1]! : "";
    if (before && !SAFE_BEFORE.test(before)) {
      issues.push({ url, side: "before", char: text[at - 1]! });
      continue;
    }
    const after = url.match(/[^\x00-\x7f]|>/);
    if (after) issues.push({ url, side: "after", char: after[0] });
  }
  return issues;
}

export function adjacentUrls(text: string): string[] {
  return urlBoundaryIssues(text).map((i) => i.url);
}

export function guardUrlBoundaries(
  text: string, allow = false, warn: (message: string) => void = console.error,
  sides: ReadonlyArray<UrlBoundaryIssue["side"]> = ["before", "after"],
): void {
  const issues = urlBoundaryIssues(text).filter((i) => sides.includes(i.side));
  if (!issues.length) return;
  const described = issues.map((i) => i.side === "before"
    ? `${JSON.stringify(i.url)} (glued to ${JSON.stringify(i.char)} before it — Slack will NOT make it a link)`
    : `${JSON.stringify(i.url)} (runs into ${JSON.stringify(i.char)} after it)`);
  const fixes = issues.some((i) => i.side === "before")
    ? "Put an ASCII space (or a newline) before the URL, " : "";
  const message = `Ambiguous URL boundary: ${described.join(", ")}. ` +
    `${fixes}Put the URL on its own line, or wrap it as <url> / <url|label>. ` +
    "Use --allow-url-adjacent to warn only.";
  if (!allow) throw new Error(message);
  warn(`Warning: ${message}`);
}

type RichTextElement =
  | { type: "text"; text: string }
  | { type: "link"; url: string; text?: string };

/** Elements for a `rich_text_section` with every URL as a real `link` element.
 *  Drafts are posted as raw rich_text, which Slack never autolinks: a URL left
 *  in a `text` element stays dead text however it is spaced. A bare URL ends at
 *  whitespace, `<`, or the first non-ASCII character (`https://x/内容` links
 *  `https://x/` only), and trailing sentence punctuation is left outside it.
 *  Whether that cut is the intended one is ambiguous, so callers gate it with
 *  `guardUrlBoundaries(text, allow, warn, ["after"])` first. */
export function linkifyRichText(text: string): RichTextElement[] {
  const out: RichTextElement[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += s;
    else out.push({ type: "text", text: s });
  };
  const re = /<(https?:\/\/[^\s<>|]+)(?:\|([^<>\r\n]*))?>|https?:\/\/[\x21-\x3b\x3d\x3f-\x7e]+/gi;
  let pos = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    pushText(text.slice(pos, at));
    if (m[1]) {
      out.push(m[2] ? { type: "link", url: m[1], text: m[2] } : { type: "link", url: m[1] });
      pos = at + m[0].length;
      continue;
    }
    let url = m[0];
    // GFM-style trailing trim: sentence punctuation, and `)` with no `(` to match.
    while (/[.,:;!?'"*_~]$/.test(url) || (url.endsWith(")") && count(url, "(") < count(url, ")"))) {
      url = url.slice(0, -1);
    }
    out.push({ type: "link", url });
    pos = at + url.length;
  }
  pushText(text.slice(pos));
  return out;
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}
