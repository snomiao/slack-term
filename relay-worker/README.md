# relay-worker — realtime wake-ups for `bun run relay`

Slack Events API → this Cloudflare Worker → a Durable Object → an outbound
WebSocket held by the local relay. The Mac opens no port. A frame carries only
`{channel, ts, thread_ts}` — no text or user data — and merely ends the relay's
poll sleep early; reading, owner filtering and dedupe stay in the relay, and
polling remains the fallback whenever the socket is down.

```sh
cd relay-worker
bunx wrangler@4 deploy
bunx wrangler@4 secret put SLACK_SIGNING_SECRET   # app → Basic Information → Signing Secret
bunx wrangler@4 secret put RELAY_KEY              # same value as RELAY_STREAM_KEY below
```

Slack app → Event Subscriptions: Request URL `https://<worker>/slack/events`,
bot events `message.channels` (+ `message.groups` for private channels).

Relay side (outside the repo): `~/.config/slack-cli/relay-stream.env` holds
`RELAY_STREAM_KEY=…` (0600), and `relay.json` gets
`"stream": "wss://<worker>/stream"`.

Alternative without a public URL: Slack Socket Mode (an app-level `xapp-` token,
`apps.connections.open`) gives the same realtime delivery straight to the Mac.
