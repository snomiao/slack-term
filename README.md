# slack — Slack CLI

A lightweight Slack CLI for quick workspace interaction from the terminal.
Two implementations — **TypeScript** (bun-first, published to npm) and **Rust**
(native binary, `cargo install`) — share one command surface and are verified
byte-for-byte by [`tests/parity.sh`](tests/parity.sh).

## Features

- **News** — Activity feed showing recent mentions (`to:me`), grouped by day with human-readable timestamps
- **Messages** — Browse recent messages across joined channels
- **Search** — Full-text search across the workspace
- **Send** — Send messages to channels or DMs with a confirm-hash safety gate (prevents accidental sends)
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
npm install -g @snomiao/slack
# or: bun add -g @snomiao/slack  |  pnpm add -g @snomiao/slack
```

### Rust (cargo)

```sh
cargo install --path .
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
# Prints preview + confirm hash; rerun with --confirm=<hash> to actually send
slack send "#general" "Hello team" --confirm=<hash>

# Bulk export channel history
slack dump --days 7 --filter eng
```

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

Or place it in `~/.config/slack-cli/.env.local` or a local `.env` file.

See [`SKILL.md`](SKILL.md) for a full token-acquisition walkthrough.

## Development

```sh
# TypeScript
bun install
bun run dev -- news --limit 3      # run straight from source
bun run typecheck
bun run build                      # produces dist/cli.js

# Rust
cargo run --release --bin slack -- news --limit 3

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
