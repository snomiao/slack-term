// slack-term relay — a Cloudflare Worker that turns Slack's Events API into a
// resumable doorbell stream for `slack stream`.
//
//   Slack ──POST /slack/events──▶ Worker ──▶ Relay (Durable Object, SQLite)
//                                                 │  {seq, channel, ts, thread_ts}
//   slack stream ◀──GET /stream (SSE, bearer)─────┘
//
// Privacy: the relay stores and serves ids and timestamps only — never message
// text, never sender ids. A client that hears a bell reads the message itself
// through the Web API with its own token, so a forged or replayed bell costs at
// most one extra scan. Bells are deleted RETENTION_SEC after they arrive; that
// window only exists so a reconnecting client can resume from its last seq.
// Nothing here logs a request body.

import { DurableObject } from "cloudflare:workers";
import { type Doorbell, doorbellOf, MAX_BODY_BYTES, plausiblySigned, readLimited, safeEqual, verifySlack } from "./slack.ts";

export interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  /** Slack app → Basic Information → Signing Secret. */
  SLACK_SIGNING_SECRET: string;
  /** Bearer token every stream consumer presents. */
  RELAY_TOKEN: string;
  /** Optional: drop events from any other workspace. */
  SLACK_TEAM_ID?: string;
}

/** How long a bell is kept for resume. Longer gaps are covered by the client's
 *  catch-up poll, which runs on every (re)connect anyway. */
const RETENTION_SEC = 3600;
const KEEPALIVE_MS = 25_000;
const MAX_CLIENTS = 16;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const relay = env.RELAY.get(env.RELAY.idFromName("relay"));

    if (url.pathname === "/slack/events" && req.method === "POST") {
      const timestamp = req.headers.get("x-slack-request-timestamp");
      const signature = req.headers.get("x-slack-signature");
      // Reject before reading anything we would have to buffer.
      if (!plausiblySigned(timestamp, signature, Date.now() / 1000)) return new Response("bad signature", { status: 401 });
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return new Response("too large", { status: 413 });
      const body = await readLimited(req.body);
      if (body === null) return new Response("too large", { status: 413 });
      if (!await verifySlack(env.SLACK_SIGNING_SECRET, timestamp, signature, body, Date.now() / 1000)) {
        return new Response("bad signature", { status: 401 });
      }
      let payload: { type?: unknown; challenge?: unknown };
      try {
        payload = JSON.parse(body) as typeof payload;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (payload.type === "url_verification" && typeof payload.challenge === "string") {
        return new Response(payload.challenge, { headers: { "content-type": "text/plain" } });
      }
      const bell = doorbellOf(payload, env.SLACK_TEAM_ID || undefined);
      // A single SQLite insert: well inside Slack's 3 s ack budget. Retries of
      // the same event (x-slack-retry-num) collapse on (channel, ts).
      if (bell) await relay.ring(bell);
      return new Response(null, { status: 200 });
    }

    if (url.pathname === "/stream" || url.pathname === "/health") {
      if (!env.RELAY_TOKEN || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${env.RELAY_TOKEN}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return relay.fetch(req);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** `pending`: writes not yet taken by the consumer. A client that stops
 *  reading is cut off past MAX_PENDING instead of buffering without bound;
 *  it reconnects with ?after and gets the rest from storage. */
type Client = {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  pending: number;
  /** Still being fed its backlog from storage; live bells reach it that way. */
  replaying: boolean;
};
const MAX_PENDING = 64;
/** Backlog rows read and written per step of a replay. */
const REPLAY_BATCH = 100;
const enc = new TextEncoder();

export class Relay extends DurableObject<Env> {
  private clients = new Set<Client>();
  /** Names this storage. A client that saved a seq under another epoch is
   *  reading a reset relay, whose numbers mean something else now. */
  private readonly epoch: string;
  private keepalive: ReturnType<typeof setInterval> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS bells (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL, ts TEXT NOT NULL, thread_ts TEXT,
      at INTEGER NOT NULL,
      UNIQUE (channel, ts)
    )`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('epoch', ?)", crypto.randomUUID());
    this.epoch = ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'epoch'").one().v;
  }

  /** Store a bell (once per channel+ts) and push it to every live client. */
  async ring(bell: Doorbell): Promise<void> {
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec<{ seq: number }>(
      "INSERT OR IGNORE INTO bells (channel, ts, thread_ts, at) VALUES (?, ?, ?, ?) RETURNING seq",
      bell.channel, bell.ts, bell.thread_ts ?? null, now,
    ).toArray();
    const seq = rows[0]?.seq;
    if (seq === undefined) return; // a retry of a bell we already have
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + RETENTION_SEC * 1000);
    this.broadcast(frame(seq, bell));
  }

  /** TTL sweep: drop expired bells, re-arm while any remain. */
  override async alarm(): Promise<void> {
    const cutoff = Date.now() - RETENTION_SEC * 1000;
    this.ctx.storage.sql.exec("DELETE FROM bells WHERE at <= ?", cutoff);
    const next = this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM bells").one().at;
    if (next !== null) await this.ctx.storage.setAlarm(next + RETENTION_SEC * 1000);
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { oldest, latest } = this.bounds();
    if (url.pathname === "/health") {
      return Response.json({ ok: true, epoch: this.epoch, latest, oldest, clients: this.clients.size, retention_sec: RETENTION_SEC });
    }

    if (this.clients.size >= MAX_CLIENTS) return new Response("too many clients", { status: 503 });
    // Resume point: ?after=<seq> or the SSE Last-Event-ID header. Absent means
    // "from now". A seq we can no longer serve (expired, or from a relay whose
    // storage was reset) is a gap — the client must catch up by polling.
    const raw = url.searchParams.get("after") ?? req.headers.get("last-event-id");
    const after = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
    const epoch = url.searchParams.get("epoch");
    let from = latest;
    let gap = false;
    if (after !== null) {
      // Older than what is kept, or from the future (this relay's storage was
      // reset): either way say so, and replay everything still kept.
      const reset = after > latest || (epoch !== null && epoch !== this.epoch);
      gap = reset || (oldest !== null ? after < oldest - 1 : after < latest);
      from = reset ? 0 : after;
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const client: Client = { writer: writable.getWriter(), pending: 0, replaying: true };
    this.clients.add(client);
    this.keepalive ??= setInterval(() => this.broadcast(": ka\n\n"), KEEPALIVE_MS);
    void this.replay(client, from, `event: hello\ndata: ${JSON.stringify({ seq: from, gap, retention_sec: RETENTION_SEC, epoch: this.epoch })}\n\n`);

    return new Response(readable, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  private bounds(): { oldest: number | null; latest: number } {
    const b = this.ctx.storage.sql.exec<{ oldest: number | null }>("SELECT MIN(seq) AS oldest FROM bells").one();
    // sqlite_sequence remembers the high-water mark even after every row expired.
    const hw = this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'bells'").toArray();
    return { oldest: b.oldest, latest: hw[0]?.seq ?? 0 };
  }

  /** Feed a client its backlog in batches, each write awaited — a reader
   *  that stalls stalls only its own replay, holding one batch at most. A
   *  bell rung meanwhile is already stored, so the next batch picks it up;
   *  the switch to live happens right after a read that came back empty,
   *  with no await in between, so nothing falls between the two. */
  private async replay(c: Client, from: number, hello: string): Promise<void> {
    let chunk = hello;
    let cursor = from;
    for (;;) {
      const rows = this.ctx.storage.sql.exec<{ seq: number; channel: string; ts: string; thread_ts: string | null }>(
        "SELECT seq, channel, ts, thread_ts FROM bells WHERE seq > ? ORDER BY seq LIMIT ?", cursor, REPLAY_BATCH,
      ).toArray();
      for (const r of rows) {
        chunk += frame(r.seq, r.thread_ts ? { channel: r.channel, ts: r.ts, thread_ts: r.thread_ts } : { channel: r.channel, ts: r.ts });
        cursor = r.seq;
      }
      if (!rows.length) c.replaying = false;
      if (chunk) {
        try {
          await c.writer.write(enc.encode(chunk));
        } catch {
          return this.drop(c);
        }
      }
      if (!c.replaying || !this.clients.has(c)) return;
      chunk = "";
    }
  }

  private broadcast(chunk: string): void {
    for (const c of this.clients) if (!c.replaying) void this.send(c, chunk);
  }

  private async send(c: Client, chunk: string): Promise<void> {
    if (c.pending >= MAX_PENDING) return this.drop(c);
    c.pending++;
    try {
      await c.writer.write(enc.encode(chunk));
      c.pending--;
    } catch {
      this.drop(c);
    }
  }

  private drop(c: Client): void {
    if (!this.clients.delete(c)) return;
    c.writer.abort().catch(() => {});
    if (this.clients.size === 0 && this.keepalive !== undefined) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
  }
}

function frame(seq: number, bell: Doorbell): string {
  return `id: ${seq}\nevent: bell\ndata: ${JSON.stringify(bell)}\n\n`;
}
