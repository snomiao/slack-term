// Pure Slack-side logic for the relay Worker: request signing and turning an
// Events API payload into a doorbell. No Cloudflare types here, so the CLI's
// test suite can exercise it under bun.

/** What the relay keeps and serves: WHERE something happened, never what was
 *  said. A client that hears a doorbell reads the message itself, through the
 *  Slack Web API, with its own token — so the relay holds no message content. */
export type Doorbell = { channel: string; ts: string; thread_ts?: string };

/** Slack rejects replays older than five minutes; so do we. */
export const MAX_SKEW_SEC = 300;

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (both sides are ours to length-check). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Verify X-Slack-Signature: v0=HMAC-SHA256(secret, "v0:{timestamp}:{raw body}").
 *  https://api.slack.com/authentication/verifying-requests-from-slack */
export async function verifySlack(
  secret: string, timestamp: string | null, signature: string | null, body: string, nowSec: number,
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > MAX_SKEW_SEC) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`));
  return safeEqual(`v0=${hex(mac)}`, signature);
}

// Housekeeping that is never a person talking. message_changed is dropped too:
// `slack stream` does not re-emit edits, so ringing for one would only cost a scan.
const SKIP_SUBTYPES = new Set([
  "message_changed", "message_deleted", "channel_join", "channel_leave", "group_join", "group_leave",
  "channel_topic", "channel_purpose", "channel_name", "pinned_item", "unpinned_item",
  // A hidden update to a thread parent: its outer ts names the update, not a
  // message — the reply itself arrives as its own event.
  "message_replied",
]);

const TS = /^\d{6,}\.\d{1,9}$/;
const CHANNEL = /^[CDG][A-Z0-9]{2,}$/;

/** The doorbell for one event_callback, or null when there is nothing to ring
 *  for. Only ids and timestamps survive this function. */
export function doorbellOf(payload: unknown, teamId?: string): Doorbell | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { type?: unknown; team_id?: unknown; event?: Record<string, unknown> };
  if (p.type !== "event_callback" || !p.event || typeof p.event !== "object") return null;
  if (teamId && p.team_id !== teamId) return null;
  const e = p.event;
  if (e.type !== "message" && e.type !== "app_mention") return null;
  if (typeof e.subtype === "string" && SKIP_SUBTYPES.has(e.subtype)) return null;
  if (e.hidden === true) return null;
  const { channel, ts, thread_ts } = e;
  if (typeof channel !== "string" || !CHANNEL.test(channel)) return null;
  if (typeof ts !== "string" || !TS.test(ts)) return null;
  return typeof thread_ts === "string" && TS.test(thread_ts) && thread_ts !== ts
    ? { channel, ts, thread_ts }
    : { channel, ts };
}
