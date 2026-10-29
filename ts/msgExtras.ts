// What a message carries beyond its `text`: files, forwarded (shared) messages,
// link previews, other attachments, and blocks that are more than the text.
//
// Slack keeps a forwarded message in `attachments`, not in `text`. Rendering only
// `text` showed "hmmm, fix it" for a message that forwarded the actual request,
// and the reader (an agent) acted on the comment without the thing it referred to.
// Dropping content silently is the failure; every extra is at least named here.

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Rec = Record<string, Json>;

const rec = (v: Json | undefined): Rec => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** One line per extra, each starting with its marker; indent is the caller's. */
export function messageExtras(m: Rec): string[] {
  const out: string[] = [];
  for (const fv of arr(m.files)) {
    const f = rec(fv);
    const name = str(f.name) || str(f.title) || "(file)";
    const type = str(f.filetype) || str(f.mimetype);
    const sz = typeof f.size === "number" ? `, ${fmtSize(f.size)}` : "";
    const id = str(f.id) ? `  [${str(f.id)}]` : "";
    out.push(`📎 ${name}${type || sz ? `  (${[type, sz.slice(2)].filter(Boolean).join(", ")})` : ""}${id}`);
  }
  for (const av of arr(m.attachments)) {
    const a = rec(av);
    const body = str(a.text) || str(a.fallback);
    if (a.is_share === true || a.is_msg_unfurl === true) {
      const who = str(a.author_name) || str(a.author_subname) || str(a.author_id) || "someone";
      const link = str(a.from_url) || [str(a.channel_id), str(a.ts)].filter(Boolean).join(" ");
      out.push(`↪ forwarded message from @${who}${link ? `  ${link}` : ""}`);
      for (const l of body.split("\n")) out.push(`  > ${l}`);
      for (const fv of arr(a.files)) out.push(`  📎 ${str(rec(fv).name) || str(rec(fv).title) || "(file)"}`);
    } else if (str(a.from_url) || str(a.original_url) || str(a.title_link)) {
      const url = str(a.original_url) || str(a.from_url) || str(a.title_link);
      const title = str(a.title) || str(a.service_name);
      out.push(`🔗 ${title ? `${title} — ` : ""}${url}`);
    } else {
      const head = str(a.pretext) || str(a.title) || body || str(a.fallback);
      out.push(`📎 attachment${head ? `: ${head.split("\n")[0]}` : ""}`);
    }
  }
  // Blocks: rich_text is the message text itself; anything else (sections, images,
  // buttons, ...) is named, not dropped.
  const other = arr(m.blocks).map(rec).filter((b) => str(b.type) !== "rich_text").map((b) => str(b.type) || "?");
  if (other.length) {
    const counts = new Map<string, number>();
    for (const t of other) counts.set(t, (counts.get(t) ?? 0) + 1);
    const kinds = [...counts].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", ");
    out.push(`▦ ${other.length} more block${other.length > 1 ? "s" : ""} (${kinds}) — see --json blocks`);
  }
  return out;
}
