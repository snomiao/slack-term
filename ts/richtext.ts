// Markdown → Slack `rich_text` blocks, and the reverse repair for old messages.
//
// WHY this exists: `send`/`edit`/`schedule` used to attach a `markdown` block
// carrying the caller's text. Slack converts that block to `rich_text` on its
// side and then REGENERATES the message's top-level `text` from the source with
// every newline replaced by a space. The rendered message looked right, but
// every reader of `.text` — push previews, search snippets, `read --format
// jsonl`, `ask`'s parser, any script on conversations.history — got one long
// line. Measured 2026-10-07 over 276 messages this CLI had sent: every
// multi-line one (126 of 127) was stored flattened; the logged source and the
// stored text differ by exactly that substitution (plus Slack's usual entity
// escaping).
//
// With blocks Slack does NOT generate (here `rich_text`), the `text` argument
// is stored as given — it is the notification fallback. So the fix is to do
// the markdown → rich_text conversion here, the way Slack's markdown block does
// it, and send both. The conversion was fitted against what Slack stored for
// those same 276 messages (see tests/richtext.test.ts for the shapes).
//
// Anything this converter does not model faithfully (headings, tables, setext
// underlines) makes `markdownToRichText` return null, and the caller falls back
// to the `markdown` block: the rendering stays right, the stored text is
// flattened as before. Readers repair that case with `restoreNewlines`.

import type { Json } from "./slack.ts";

type Style = { bold?: true; italic?: true; strike?: true; code?: true };
type Inline = Record<string, Json>;

// --- inline -----------------------------------------------------------------

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
function isWs(ch: string): boolean { return ch === "" || /\s/u.test(ch); }
function isPunct(ch: string): boolean { return ch !== "" && (ASCII_PUNCT.test(ch) || /[\p{P}\p{S}]/u.test(ch)); }

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt);/g, (_, e: string) => (e === "amp" ? "&" : e === "lt" ? "<" : ">"));
}

/** One lexical unit before emphasis is resolved. `delim` units are runs of
 *  `*`, `_` or `~` that may still turn out to be literal text. */
type Atom =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "el"; el: Inline }
  | { kind: "delim"; ch: string; len: number; open: boolean; close: boolean; styles: Array<keyof Style>; closes: Array<keyof Style> };

/** `<…>` escapes: mentions, broadcasts, channels and labelled links — the
 *  Slack-native spellings `send` writes (or converts `@handle` into). */
function angleToken(inner: string): Inline | null {
  if (/^@[UW][A-Z0-9]+(\|[^>]*)?$/.test(inner)) return { type: "user", user_id: inner.slice(1).split("|")[0]! };
  if (/^#C[A-Z0-9]+(\|[^>]*)?$/.test(inner)) return { type: "channel", channel_id: inner.slice(1).split("|")[0]! };
  const bc = /^!(here|channel|everyone)(\|[^>]*)?$/.exec(inner);
  if (bc) return { type: "broadcast", range: bc[1]! };
  const ug = /^!subteam\^([A-Z0-9]+)(\|[^>]*)?$/.exec(inner);
  if (ug) return { type: "usergroup", usergroup_id: ug[1]! };
  const link = /^((?:https?|mailto|ftp|slack):[^|\s]+)(?:\|(.*))?$/s.exec(inner);
  if (link) {
    const el: Inline = { type: "link", url: decodeEntities(link[1]!) };
    if (link[2] !== undefined && link[2] !== "") el.text = decodeEntities(link[2]);
    return el;
  }
  return null;
}

/** GFM's extended autolink: a bare http(s) URL after whitespace, a line start
 *  or one of `*_~(`. Trailing punctuation and an unbalanced `)` stay outside. */
function bareUrlAt(s: string, i: number): string | null {
  const prev = i === 0 ? "" : s[i - 1]!;
  if (!(prev === "" || isWs(prev) || "*_~(".includes(prev))) return null;
  const m = /^https?:\/\/[^\s<]+/.exec(s.slice(i));
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const last = url[url.length - 1]!;
    if ("?!.,:*_~'\"".includes(last)) { url = url.slice(0, -1); continue; }
    if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) { url = url.slice(0, -1); continue; }
    break;
  }
  return /^https?:\/\/[^/?#]+\.[^/?#]+/.test(url) || /^https?:\/\/[^/?#]+$/.test(url) ? url : null;
}

/** GFM's email autolink: `local@domain.tld` not glued to a word on the left. */
function bareEmailAt(s: string, i: number): string | null {
  const prev = i === 0 ? "" : s[i - 1]!;
  if (!(prev === "" || isWs(prev) || "*_~(".includes(prev))) return null;
  const m = /^[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/.exec(s.slice(i));
  if (!m) return null;
  let mail = m[0];
  while (mail.endsWith(".")) mail = mail.slice(0, -1);
  return /[-_]$/.test(mail) || !/\.[A-Za-z0-9_-]+$/.test(mail) ? null : mail;
}

function lex(s: string): Atom[] {
  const atoms: Atom[] = [];
  let buf = "";
  const flush = () => { if (buf) { atoms.push({ kind: "text", text: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1]!)) { buf += s[i + 1]; i += 2; continue; }
    if (ch === "`") {
      let n = 0; while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let j = i + n, end = -1;
      while ((j = s.indexOf(fence, j)) !== -1) {
        if (s[j + n] !== "`" && s[j - 1] !== "`") { end = j; break; }
        while (s[j] === "`") j++;
      }
      if (end === -1) { buf += fence; i += n; continue; }
      let code = s.slice(i + n, end).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
      flush(); atoms.push({ kind: "code", text: decodeEntities(code) });
      i = end + n; continue;
    }
    if (ch === "[") {
      // `[label](url)` — only with a real URL; `[lane](free text)` stays text.
      const m = /^\[([^\]\n]+)\]\(((?:https?|mailto):[^\s()]+)\)/.exec(s.slice(i));
      if (m) { flush(); atoms.push({ kind: "el", el: { type: "link", url: decodeEntities(m[2]!), text: decodeEntities(m[1]!) } }); i += m[0].length; continue; }
    }
    if (ch === "<") {
      const close = s.indexOf(">", i);
      const inner = close === -1 ? "" : s.slice(i + 1, close);
      const el = close !== -1 && !inner.includes("\n") ? angleToken(inner) : null;
      if (el) { flush(); atoms.push({ kind: "el", el }); i = close + 1; continue; }
    }
    if (ch === ":" && !/[A-Za-z0-9]/.test(s[i - 1] ?? "")) {
      const m = /^:([a-z0-9_+'-]*[a-z_+'-][a-z0-9_+'-]*):(?::(skin-tone-[2-6]):)?(?![A-Za-z0-9])/.exec(s.slice(i));
      if (m) {
        flush();
        const el: Inline = { type: "emoji", name: m[1]! };
        if (m[2]) el.skin_tone = Number(m[2].slice(-1));
        atoms.push({ kind: "el", el }); i += m[0].length; continue;
      }
    }
    if (/[A-Za-z0-9._+-]/.test(ch)) {
      const mail = bareEmailAt(s, i);
      if (mail) { flush(); atoms.push({ kind: "el", el: { type: "link", url: `mailto:${mail}` } }); i += mail.length; continue; }
    }
    if (ch === "h") {
      const url = bareUrlAt(s, i);
      if (url) { flush(); atoms.push({ kind: "el", el: { type: "link", url: decodeEntities(url) } }); i += url.length; continue; }
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let n = 0; while (s[i + n] === ch) n++;
      const before = i === 0 ? "" : s[i - 1]!;
      const after = i + n >= s.length ? "" : s[i + n]!;
      const left = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const right = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let open = left, close = right;
      if (ch === "_") { open = left && (!right || isPunct(before)); close = right && (!left || isPunct(after)); }
      if (ch === "~" && n > 2) { open = close = false; }
      flush();
      atoms.push({ kind: "delim", ch, len: n, open, close, styles: [], closes: [] });
      i += n; continue;
    }
    if (ch === "&") {
      const m = /^&(amp|lt|gt);/.exec(s.slice(i));
      if (m) { buf += decodeEntities(m[0]); i += m[0].length; continue; }
    }
    buf += ch; i++;
  }
  flush();
  return atoms;
}

/** CommonMark's "process emphasis", reduced to what Slack styles: `*`/`_` give
 *  italic (one) or bold (two); `~`/`~~` give strike. Each delimiter atom ends
 *  up with the styles it opens and closes; what is left over is literal. */
function resolveEmphasis(atoms: Atom[]): void {
  type D = Extract<Atom, { kind: "delim" }> & { orig: number; left: number };
  const ds: Array<{ a: D; idx: number }> = [];
  atoms.forEach((a, idx) => { if (a.kind === "delim") { (a as D).orig = a.len; (a as D).left = a.len; ds.push({ a: a as D, idx }); } });
  for (let c = 0; c < ds.length; c++) {
    const closer = ds[c]!.a;
    while (closer.close && closer.left > 0) {
      let found = -1;
      for (let o = c - 1; o >= 0; o--) {
        const op = ds[o]!.a;
        if (op.ch !== closer.ch || !op.open || op.left === 0) continue;
        if (closer.ch === "~") { if (op.left !== closer.left) continue; }
        else if ((op.close || closer.open) && (op.orig + closer.orig) % 3 === 0 && !(op.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
        found = o; break;
      }
      if (found === -1) break;
      const op = ds[found]!.a;
      // Everything between the pair that is still an open delimiter can no
      // longer match anything outside it.
      for (let k = found + 1; k < c; k++) ds[k]!.a.open = false;
      let style: keyof Style, use: number;
      if (closer.ch === "~") { style = "strike"; use = closer.left; }
      else { use = op.left >= 2 && closer.left >= 2 ? 2 : 1; style = use === 2 ? "bold" : "italic"; }
      op.left -= use; closer.left -= use;
      op.styles.push(style); closer.closes.push(style);
    }
  }
}

function build(atoms: Atom[]): Inline[] {
  resolveEmphasis(atoms);
  const out: Inline[] = [];
  const active: Record<string, number> = {};
  const styleObj = (code = false): Record<string, Json> | undefined => {
    const st: Record<string, Json> = {};
    for (const k of ["bold", "italic", "strike"]) if (active[k]) st[k] = true;
    if (code) st.code = true;
    return Object.keys(st).length ? st : undefined;
  };
  const pushText = (text: string, code = false) => {
    if (!text) return;
    const style = styleObj(code);
    const prev = out[out.length - 1];
    if (prev && prev.type === "text" && JSON.stringify(prev.style ?? null) === JSON.stringify(style ?? null)) { prev.text = String(prev.text) + text; return; }
    out.push(style ? { type: "text", text, style } : { type: "text", text });
  };
  for (const a of atoms) {
    if (a.kind === "text") pushText(a.text);
    else if (a.kind === "code") pushText(a.text, true);
    else if (a.kind === "el") {
      const style = a.el.type === "link" ? styleObj() : undefined;
      out.push(style ? { ...a.el, style } : a.el);
    } else {
      const d = a as Atom & { left: number };
      // Closing styles come first (`*a*_b_`), opening ones after; the literal
      // remainder of the run sits between, outside both.
      for (const s of a.closes) active[s] = (active[s] ?? 1) - 1;
      if (d.left > 0) pushText(a.ch.repeat(d.left));
      for (const s of a.styles) active[s] = (active[s] ?? 0) + 1;
    }
  }
  return out;
}

export function inlineToElements(s: string): Inline[] {
  return build(lex(s));
}

// --- blocks -----------------------------------------------------------------

type Node =
  | { kind: "para"; lines: string[]; blank: boolean }
  | { kind: "code"; text: string; blank: boolean }
  | { kind: "quote"; lines: string[]; blank: boolean }
  | { kind: "hr"; blank: boolean }
  | { kind: "list"; ordered: boolean; marker: string; start: number; items: Item[]; blank: boolean };
type Item = { lines: string[]; children: Node[] };

class Unsupported extends Error {}

const BULLET = /^( {0,3})([-+*•])( +|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])( +|$)(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HR = /^ {0,3}([-*_])( *\1){2,} *$/;

function listMarker(line: string): { ordered: boolean; marker: string; start: number; col: number; rest: string } | null {
  const b = BULLET.exec(line);
  if (b) {
    const sp = b[3]!.length;
    return { ordered: false, marker: b[2]!, start: 1, col: b[1]!.length + 1 + (sp > 4 ? 1 : Math.max(sp, 1)), rest: sp > 4 ? " ".repeat(sp - 1) + b[4]! : b[4]! };
  }
  const o = ORDERED.exec(line);
  if (o) {
    const sp = o[4]!.length;
    return { ordered: true, marker: o[3]!, start: Number(o[2]), col: o[1]!.length + o[2]!.length + 1 + (sp > 4 ? 1 : Math.max(sp, 1)), rest: o[5]! };
  }
  return null;
}

function isBlankLine(l: string): boolean { return l.trim() === ""; }

/** Could `line` start a block that interrupts a paragraph? (CommonMark: an
 *  ordered list interrupts only when it starts at 1, and no list starts empty.) */
function interrupts(line: string): boolean {
  if (FENCE.test(line) || HR.test(line) || /^ {0,3}>/.test(line) || /^ {0,3}#{1,6}( |$)/.test(line)) return true;
  const m = listMarker(line);
  return !!m && m.rest.trim() !== "" && (!m.ordered || m.start === 1);
}

function parseBlocks(lines: string[]): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  let blank = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlankLine(line)) { blank = true; i++; continue; }
    if (/^ {0,3}#{1,6}( |$)/.test(line)) throw new Unsupported("heading");
    const fence = FENCE.exec(line);
    if (fence) {
      const f = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${f[0] === "`" ? "`" : "~"}{${f.length},} *$`).test(lines[i]!)) body.push(lines[i++]!);
      i++;
      nodes.push({ kind: "code", text: body.join("\n"), blank });
      blank = false; continue;
    }
    if (HR.test(line)) { nodes.push({ kind: "hr", blank }); blank = false; i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) q.push(lines[i++]!.replace(/^ {0,3}> ?/, ""));
      nodes.push({ kind: "quote", lines: q, blank });
      blank = false; continue;
    }
    const lm = listMarker(line);
    if (lm) {
      const list: Extract<Node, { kind: "list" }> = { kind: "list", ordered: lm.ordered, marker: lm.marker, start: lm.start, items: [], blank };
      blank = false;
      while (i < lines.length) {
        const m = listMarker(lines[i]!);
        if (!m || m.ordered !== list.ordered || m.marker !== list.marker) break;
        const body: string[] = [m.rest];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const l = lines[i]!;
          if (isBlankLine(l)) { sawBlank = true; body.push(""); i++; continue; }
          const ind = l.length - l.trimStart().length;
          if (ind >= m.col) { body.push(l.slice(m.col)); sawBlank = false; i++; continue; }
          // Lazy continuation: an unindented line right after paragraph text
          // still belongs to that paragraph unless it starts a block.
          const lastLine = body[body.length - 1] ?? "";
          if (!sawBlank && !interrupts(l) && !listMarker(l.trimStart()) && !isBlankLine(lastLine)) { body.push(l); i++; continue; }
          break;
        }
        while (body.length && isBlankLine(body[body.length - 1]!)) { body.pop(); }
        // A blank line that ended the item is the separator before whatever
        // comes next, not part of the item.
        if (sawBlank) blank = true;
        list.items.push(splitItem(body));
        if (i < lines.length && isBlankLine(lines[i]!)) { i = skipBlank(lines, i); blank = true; }
        const next = i < lines.length ? listMarker(lines[i]!) : null;
        if (!next || next.ordered !== list.ordered || next.marker !== list.marker) break;
        blank = false;
      }
      nodes.push(list);
      continue;
    }
    // Paragraph.
    const para: string[] = [line.replace(/^ {0,3}/, "").trimEnd()];
    i++;
    // Slack lets an INDENTED list marker continue the paragraph (CommonMark
    // would start a list there); only one at the margin interrupts it.
    while (i < lines.length && !isBlankLine(lines[i]!) && !(interrupts(lines[i]!) && !(listMarker(lines[i]!) && /^ /.test(lines[i]!)))) {
      if (/^ {0,3}(=+|-+) *$/.test(lines[i]!)) throw new Unsupported("setext heading");
      if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i]!) && para.length === 1 && para[0]!.includes("|")) throw new Unsupported("table");
      para.push(lines[i++]!.replace(/^ +/, "").trimEnd());
    }
    nodes.push({ kind: "para", lines: para, blank });
    blank = false;
  }
  return nodes;
}

function skipBlank(lines: string[], i: number): number { while (i < lines.length && isBlankLine(lines[i]!)) i++; return i; }

function splitItem(body: string[]): Item {
  // The item's own text is its first paragraph; anything after (a nested
  // list, a second paragraph) is parsed as blocks of its own.
  let k = 0;
  while (k < body.length && !isBlankLine(body[k]!) && (k === 0 || !interrupts(body[k]!))) k++;
  const own = body.slice(0, k);
  const rest = body.slice(k);
  return { lines: own, children: rest.length ? parseBlocks(rest) : [] };
}

// --- Slack shape ------------------------------------------------------------

type Out = { blocks: Json[]; cur: Json[] };

function section(text: string): Record<string, Json> {
  return { type: "rich_text_section", elements: inlineToElements(text) as Json };
}

function appendNewlines(out: Out, nl: string, startNew = false): void {
  const last = out.cur[out.cur.length - 1] as Record<string, Json> | undefined;
  if (!startNew && last && last.type === "rich_text_section") {
    const els = last.elements as Inline[];
    const tail = els[els.length - 1];
    if (tail && tail.type === "text" && !tail.style) tail.text = String(tail.text) + nl;
    else els.push({ type: "text", text: nl });
    return;
  }
  out.cur.push({ type: "rich_text_section", elements: [{ type: "text", text: nl }] });
}

function emitList(out: Out, list: Extract<Node, { kind: "list" }>, depth: number, continued: boolean): void {
  const style = list.ordered ? "ordered" : "bullet";
  let run: Record<string, Json> | null = null;
  let first = !continued;
  for (const item of list.items) {
    if (!run) {
      run = { type: "rich_text_list", style, indent: depth, elements: [] };
      if (first && list.ordered && list.start !== 1) { run.offset = list.start - 1; }
      first = false;
      out.cur.push(run);
    }
    (run.elements as Json[]).push(section(item.lines.join("\n")));
    for (const child of item.children) {
      if (child.kind === "list") { emitList(out, child, depth + 1, false); run = null; }
      else throw new Unsupported("block inside a list item");
    }
  }
}

function emit(nodes: Node[]): Json[] {
  const out: Out = { blocks: [], cur: [] };
  const flushRich = () => { if (out.cur.length) { out.blocks.push({ type: "rich_text", elements: out.cur }); out.cur = []; } };
  let prev: Node | null = null;
  for (const n of nodes) {
    if (n.kind === "hr") {
      // Slack pads a divider that follows a list across a blank line.
      if (prev?.kind === "list" && n.blank) appendNewlines(out, "\n\n\n", true);
      flushRich();
      out.blocks.push({ type: "divider" });
      prev = n; continue;
    }
    const after = prev?.kind;
    if (n.kind === "para") {
      const text = n.lines.join("\n");
      if (after === "para") {
        appendNewlines(out, n.blank ? "\n\n" : "\n");
        const last = out.cur[out.cur.length - 1] as Record<string, Json>;
        (last.elements as Json[]).push(...(inlineToElements(text) as Json[]));
      } else {
        const sec = section(text);
        if (after && after !== "hr" && n.blank) (sec.elements as Inline[]).unshift({ type: "text", text: "\n" });
        out.cur.push(sec);
      }
    } else if (n.kind === "list") {
      if (after === "para" && n.blank) appendNewlines(out, "\n\n");
      else if (after && after !== "para" && after !== "hr" && n.blank) appendNewlines(out, "\n", true);
      emitList(out, n, 0, false);
    } else if (n.kind === "code") {
      if (after === "para" && n.blank) appendNewlines(out, "\n\n");
      out.cur.push({ type: "rich_text_preformatted", elements: [{ type: "text", text: n.text }] });
    } else if (n.kind === "quote") {
      if (after === "para" && n.blank) appendNewlines(out, "\n\n");
      out.cur.push({ type: "rich_text_quote", elements: inlineToElements(n.lines.join("\n")) as Json });
    }
    prev = n;
  }
  flushRich();
  for (const b of out.blocks) mergeTexts(b);
  return out.blocks;
}

/** Join neighbouring text runs of the same style — the pieces the emitter
 *  appends separately (`"a"`, `"\n\n"`, `"b"`) render as one. */
function mergeTexts(node: Json): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const els = (node as Record<string, Json>).elements;
  if (!Array.isArray(els)) return;
  const merged: Json[] = [];
  for (const e of els) {
    mergeTexts(e);
    const prev = merged[merged.length - 1] as Inline | undefined;
    const cur = e as Inline;
    if (prev && prev.type === "text" && cur.type === "text" && JSON.stringify(prev.style ?? null) === JSON.stringify(cur.style ?? null)) {
      prev.text = String(prev.text) + String(cur.text);
    } else merged.push(e);
  }
  (node as Record<string, Json>).elements = merged;
}

/** The `rich_text` blocks Slack's `markdown` block would render `md` as, or
 *  null when `md` uses something this does not model (then the caller keeps
 *  the `markdown` block — right rendering, flattened `.text`). */
export function markdownToRichText(md: string): Json[] | null {
  try {
    const nodes = parseBlocks(md.replace(/\r\n?/g, "\n").split("\n"));
    const blocks = emit(nodes);
    return blocks.length ? blocks : null;
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

// --- reading old messages -----------------------------------------------------

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
 *  (sent with a `markdown` block — see the top of this file). Slack replaced
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
