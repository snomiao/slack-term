# slack — Slack CLI

A lightweight Slack CLI for quick workspace interaction from the terminal.
Two implementations — **TypeScript** (bun-first, published to npm) and **Rust**
(native binary, `cargo install`) — share one command surface and are verified
byte-for-byte by [`tests/parity.sh`](tests/parity.sh).

## Features

- **News** — Activity feed showing recent mentions (`to:me`), grouped by day with human-readable timestamps
- **Messages** — Browse recent messages across joined channels
- **Tail** — Stream new messages from a channel in real time (like `tail -f`)
- **Search** — Full-text search across the workspace
- **Send** — Send messages to channels, DMs, or threads with a confirm-hash safety gate (prevents accidental sends); targeting a message permalink replies in that message's thread
- **Edit / Delete** — Rewrite or remove a sent message, guarded by the same confirm-hash gate
- **React** — Add or remove an emoji reaction — a lightweight ack that doesn't grow the thread
- **Dump** — Bulk-export channel history as markdown

### Output formatting

- DM channels display as `@DisplayName`, public channels as `#channel-name`
- Slack `<@UID>` mention tokens are resolved to display names
- Slack `<!date^...>` markup is rendered as human-readable dates
- Messages are grouped by day (Today / Yesterday / weekday)

## Installation

### TypeScript (npm, recommended)

One package, no native binaries, any platform with Node 18+.

```sh
npm install -g slack-term
# or: bun add -g slack-term  |  pnpm add -g slack-term
```

> **Note:** Previously published as `@snomiao/slack` (now deprecated).

### Rust (cargo)

```sh
cargo install --path rs
```

Both expose the same `slack` command.

## Usage

```sh
# Activity feed (mentions directed to you)
slack news
slack news --limit 5

# Recent messages across joined channels
slack msgs

# Search messages
slack search "deploy"
slack search "deploy" --count 50

# Send a message (two-step confirm — quote #channel)
slack send "#general" "Hello team"
# Prints a destination preview + confirm code; rerun with --code=<code> to actually send
slack send "#general" "Hello team" --code=<code>

# Reply in a thread — #chan:<thread_ts>, or just paste a message permalink
slack send "#general:1700000000.000100" "Replying in thread"
slack send "https://acme.slack.com/archives/C0123456789/p1700000000000100" "Replying in thread"

# @handle tokens are auto-converted to real <@USERID> mentions (on by default; also on `edit`).
# Resolves via users.list, then the channel's members so Slack Connect guests work;
# any handle that can't be resolved is left as plain text. The confirm preview shows
# the converted message before sending. Use --no-mentions to keep @text literal.
slack send "#general" "thanks @t.matsuda19790127 and @taku"
slack send "#general" "ping @ops on call" --no-mentions   # leave @ops as plain text

# Edit or delete a sent message (same confirm-code gate)
slack edit "<permalink>" "fixed wording"
slack delete "<permalink>"

# React instead of replying for a simple ack — keeps the thread tidy (no confirm gate)
# 👀 seen  ✅ done  ⏳ working on it — target is the #chan:<ts> / permalink form
slack react "#general:1700000000.000100" white_check_mark
slack react "<permalink>" eyes --remove   # take a reaction back

# Bulk export channel history
slack dump --days 7 --filter eng

# Stream new messages in real time (Ctrl-C to stop)
slack tail "#general"
slack tail "#general" --since=10m   # backfill last 10 minutes first
slack tail "#general" --thread=<ts> # follow a single thread
slack tail "#general" --me          # only messages that mention you
slack tail "@bob" --exit-on-message --timeout 30m   # wait for a reply, then exit
```

### tail — real-time message stream

`slack tail` polls a channel every 3 seconds (configurable via `--interval`) and
prints new messages as they arrive, in the same `[ts]  @handle:  text` format as
the `read` command.

```sh
slack tail "#symval"               # follow new messages from now
slack tail "#symval" --since=30m   # backfill 30 minutes, then stream
slack tail "#symval" --thread=1700000000.000100   # one thread only
slack tail "#symval" --me          # only messages mentioning you
```

For automation, `--exit-on-message` stops as soon as the first message from
**someone else** arrives (your own posts are ignored), and `--timeout <dur>`
(e.g. `30m`, `2h`) auto-stops after the deadline with exit code 0. Together they
make a "wait for a reply, then act" primitive that won't hang:

```sh
slack tail "@matsuda" --exit-on-message --timeout 30m --interval 15000
```

**Note:** Cross-channel mention streaming (`--me` without a target) is not yet
supported — a target channel is required.

## Configuration

Requires a Slack user token (`xoxp-...`) with the following scopes:

- `search:read` — for search and news
- `channels:history`, `groups:history`, `im:history`, `mpim:history` — for message history
- `channels:read`, `groups:read`, `im:read`, `mpim:read` — for channel listing
- `users:read` — for resolving display names
- `chat:write` — for sending messages

Set the token via environment variable:

```sh
export SLACK_MCP_XOXP_TOKEN=xoxp-...
```

Or place it in `~/.config/slack-cli/.env` or a local `.env` file.

See [`SKILL.md`](SKILL.md) for a full token-acquisition walkthrough.

## Development

```sh
# TypeScript
bun install
bun run dev -- news --limit 3      # run straight from source
bun run typecheck
bun run build                      # produces dist/cli.js

# Rust
cargo run --manifest-path rs/Cargo.toml --release --bin slack -- news --limit 3

# Parity test (requires a token — compares Rust and TS stdout)
bun run test:parity
```

## Dependencies

**TypeScript impl** — zero runtime deps; uses built-in `fetch`, `node:crypto`,
`node:util` argument parsing.

**Rust impl**

- [clap](https://crates.io/crates/clap) — CLI argument parsing
- [reqwest](https://crates.io/crates/reqwest) — HTTP client for Slack Web API
- [tokio](https://crates.io/crates/tokio) — async runtime
- [chrono](https://crates.io/crates/chrono) — date/time formatting
- [ring](https://crates.io/crates/ring) — SHA-256 for confirm hashes

## Release notes

### v0.x — 2026-05-15: `slack tail`

New `tail` subcommand streams channel messages in real time using poll-based
delivery (3-second interval). Supports `--since=<duration>` for backfill,
`--thread=<ts>` to follow a single thread, and `--me` to filter for messages
that mention you. Uses `conversations.history?oldest=<ts>` as a cursor so
already-seen messages are never re-printed, even across reconnects.

## Related / prior art

- [`slkcli`](https://www.npmjs.com/package/slkcli) by
  [@therohitdas](https://github.com/therohitdas) — a macOS-only Node CLI that
  auto-extracts `xoxc-` session tokens from the Slack desktop app. Different
  tradeoffs (zero-config on macOS vs. our cross-platform explicit-token
  approach). See [`docs/comparison-slkcli.md`](docs/comparison-slkcli.md) for
  a full UX side-by-side.
- [`docs/ecosystem.md`](docs/ecosystem.md) — survey of other terminal Slack
  tools (official, `slack-term`, `wee-slack`, `slackcat`, `slackdump`, …).

## License

MIT
