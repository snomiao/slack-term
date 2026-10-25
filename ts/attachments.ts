// Message attachments — forwarded/shared messages and legacy bot attachments.
//
// A message forwarded with Slack's "Forward" (or shared via its link) arrives
// as an ordinary message whose own `text` is only the comment typed with it;
// the forwarded message itself lives in `attachments[]`, flagged `is_share`
// (or `is_msg_unfurl` for a pasted message link), carrying the original
// author, channel, ts, text and permalink (`from_url`). Older shares put the
// text in `message_blocks[].message` instead, with `fallback` as the summary.
// Plain link unfurls (`original_url` set) are previews of a web page, not
// content anyone wrote, so the text view leaves them out.

import type { Json } from "./slack.ts";

const rec = (v: Json | undefined): Record<string, Json> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {};
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

export type Attachment = {
  /** A forwarded/shared Slack message (as opposed to a bot or link attachment). */
  shared: boolean;
  /** A web-page link preview — omitted from the text view. */
  unfurl: boolean;
  author_id: string | null;
  author_name: string | null;
  channel_id: string | null;
  ts: string | null;
  title: string | null;
  text: string;
  permalink: string | null;
};

// Older shares carry the text only inside message_blocks[].message.text.
function messageBlocksText(a: Record<string, Json>): string {
  const blocks = Array.isArray(a.message_blocks) ? a.message_blocks : [];
  return blocks.map((b) => str(rec(rec(b).message).text)).filter(Boolean).join("\n");
}

export function parseAttachments(m: Record<string, Json>): Attachment[] {
  const list = Array.isArray(m.attachments) ? m.attachments : [];
  return list.map(rec).map((a) => {
    const shared = a.is_share === true || a.is_msg_unfurl === true || Array.isArray(a.message_blocks);
    const mb = rec(rec((Array.isArray(a.message_blocks) ? a.message_blocks : [])[0]));
    return {
      shared,
      unfurl: !shared && !!str(a.original_url),
      author_id: str(a.author_id) || str(rec(mb.message).user) || null,
      author_name: str(a.author_name) || null,
      channel_id: str(a.channel_id) || str(mb.channel) || null,
      ts: str(a.ts) || str(mb.ts) || null,
      title: str(a.title) || null,
      text: str(a.text) || messageBlocksText(a) || str(a.pretext) || str(a.fallback),
      permalink: str(a.from_url) || str(a.title_link) || str(a.original_url) || null,
    };
  });
}

/** The text-view lines for a message's attachments (each starts with "\n   "). */
export function attachmentLines(atts: Attachment[], tsLabel: (ts: string) => string): string {
  return atts
    .filter((a) => !a.unfurl && (a.text || a.title))
    .map((a) => {
      const who = a.author_name ?? a.author_id;
      const head = a.shared
        ? `↪ shared message${who ? ` from @${who}` : ""}${a.channel_id ? ` in <#${a.channel_id}>` : ""}${a.ts ? ` · ${tsLabel(a.ts)}` : ""}`
        : `▸ ${a.title ?? "attachment"}`;
      const lines = a.text ? a.text.replace(/\n+$/, "").split("\n").map((l) => `\n     │ ${l}`).join("") : "";
      const link = a.permalink ? `\n     ${a.permalink}` : "";
      return `\n   ${head}${lines}${link}`;
    })
    .join("");
}
