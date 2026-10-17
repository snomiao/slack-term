// Slack request verification and event trimming — no Cloudflare imports, so the
// tests run under bun. https://api.slack.com/authentication/verifying-requests-from-slack

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** `v0=` + HMAC-SHA256(secret, `v0:<timestamp>:<raw body>`), timestamp within 5 minutes. */
export async function verifySlackSignature(
  secret: string, timestamp: string | null, signature: string | null, rawBody: string, nowSec = Date.now() / 1000,
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`));
  return safeEqual(`v0=${hex(mac)}`, signature);
}

export type Wake = { channel: string; ts: string; thread_ts?: string };

/** The relay only needs to know *that* something happened where — it re-reads the
 *  message through the API — so no text, user or file data leaves the Worker. */
export function wakeFromEvent(payload: unknown): Wake | undefined {
  const p = payload as { type?: string; event?: Record<string, unknown> };
  if (p?.type !== "event_callback" || !p.event) return undefined;
  const e = p.event;
  if (e.type !== "message" && e.type !== "app_mention") return undefined;
  const channel = typeof e.channel === "string" ? e.channel : "";
  const ts = typeof e.ts === "string" ? e.ts : typeof e.event_ts === "string" ? e.event_ts : "";
  if (!channel || !ts) return undefined;
  const thread_ts = typeof e.thread_ts === "string" ? e.thread_ts : undefined;
  return { channel, ts, ...(thread_ts ? { thread_ts } : {}) };
}
