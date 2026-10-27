# slack-term relay

A Cloudflare Worker that turns Slack's **Events API** into a resumable stream of
*doorbells* for `slack stream`. Slack posts each event to the Worker; the Worker
keeps only `{channel, ts, thread_ts}` and pushes it over a WebSocket (or, for
older clients, Server-Sent Events) to authenticated clients. Each client then
reads the message itself, with its own token.

```
Slack ──POST /slack/events──▶ Worker ──▶ Relay Durable Object (SQLite)
                                              │ seq  {channel, ts, thread_ts}
slack stream ◀──GET /ws (WebSocket, hibernating)┤
older clients ◀──GET /stream (SSE, Bearer)──────┘
```

## Cost: why WebSocket

A Durable Object is billed for **duration** while it is in memory, and an open
SSE response keeps it there for as long as a client is connected — all day,
for a stream that is idle most of the time. `/ws` instead uses the Durable
Object [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/):

- sockets are accepted with `ctx.acceptWebSocket()`, so between bells the object
  is evicted and not billed, while the connections stay open;
- the client's keepalive (`"ping"` every 25 s) is answered `"pong"` by the
  runtime (`setWebSocketAutoResponse`) **without waking the object**;
- all per-client state (resume position, acked position, replay/live, stall
  clock) lives in the socket's attachment (`serializeAttachment`), so it
  survives hibernation, and nothing waits on a timer.

The object wakes only for a Slack event, a client connecting, a client's ack
(sent within ~100 ms of the bells it acknowledges, while the object is still
awake from the event), or the hourly TTL alarm.

**SSE is kept for one release** so `slack stream` clients from before `/ws`
keep working against a redeployed relay. Each connected SSE client keeps the
object awake as before; `/health` shows `sse_clients` so you can see when none
are left, after which `/stream` can be removed. New clients try `/ws` first and
fall back to `/stream` for a connection only if the socket cannot be opened at
all (an older relay, a proxy that strips upgrades, a runtime without
`WebSocket`); `SLACK_RELAY_TRANSPORT=websocket|sse` pins one.

## Endpoints

| Path | Auth | What |
|---|---|---|
| `POST /slack/events` | Slack signing secret (`X-Slack-Signature`, ±5 min) | Answers `url_verification`; stores one bell per `message` / `app_mention` event. Acks with a single SQLite insert, well inside Slack's 3 s. Retries collapse on `(channel, ts)`. |
| `GET /ws?after=<seq>&epoch=<e>` | Subprotocols `slack-term-relay.v1` **and** `bearer.<base64url($RELAY_TOKEN)>` (or `Authorization: Bearer`) | WebSocket (below). Rejected with 401 before the upgrade is accepted. |
| `GET /stream?after=<seq>` | `Authorization: Bearer $RELAY_TOKEN` | SSE (kept for older clients). First an `event: hello` frame `{seq, gap, retention_sec}`, then the backlog after `seq`, then live `event: bell` frames (`id:` = seq). A keepalive comment goes out every 25 s. `Last-Event-ID` works as well as `?after`. Pass `&epoch=` from the last hello: the epoch names the relay's storage, so a client resuming against a reset relay is told `gap: true` and gets everything kept, even once the new numbers have passed its old seq. If `after` is omitted, the stream starts from now. `gap: true` means some bells after `after` are gone (expired, or the relay was reset): everything still kept is replayed, and the client should also catch up by polling. |
| `GET /health` | Bearer | `{epoch, latest, oldest, clients, websocket_clients, sse_clients, retention_sec}` |

At most 16 clients (both kinds) at once; more get 503.

### The WebSocket protocol (`/ws`)

**Auth.** The token is never put in the URL (query strings end up in logs).
Node's built-in `WebSocket` cannot send an `Authorization` header, so the client
offers two subprotocols — `Sec-WebSocket-Protocol: slack-term-relay.v1,
bearer.<base64url(token)>` (base64url because subprotocols must be HTTP tokens;
the same scheme Kubernetes uses) — and the Worker compares the bearer one in
constant time before the request reaches the Durable Object. The server
selects only `slack-term-relay.v1`, never echoing the token.

**Messages** are JSON text, one per frame:

- server → client: `{"type":"hello","seq","gap","retention_sec","epoch"}` first
  (same resume rules as SSE: `after`, `epoch`, `gap`); then
  `{"type":"bell","seq":n,"bell":{channel,ts,thread_ts?,self?}}` — the backlog
  after `seq`, then live bells; and `"pong"` (from the runtime).
- client → server: `"ping"` every 25 s; `{"type":"ack","seq":n}` for the highest
  bell received — at once after 32 unacked bells, else within 100 ms.

**Flow control** replaces SSE's write backpressure, which a WebSocket send
does not give: the backlog is replayed 100 bells at a time, each batch only
after the previous one is acked, and the switch to live happens right after a
storage read comes back empty (synchronously, so no bell falls in between). A
client is closed — and resumes from storage with `?after` — when it has 64 live
bells unacked (`4008 overflow`), makes no ack progress for 30 s while owing one
(`4009 stalled`), or neither pings nor acks for 90 s (`4010 silent`). These
checks run whenever the object is awake (an event, a connect, the alarm), since
a hibernating object runs no timers.

## Privacy

- **No message content is stored or served:** no text, no sender, no attachments.
  A bell holds a channel id and two timestamps — plus, on posts by **this app's own
  bot** only, `self`: that bot's user id. A client streaming as the bot never prints
  its own posts, so it skips the Web API read such a bell would cost (and, for
  `--replies-to`, learns from it that the bot is in the thread). No other sender
  is ever recorded.
- **Bells are deleted 1 hour after arrival** (`RETENTION_SEC`, enforced by a
  Durable Object alarm). That window exists only so a client can resume.
  Anything older is covered by the client's catch-up poll, except replies
  under a thread parent older than the client's `--thread-window`: the poll
  cannot find those, so a bell that expired before the client read it is lost.
- **Nothing logs a request body**, and Workers Logs are off (`observability`).
- **Token holders see activity metadata.** Anyone with `RELAY_TOKEN` can watch
  *when* and *where* messages are posted — channel ids, timestamps and thread
  structure, for every conversation the bot is in, **including DMs** with it —
  even though they never see text or senders. Treat the token like read access
  to that timing data: give it only to consumers you trust, and rotate it
  (`wrangler secret put RELAY_TOKEN`) when one should lose access.
- **A forged bell costs a few Web API reads at most:** one
  `conversations.replies` call, a few pages if needed, and up to 8 retries
  if the message is not found. The client applies its own filter to what
  Slack returns, so a forged bell never prints anything.

## Deploy

Wrangler 4 needs **Node ≥ 22**.

Cloudflare credentials, in the environment:

- `CLOUDFLARE_API_TOKEN` — a token with the **Workers Scripts: Edit** permission
  (the "Edit Cloudflare Workers" template).
- `CLOUDFLARE_ACCOUNT_ID` — from the dashboard sidebar.

```sh
cd worker
npx --yes wrangler@4.105.0 deploy
npx --yes wrangler@4.105.0 secret put SLACK_SIGNING_SECRET   # Slack app → Basic Information → Signing Secret
npx --yes wrangler@4.105.0 secret put RELAY_TOKEN            # long random string, shared with consumers (e.g. openssl rand -hex 32)
npx --yes wrangler@4.105.0 secret put SLACK_TEAM_ID          # optional: accept one workspace only (T…)
```

Redeploying an existing relay keeps its storage (and epoch): no migration is
needed, the Durable Object class is unchanged. A deploy restarts the object,
which drops every connection; clients reconnect and resume from their last seq.

Check it (expects `{"ok":true,…}`):

```sh
curl -H "Authorization: Bearer $RELAY_TOKEN" https://<worker>/health
```

Then, in the Slack app:

1. Go to **Event Subscriptions** and turn on **Enable Events**.
2. Set the **Request URL** to `https://<worker>/slack/events`. It should verify at once.
3. Under **Subscribe to bot events**, add:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `app_mention`
   - `message.mpim`, only if the bot has `mpim:history`.
   Each needs its bot scope (`channels:history`, `groups:history`, `im:history`,
   `app_mentions:read`); Slack offers to add them.
4. Click **Save**, then reinstall the app if Slack asks.

The secrets must be in place first: Slack's URL verification is signed.

Consumers set `SLACK_RELAY_URL=https://<worker>` and `SLACK_RELAY_TOKEN=…`
(the same value as the `RELAY_TOKEN` secret). `slack stream` then uses the relay
automatically and says so on stderr: `relay connected (websocket)` — or
`(sse)` if it fell back. Optional: `SLACK_RELAY_TRANSPORT=websocket` or `sse`.

## Develop

```sh
cd worker && bun install && bun run typecheck
# or, from the repo root (what CI runs):
bun run typecheck:worker
```

The signature and event parsing live in `src/slack.ts`, and the WebSocket
session logic (replay, acks, flow control, auth) in `src/hub.ts`; neither has
Cloudflare types, and the CLI suite tests both (`tests/relay.test.ts`,
`tests/relay-hub.test.ts`, `tests/relay-ws.test.ts`).

To run the Worker locally (Node ≥ 22; on an older Node,
`npx -y -p node@22 -- …` works):

```sh
cd worker
printf 'SLACK_SIGNING_SECRET=dev\nRELAY_TOKEN=dev\n' > .dev.vars   # git-ignored
npx --yes wrangler@4.105.0 dev --local
```
