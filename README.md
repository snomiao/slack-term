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
slack send "#general" "thanks @t.yamada19850101 and @alice"
slack send "#general" "ping @ops on call" --no-mentions   # leave @ops as plain text

# Edit or delete a sent message (same confirm-code gate)
slack edit "<permalink>" "fixed wording"
slack delete "<permalink>"

# React instead of replying for a simple ack — keeps the thread tidy (no confirm gate)
# 👀 seen  ✅ done  ⏳ working on it — target is the #chan:<ts> / permalink form
slack react "#general:1700000000.000100" white_check_mark
slack react "<permalink>" eyes --remove   # take a reaction back

# Task tracking on top of reactions — :pushpin: marks a message as a task,
# a second reaction carries its progress (see "todo" below)
slack todo ls                                  # my open tasks
slack todo ls --state untriaged --in "#general"
slack todo set "#general:1700000000.000100" doing
slack todo flag "<permalink>" blocked
slack todo doctor --in "#general"              # find messages stuck in two states

# Bulk export channel history
slack dump --days 7 --filter eng

# Stream new messages in real time (Ctrl-C to stop)
slack tail "#general"
slack tail "#general" --since=10m   # backfill last 10 minutes first
slack tail "#general" --thread=<ts> # follow a single thread
slack tail "#general" --me          # only messages that mention you
slack tail "@bob" --exit-on-message --timeout 30m   # wait for a reply, then exit
```

### todo — task tracking on reactions

Tasks are just messages. A **marker** reaction (📌 `:pushpin:`) says "this is a task";
a **progress** reaction says where it stands; **reason flags** stack on top:

| axis | reaction | meaning |
| --- | --- | --- |
| progress 1 | ✅ `white_check_mark` | done |
| progress 2 | 🚫 `no_entry_sign` | dropped |
| progress 3 | 👀 `eyes` | doing |
| progress 4 | ⏳ `hourglass` | pending |
| progress 5 | *(marker only)* | undefined / untriaged |
| flag | ❗ `exclamation` | alert |
| flag | ❓ `question` | needs discussion |
| flag | 💬 `speech_balloon` | waiting — the other party in this conversation owes a reply |
| flag | 🔒 `lock` | blocked — stuck on something *outside* this conversation |

The invariant is **"at least one progress reaction, readers collapse by priority"** —
not "exactly one". A message carrying both ✅ and 👀 reads as *done*.

**Whose ball is it?** There are only three answers, and `pending` ⏳ already means *mine*.
The other two are the flags:

- 💬 **waiting** — I've done my part; someone **in this conversation** owes the next move
  (I asked a question, I'm waiting on a review, I sent it and need a yes/no).
- 🔒 **blocked** — the hold-up is **outside this conversation**: another task, a third
  party, an external dependency, a deploy window.

They stack with each other and with ❗/❓; `--state stuck` matches a task with any of them.

```sh
slack todo ls                              # --state open (default): marked, not done/dropped
slack todo ls --state untriaged            # marked, no progress reaction yet
slack todo ls --state doing --in "#eng"    # scoped to a channel
slack todo ls --state stuck                # unfinished AND carrying a reason flag
slack todo ls --state stuck --from "@alice" # …and it was alice who wrote it
slack todo ls --from me                    # tasks on my own messages
slack todo ls --state done --shared        # anyone's reactions, not just mine
slack todo set "#eng:1700000000.000100" doing
slack todo flag "<permalink>" waiting          # their ball now
slack todo flag "<permalink>" needs-discussion
slack todo flag "<permalink>" blocked --remove
slack todo doctor --in "#eng"              # report messages in two progress states
slack todo doctor --in "#eng" --fix        # keep the highest-priority one
```

Notes:

- `todo ls` is read-only and runs **exactly one** `search.messages` call — priority is
  expressed as negated `hasmy:` terms in the query, not as multiple searches
  (`search.messages` is Tier 2, ~20 req/min). By default it matches only *your* reactions
  (`hasmy:`); `--shared` switches to anyone's (`has:`). Slack's search index lags a little
  behind `reactions.add`, so a just-set task may take a moment to appear.
- `todo set` **adds the new reaction before removing the old ones**, and removes serially.
  The reverse order would leave a window with no progress reaction at all — a crash or a
  429 there would drop the task out of every query with nothing left pointing at it.
  Worst case here is a message with two progress reactions, which reads correctly and is
  repairable with `todo doctor --fix`.
- `--from <@user|me>` maps to search's `from:` modifier (a missing `@` is supplied; `me`
  passes through as-is). Reactions carry no reference to *whom* a task waits on, but the
  sender is usually that person — so filtering by author answers most of the question for
  free. It composes with `--in` in the same single search.
- **Not implemented, deliberately:** encoding the actual reference ("blocked on @alice" /
  "blocked on task X") as a machine-readable token in a thread reply. Measured: Slack's
  full-text index splits on punctuation, so a quoted search for `"blocked-on"` returns 0
  hits, and `"1.91"` matches `1.91.0`. A token like `todo:v1 blocked-on=@alice` is therefore
  unsearchable. Any future attempt needs a single alphanumeric marker word (e.g. `tdblock`)
  plus a bare `@mention`.
- `todo doctor` pages history sequentially and scans at most `--limit` messages
  (default 1000); if it hits the limit it says so rather than silently stopping.
- Emoji are configurable in `~/.config/slack-cli/todo.json` (same directory as
  `profiles.json`); anything omitted falls back to the defaults above:

  ```json
  { "marker": "round_pushpin", "progress": { "doing": "construction" } }
  ```

- Channel-name→ID and user-ID→handle lookups are cached in
  `~/.config/slack-cli/cache.json` for 1 hour, namespaced by workspace (`team_id`) since
  both are workspace-scoped; `--no-cache` bypasses it. Reaction state and search results
  are **never** cached — they are exactly the values that change, and Slack's search index
  already lags. A corrupt or unwritable cache is ignored and the command runs uncached.

### tail — real-time message stream

`slack tail` polls a channel every 3 seconds (configurable via `--interval`) and
prints new messages as they arrive, in the same `[ts]  @handle:  text` format as
the `read` command.

```sh
slack tail "#general"               # follow new messages from now
slack tail "#general" --since=30m   # backfill 30 minutes, then stream
slack tail "#general" --thread=1700000000.000100   # one thread only
slack tail "#general" --me          # only messages mentioning you
```

For automation, `--exit-on-message` stops as soon as the first message from
**someone else** arrives (your own posts are ignored), and `--timeout <dur>`
(e.g. `30m`, `2h`) auto-stops after the deadline with exit code 0. Together they
make a "wait for a reply, then act" primitive that won't hang:

```sh
slack tail "@yamada" --exit-on-message --timeout 30m --interval 15000
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
- `reactions:write` — for `react` (add/remove reactions)

> Add each scope to the **token type the CLI actually uses**. The CLI defaults to the
> **user token** (`xoxp-...`), so `reactions:write` must be under **User Token Scopes**.
> Adding it only to **Bot Token Scopes** makes `slack doctor` (which checks the bot
> token) look green while `slack react` still fails with `missing_scope` — the bot scope
> only helps `--as-bot`/bot-token usage. After changing scopes, **reinstall the app** to
> the workspace for it to take effect.

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
