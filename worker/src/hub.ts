// The relay's WebSocket side, as pure logic: no Cloudflare types, so the CLI's
// test suite exercises it under bun with fake sockets (tests/relay-hub.test.ts).
// index.ts adapts a hibernatable WebSocket to `Sock` and SQLite to `Store`.
//
// Why WebSocket: an open SSE response keeps the Durable Object in memory — and
// billed for duration — for as long as any client is connected. A socket
// accepted with ctx.acceptWebSocket() lets the object hibernate between bells,
// and the client's keepalive ("ping" → "pong") is answered by the runtime
// without waking it. Everything this module remembers about a client
// therefore lives in the socket's attachment, which survives hibernation;
// nothing lives in memory, and nothing waits on a timer.
//
// The guarantees are those of the SSE path:
//   - hello first: {seq, gap, retention_sec, epoch}, from the same resume rules;
//   - then the backlog after seq, read from storage in REPLAY_BATCH steps, and
//     only then live bells — the switch happens right after a read that came
//     back empty, synchronously, so a bell rung meanwhile is never lost: it is
//     either in storage for the next read or delivered live;
//   - a client that stops taking bells is cut off, not buffered for without
//     bound. SSE learned that from write backpressure; a WebSocket send gives
//     none, so the client acks ({"type":"ack","seq":n}) what it has received.
//     A replay step waits for the ack of the previous one (one batch in flight
//     at most); live bells are cut off past MAX_PENDING unacked; a client that
//     leaves a send unacked for STALL_MS, or stops pinging for DEAD_MS, is
//     closed. Closed clients reconnect with ?after and get the rest from storage.

import { type Doorbell as Bell, safeEqual } from "./slack.ts";

export type { Bell };
export type Row = { seq: number; channel: string; ts: string; thread_ts: string | null; self: string | null };
export type Hello = { seq: number; gap: boolean; retention_sec: number; epoch: string };

/** Per-socket state, kept with serializeAttachment (2 KiB max; this is ~100 B). */
export type Attachment = {
  /** Highest seq sent to this client (its resume point, at the start). */
  sent: number;
  /** Highest seq the client has acked. */
  acked: number;
  /** Still being fed its backlog from storage; live bells reach it that way. */
  replaying: boolean;
  /** Since when (ms) the client owes an ack without having made progress;
   *  0 while nothing is unacked. */
  waitSince: number;
  /** Last message from the client (ms): connect, or an ack. */
  lastSeen: number;
};

export interface Sock {
  send(data: string): void;
  close(code: number, reason: string): void;
  attachment(): Attachment | null;
  setAttachment(a: Attachment): void;
  /** Last runtime-answered "ping" (ms since epoch), null if none yet. */
  lastPing(): number | null;
}

export interface Store {
  rowsAfter(seq: number, limit: number): Row[];
}

/** The subprotocol a client must offer; the server echoes it back. */
export const PROTOCOL = "slack-term-relay.v1";
/** The other offered subprotocol carries the bearer: `bearer.<base64url(token)>`.
 *  A header, not the URL: query strings end up in logs. */
export const BEARER_PREFIX = "bearer.";
/** Backlog rows sent per replay step. */
export const REPLAY_BATCH = 100;
/** Live bells a client may have unacked before it is cut off. */
export const MAX_PENDING = 64;
/** An unacked send older than this frees the client's slot. */
export const STALL_MS = 30_000;
/** Clients ping every 25 s; one silent for this long is gone. */
export const DEAD_MS = 90_000;
/** Close codes (4000–4999: application-defined). */
export const CLOSE_OVERFLOW = 4008;
export const CLOSE_STALLED = 4009;
export const CLOSE_GONE = 4010;

export function base64url(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Does a Sec-WebSocket-Protocol header offer our protocol and this token?
 *  Every offered entry is compared, so timing does not reveal which matched. */
export function protocolAuthorized(header: string | null, token: string): boolean {
  if (!header || !token) return false;
  const want = BEARER_PREFIX + base64url(token);
  let ok = false;
  let ours = false;
  for (const p of header.split(",")) {
    const v = p.trim();
    if (v === PROTOCOL) ours = true;
    if (safeEqual(v, want)) ok = true;
  }
  return ok && ours;
}

/** Where a (re)connecting client starts, from ?after (or Last-Event-ID) and
 *  ?epoch. Absent `after` means "from now". A seq we can no longer serve —
 *  expired, or from a relay whose storage was reset (a different epoch, or a
 *  number past our high-water mark) — is a gap: everything kept is replayed
 *  and the client must also catch up by polling. */
export function resumePoint(
  rawAfter: string | null, clientEpoch: string | null, epoch: string, oldest: number | null, latest: number,
): { from: number; gap: boolean } {
  const after = rawAfter !== null && /^\d+$/.test(rawAfter) ? Number(rawAfter) : null;
  if (after === null) return { from: latest, gap: false };
  const reset = after > latest || (clientEpoch !== null && clientEpoch !== epoch);
  const gap = reset || (oldest !== null ? after < oldest - 1 : after < latest);
  return { from: reset ? 0 : after, gap };
}

export function bellOf(r: Row): Bell {
  return {
    channel: r.channel, ts: r.ts,
    ...(r.thread_ts ? { thread_ts: r.thread_ts } : {}),
    ...(r.self ? { self: r.self } : {}),
  };
}

const bellMsg = (seq: number, b: Bell): string => JSON.stringify({ type: "bell", seq, bell: b });

function trySend(s: Sock, data: string): boolean {
  try {
    s.send(data);
    return true;
  } catch {
    s.close(1011, "send failed");
    return false;
  }
}

/** One replay step: the next batch after `a.sent`, or — when that read comes
 *  back empty — the switch to live. Synchronous from read to switch. */
function step(s: Sock, a: Attachment, store: Store, now: number, prefix?: string): void {
  if (prefix !== undefined && !trySend(s, prefix)) return;
  const rows = store.rowsAfter(a.sent, REPLAY_BATCH);
  for (const r of rows) {
    if (!trySend(s, bellMsg(r.seq, bellOf(r)))) return;
    a.sent = r.seq;
  }
  if (!rows.length) a.replaying = false;
  else if (!a.waitSince) a.waitSince = now;
  s.setAttachment(a);
}

/** A newly accepted socket: hello, then the first replay step. */
export function open(s: Sock, from: number, hello: Hello, store: Store, now: number): void {
  const a: Attachment = { sent: from, acked: from, replaying: true, waitSince: 0, lastSeen: now };
  step(s, a, store, now, JSON.stringify({ type: "hello", ...hello }));
}

/** A message from the client. Only acks mean anything; the rest is ignored. */
export function message(s: Sock, data: string | ArrayBuffer, store: Store, now: number): void {
  const a = s.attachment();
  if (!a) return s.close(1011, "no session");
  a.lastSeen = now;
  let seq: unknown;
  if (typeof data === "string" && data.length <= 200) {
    try {
      const m = JSON.parse(data) as { type?: unknown; seq?: unknown };
      if (m && m.type === "ack") seq = m.seq;
    } catch { /* not JSON: ignored */ }
  }
  if (typeof seq === "number" && Number.isSafeInteger(seq)) {
    const acked = Math.min(seq, a.sent);
    // Progress restarts the stall clock: "stalled" means no ack progress for
    // STALL_MS while something is unacked, not a long busy stretch.
    if (acked > a.acked) a.waitSince = acked >= a.sent ? 0 : now;
    a.acked = Math.max(a.acked, acked);
  }
  if (a.replaying && a.acked >= a.sent) return step(s, a, store, now);
  s.setAttachment(a);
}

/** Close clients that stalled or went silent; return the rest. */
export function sweep<S extends Sock>(socks: Iterable<S>, now: number): S[] {
  const live: S[] = [];
  for (const s of socks) {
    const a = s.attachment();
    if (!a) { s.close(1011, "no session"); continue; }
    if (a.waitSince && now - a.waitSince > STALL_MS) { s.close(CLOSE_STALLED, "stalled"); continue; }
    if (now - Math.max(a.lastSeen, s.lastPing() ?? 0) > DEAD_MS) { s.close(CLOSE_GONE, "silent"); continue; }
    live.push(s);
  }
  return live;
}

/** A new bell, already stored as `seq`: push it to every live client. */
export function deliver(socks: Iterable<Sock>, seq: number, bell: Bell, now: number): void {
  const msg = bellMsg(seq, bell);
  for (const s of sweep(socks, now)) {
    const a = s.attachment()!;
    if (a.replaying || seq <= a.sent) continue; // storage gets it to a replaying client
    if (a.sent - a.acked >= MAX_PENDING) { s.close(CLOSE_OVERFLOW, "overflow"); continue; }
    if (!trySend(s, msg)) continue;
    if (!a.waitSince) a.waitSince = now;
    a.sent = seq;
    s.setAttachment(a);
  }
}
