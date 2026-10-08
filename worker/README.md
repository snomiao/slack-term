# slack-term relay

A Cloudflare Worker that turns Slack's **Events API** into a resumable stream of
*doorbells* for `slack stream`. Slack posts each event to the Worker; the Worker
keeps only `{channel, ts, thread_ts}` and pushes it over Server-Sent Events to
authenticated clients. Each client then reads the message itself, with its own
token.

```
Slack ──POST /slack/events──▶ Worker ──▶ Relay Durable Object (SQLite)
                                              │ id: <seq>  {channel, ts, thread_ts}
slack stream ◀──GET /stream (SSE, Bearer)─────┘
```

## Endpoints

| Path | Auth | What |
|---|---|---|
| `POST /slack/events` | Slack signing secret (`X-Slack-Signature`, ±5 min) | Answers `url_verification`; stores one bell per `message` / `app_mention` event. Acks with a single SQLite insert, well inside Slack's 3 s. Retries collapse on `(channel, ts)`. |
| `GET /stream?after=<seq>` | `Authorization: Bearer $RELAY_TOKEN` | SSE. First an `event: hello` frame `{seq, gap, retention_sec}`, then the backlog after `seq`, then live `event: bell` frames (`id:` = seq). A keepalive comment goes out every 25 s. `Last-Event-ID` works as well as `?after`. Pass `&epoch=` from the last hello: the epoch names the relay's storage, so a client resuming against a reset relay is told `gap: true` and gets everything kept, even once the new numbers have passed its old seq. If `after` is omitted, the stream starts from now. `gap: true` means some bells after `after` are gone (expired, or the relay was reset): everything still kept is replayed, and the client should also catch up by polling. |
| `GET /health` | Bearer | `{epoch, latest, oldest, clients, retention_sec}` |

## Privacy

- **No message content is stored or served:** no text, no sender, no attachments.
  A bell holds a channel id and two timestamps.
- **Bells are deleted 1 hour after arrival** (`RETENTION_SEC`, enforced by a
  Durable Object alarm). That window exists only so a client can resume.
  Anything older is covered by the client's catch-up poll, except replies
  under a thread parent older than the client's `--thread-window`: the poll
  cannot find those, so a bell that expired before the client read it is lost.
- **Nothing logs a request body**, and Workers Logs are off (`observability`).
- **A forged bell costs a few Web API reads at most:** one
  `conversations.replies` call, a few pages if needed, and up to 8 retries
  if the message is not found. The client applies its own filter to what
  Slack returns, so a forged bell never prints anything.

## Deploy

```sh
cd worker
npx --yes wrangler@4.105.0 deploy           # needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
npx --yes wrangler@4.105.0 secret put SLACK_SIGNING_SECRET   # Slack app → Basic Information
npx --yes wrangler@4.105.0 secret put RELAY_TOKEN            # long random string, shared with consumers
npx --yes wrangler@4.105.0 secret put SLACK_TEAM_ID          # optional: accept one workspace only
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
4. Click **Save**, then reinstall the app if Slack asks.

Consumers set `SLACK_RELAY_URL=https://<worker>` and `SLACK_RELAY_TOKEN=…`.
`slack stream` then uses the relay automatically.

## Develop

```sh
cd worker && bun install && bun run typecheck
```

The signature and event parsing live in `src/slack.ts`, which has no Cloudflare
types. The CLI suite tests it (`tests/relay.test.ts`).
