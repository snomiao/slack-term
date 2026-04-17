# Slack CLI ecosystem

A wider survey of terminal tools for Slack beyond the head-to-head in
[`comparison-slkcli.md`](./comparison-slkcli.md).

## 1. slackapi/slack-cli (official)

- **Language / runtime:** Go
- **Platform:** macOS / Linux / Windows
- **Auth:** `slack login` against the Slack Platform (OAuth app dev credentials, not user tokens for messaging)
- **Mental model:** Subcommand CLI scoped to **app development** — scaffold, run, deploy, and manage Slack apps/functions. Not for sending messages from your terminal.
- **Notable UX:** First-class templates, local dev runner, deploy pipeline to Slack-managed infra, Deno function support.
- **Pro:** The only Slack-blessed, guaranteed-stable tool; won't be broken by API changes.
- **Con:** Wrong tool if you want to read or send messages from the terminal — it's a dev toolchain, not a messaging CLI.
- Source: https://github.com/slackapi/slack-cli (active)

## 2. rockymadden/slack-cli (the classic bash one)

- **Language / runtime:** Pure bash + `curl` + `jq`
- **Platform:** Unix-like (macOS / Linux)
- **Auth:** Legacy / bot / user API token via `slack init` or `SLACK_CLI_TOKEN`
- **Mental model:** Wide subcommand CLI mirroring the Web API: `chat`, `file`, `reminder`, `snooze`, `presence`, `status`, etc. Pipe-friendly, composes with `jq`.
- **Notable UX:** Rich message attachments, stdin piping, `--filter` for JSON extraction, hackable shell script.
- **Pro:** Zero binary dependency beyond bash/curl/jq — trivial to drop on any server.
- **Con:** Semi-dormant, pre-dates the current Slack scope model — shows its age.
- Source: https://github.com/rockymadden/slack-cli

## 3. jpbruinsslot/slack-term

- **Language / runtime:** Go
- **Platform:** macOS / Linux / Windows (+ Docker)
- **Auth:** Legacy token / xoxp in config file (no xoxc auto-extract)
- **Mental model:** **TUI chat client** with vim-style keybindings — channel list, message pane, thread view. Not a subcommand CLI.
- **Notable UX:** Full-screen interactive client; channel/thread navigation, search, notifications, customizable keymap.
- **Pro:** Closest thing to a "real" Slack client in the terminal with a chat-shaped UI.
- **Con:** Effectively unmaintained (last release v0.5.0, March 2020); legacy-token acquisition has gotten painful.
- Source: https://github.com/jpbruinsslot/slack-term

## 4. wee-slack

- **Language / runtime:** Python plugin for WeeChat (2.2+)
- **Platform:** Anywhere WeeChat runs (Linux / macOS / BSD)
- **Auth:** xoxp OAuth token **or** browser-extracted session (`d` cookie, optional `d-s`); multi-workspace via comma-separated tokens
- **Mental model:** **IRC-style chat client** — `/join`, `/msg`, `/reply`, `/thread` inside WeeChat.
- **Notable UX:** Read-marker sync across clients, typing indicators, thread labels, regex edits (`s/old/new/`), `+:emoji:` reactions, emoji completion.
- **Pro:** Genuinely active; cookie-auth bypasses the OAuth-app-approval hurdle for personal use.
- **Con:** Requires WeeChat — not a standalone CLI; setup friction for non-IRC users.
- Source: https://github.com/wee-slack/wee-slack

## 5. bcicen/slackcat

- **Language / runtime:** Go
- **Platform:** macOS / Linux (Homebrew, single binary)
- **Auth:** OAuth token via `slackcat --configure` (browser flow)
- **Mental model:** Unix-pipe shim in the spirit of `cat` / `nc`. One job: take stdin or a file and send it to a channel.
- **Notable UX:** `--stream` mode tails a log into Slack line-by-line; `--tee` mirrors locally; syntax highlighting via filetype; thread target supported.
- **Pro:** Canonical `tail -F /var/log/foo | slackcat` ergonomics — perfect for CI/cron/ops glue.
- **Con:** Write-only and stale (last release July 2021); no read/search/thread browsing.
- Source: https://github.com/bcicen/slackcat

## 6. rusq/slackdump

- **Language / runtime:** Go
- **Platform:** macOS / Linux / Windows
- **Auth:** Browser-extracted xoxc + xoxd cookie, or "EZ-Login 3000" automated browser flow — **no Slack app required**
- **Mental model:** **Archival/export tool**. Subcommands: `wiz` (interactive), `dump`, `export`, `view`, `convert`, `list`, `mcp`.
- **Notable UX:** Slack-compatible export archives (replay-able in Slack's own import), built-in viewer, SQLite or JSON+GZ storage, emoji download, MCP server for AI agents, free-plan 90-day workaround via incremental archives.
- **Pro:** Best-in-class for bulk export/archival without admin rights; very active.
- **Con:** Scope is dump/export/view — not for day-to-day interaction.
- Source: https://github.com/rusq/slackdump

## 7. sgratzl/slack_cleaner2

- **Language / runtime:** Python 3
- **Platform:** Any (pip / Docker)
- **Auth:** xoxp user token (admin/owner required to delete others' messages)
- **Mental model:** Python **library-first** with thin CLI entry — script `SlackCleaner(token)` and iterate `.users` / `.conversations` to bulk-delete messages, files, and thread replies.
- **Notable UX:** Granular scope-per-use-case docs, file deletion, threaded reply sweep, Docker image.
- **Pro:** Standard tool for bulk deletion / GDPR-style cleanup; scriptable in real Python.
- **Con:** Single-purpose (destructive); mature-but-slow cadence.
- Source: https://github.com/sgratzl/slack_cleaner2

## Positioning matrix

| Tool                  | Read       | Send              | Search         | Archive           | Interactive     | Auth story                      |
| --------------------- | ---------- | ----------------- | -------------- | ----------------- | --------------- | ------------------------------- |
| `@snomiao/slack-cli`  | yes        | yes (confirm-hash) | yes            | yes (`dump`)      | no (CLI)        | xoxp via env                    |
| `slkcli`              | yes        | yes               | yes            | partial           | no (CLI)        | xoxc auto-extract (macOS only)  |
| `slackapi/slack-cli`  | —          | —                 | —              | —                 | —               | app-dev only                    |
| `rockymadden/slack-cli` | via API  | yes               | via API        | no                | no              | token env                       |
| `slack-term`          | yes        | yes               | yes            | no                | **TUI**         | legacy token                    |
| `wee-slack`           | yes        | yes               | yes            | no                | **chat client** | xoxp or cookie                  |
| `slackcat`            | no         | yes               | no             | no                | no              | OAuth token                     |
| `slackdump`           | yes (bulk) | no                | yes (archive)  | **yes, canonical**| wizard          | cookie                          |
| `slack_cleaner2`      | (for delete) | no              | —              | no                | no              | xoxp                            |

## Notes on tools deliberately skipped

- **nlopes/slack** — Go *library*, not a CLI, and archived (2021).
- **hikalium/slack-tui, Sclack, other TUI attempts** — single-author experiments, no releases in 3+ years.
- **active9 / rlister / paulhammond / nficano slackcat variants** — redundant with bcicen's Go implementation and less maintained.
- **kfei/slack-cleaner, SlackTerminator, ruanbekker/slack-channel-cleaner** — superseded by `slack_cleaner2`.

## What this implies for `@snomiao/slack-cli`

The ecosystem splits into five camps:

1. **Official dev-toolchain** (`slackapi/slack-cli`) — not our space.
2. **Pipe shims** (`slackcat`) — our `send` partially covers this; stdin support would close the gap.
3. **Full TUI chat clients** (`slack-term`, `wee-slack`) — a different product; not our target.
4. **Archival** (`slackdump`) — our `dump` subcommand overlaps; slackdump is deeper.
5. **Scripted API wrapper** (rockymadden, `@snomiao/slack-cli`, `slkcli`) — this is our camp.

Within camp 5, our distinguishing bets are: **cross-platform**, **explicit
xoxp auth**, and **confirm-hash on send**. The features in
[`comparison-slkcli.md`](./comparison-slkcli.md#ideas-worth-stealing) are
additive — none of them conflict with those bets.
