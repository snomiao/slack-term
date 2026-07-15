---
name: slack-cli
description: "Terminal Slack CLI — read news/mentions/DMs/channel history, full-text search, and send messages with a confirm-hash gate. Also covers first-time setup of a user OAuth token (xoxp-...) via SLACK_MCP_XOXP_TOKEN. Trigger on requests like 'check my Slack', 'any mentions?', 'search Slack for X', 'DM @person', 'post to a channel', 'read a user', 'slack news', or auth errors (invalid_auth, missing_scope, not_authed) — even if the user doesn't say 'slack CLI' explicitly."
---

# Slack CLI Skill

A lightweight Slack CLI for quick workspace interaction from the terminal.
Two implementations share one command surface (parity-tested):

- **TypeScript** (bun-first), published as `@snomiao/slack` on npm.
- **Rust** native binary, installable via `cargo install`.

Binary name: `slack` (also aliased as `sl` / invoked via `sc sl ...` in some setups).

## When to use

- User wants to read Slack activity, mentions, DMs, or channel history without opening the Slack app.
- User wants to search the workspace full-text.
- User wants to send a message to a channel or user from the terminal.
- User is setting up this CLI for the first time or hitting auth errors.

## Installation

TypeScript (recommended — any platform with Node 18+):

```sh
npm install -g @snomiao/slack
# or: bun add -g @snomiao/slack / pnpm add -g @snomiao/slack
```

Rust (native binary):

```sh
cargo install --path rs
```

## Commands

```sh
# Activity feed — recent mentions directed to you (to:me)
slack news
slack news --limit 5

# Recent messages across joined channels
slack msgs

# Full-text search
slack search "deploy"
slack search "deploy" --count 50
# search.messages is user-token-only; if the active profile is a bot token (xoxb-),
# the CLI auto-falls back to a sibling user-token profile for the same workspace
# (prints "falling back to profile ..."), or a clear error if none exists.

# Read a specific channel or DM (quote #channel — unquoted # is a shell comment)
slack read "#general"
slack read @username
# Read or tail a bot DM with the separately configured xoxb token:
slack read D0B0W2FGNHH --as-bot
slack tail D0B0W2FGNHH --as-bot

# Send a message (two-step confirm)
slack send "#general" "Hello team"
# Prints a destination preview + a confirm code. Re-run with --code=<code> to actually send:
slack send "#general" "Hello team" --code=<code>

# Reply in a thread — #chan:<thread_ts>, or paste a message permalink:
slack send "#general:1700000000.000100" "Replying in thread"
slack send "https://acme.slack.com/archives/C0123456789/p1700000000000100" "Replying in thread"

# Edit or delete a sent message (same confirm-code gate)
slack edit "<permalink>" "fixed wording"
slack delete "<permalink>"

# React instead of replying for a simple ack — keeps threads tidy (no confirm gate)
# 👀 seen  ✅ done  ⏳ working on it
slack react "#general:1700000000.000100" white_check_mark
slack react "<permalink>" eyes --remove   # take it back

# Bulk export a channel's history
slack dump "#channel-name"

# Download a file attachment (by file ID or file permalink) to disk
slack download F0123ABC                      # → ./<filename>
slack download F0123ABC ./invoices/          # into a directory
slack download "https://acme.slack.com/files/U1/F0123ABC/invoice.pdf"
```

Targets for `send` are `#channel`, `@user`, `#channel:<thread_ts>`, or a Slack URL —
a message permalink replies in that message's thread; a channel-only URL posts top-level.
The confirm preview prints the resolved destination (`→ ... — THREAD REPLY` or
`→ ... — NEW top-level message`); verify it before re-running with `--code`.

`send` also runs a **warn-only untagged-mention lint**: if the body names a workspace
member in plain text (honorifics like `山田さん` / `張老师`, or `Hi Dave`) without a
matching `<@USERID>` tag, it prints `⚠ possible untagged mention: …` alongside the
confirm code. It never blocks — third-party/external references are expected to trip it.
To actually notify someone, write `@handle` (auto-converted to `<@USERID>`; see below).

When the target is a **thread**, the confirm preview shows the thread's recent messages
(not the channel's last message) and prints `⚠ possible duplicate: …` if your text is
near-identical to an existing reply — so you can avoid re-posting something already said.

`send` also warns (non-blocking) when the destination's most recent message is your own
and no one has replied since — `⚠ 相手はまだ返信していません…`, suggesting `slack edit`
on that message instead of piling on a new one. Reply-status based, not time-based; opt
out with `SLACK_UNREPLIED_WARN=0`.

**Etiquette:** prefer a `react` over a reply for simple acks (了解 → `eyes`, 完了 →
`white_check_mark`, 処理中 → `hourglass`) so threads stay short; read the thread with
`slack thread`/`slack read` before replying to avoid duplicates; consolidate multiple
points into one message.

## Output formatting

- DM channels render as `@DisplayName`; public channels as `#channel-name`.
- `<@UID>` mention tokens are resolved to display names.
- `<!date^...>` markup is rendered as human-readable dates.
- Messages are grouped by day (Today / Yesterday / weekday).
- Attachments show a `📎 <name> (<size>) [<file-id>]` line under the message; `--json`
  adds a `files[]` array (`id`, `name`, `mimetype`, `size`, `url_private_download`,
  `permalink`) only on messages that have attachments. Fetch one with `slack download <file-id>`.

## Getting a Slack token (first-time setup)

The CLI needs a **User OAuth Token** (`xoxp-...`), NOT a Bot Token.

### Required scopes

Under **User Token Scopes**:

- `search:read` — for `search` and `news`
- `channels:history`, `groups:history`, `im:history`, `mpim:history` — message history
- `channels:read`, `groups:read`, `im:read`, `mpim:read` — channel/DM listing
- `users:read` — resolve display names
- `chat:write` — send messages
- `reactions:write` — add/remove reactions (`react`)

> **Token-type gotcha:** the CLI uses the **user token** (`xoxp-`) by default, so scopes
> must be under **User Token Scopes**. Adding `reactions:write` only to *Bot* Token Scopes
> makes `slack doctor` (which checks the bot token) pass while `slack react` still errors
> `missing_scope`. Add it under User Token Scopes, then **reinstall** the app.

### Steps

1. Go to https://api.slack.com/apps → **Create New App → From scratch**.
2. Name the app (e.g. `slack-cli-<you>`) and pick the workspace.
3. Sidebar → **OAuth & Permissions**.
4. Scroll to **User Token Scopes** (NOT Bot Token Scopes) and add every scope above.
5. Scroll up → **Install to Workspace** → **Allow**.
   - If admin approval is required, the button becomes **Request to Install**. Ask a workspace admin.
6. Copy the **User OAuth Token** (starts with `xoxp-`).

### Configure the token

```sh
# Option A — per-shell
export SLACK_MCP_XOXP_TOKEN=xoxp-...

# Option B — persistent, user-wide
mkdir -p ~/.config/slack-cli
echo 'SLACK_MCP_XOXP_TOKEN=xoxp-...' >> ~/.config/slack-cli/.env

# Option C — project-local
echo 'SLACK_MCP_XOXP_TOKEN=xoxp-...' >> .env
```

Verify:

```sh
slack news --limit 1
```

## Troubleshooting

- **`invalid_auth` / `not_authed`** — token missing, mistyped, or revoked. Re-copy from **OAuth & Permissions**.
- **`missing_scope`** — add the scope from the error, then click **Reinstall to Workspace** (scope changes require reinstall).
- **`token_revoked`** — app uninstalled; reinstall from the app page.
- **Token starts with `xoxb-`** — that's a Bot Token. Add scopes under **User Token Scopes** instead, reinstall, and copy the **User OAuth Token**.
- **`xoxc-` desktop session token** — accepted by the public Slack API (send/edit/delete/react/upload/channel create+invite included) as long as its `xoxd` session cookie is attached (`slack auth chrome`/`slack auth firefox`, or `SLACK_COOKIE=...`). Without the cookie it still fails with a clear "needs its session cookie" error.
- **`conversations.invite` reports success but the member never shows up** — the invited user is likely a single-channel guest (`is_ultra_restricted`); Slack silently no-ops the invite since that account type can only ever belong to the one channel it was created in. `channel create --invite` now warns about this up front.
- **Send is rejected with "use #channel or @user"** — the CLI enforces human-readable targets. Use `#channel-name` or `@display-name`, not raw IDs.
- **Confirm code mismatch on `send`** — the message text or destination changed between preview and confirm. Re-run without `--code` for a fresh preview, and re-check the `→` destination line (THREAD REPLY vs NEW top-level message).
- **Enterprise Grid / admin-locked workspace** — custom app installation may need admin approval or be disabled outright.

## Safety

- Treat `xoxp-...` like a password. Do not commit `.env` containing a real token — ensure it's gitignored.
- Revoke unused tokens from the app's **OAuth & Permissions** page.
- The `send` command's two-step confirm-hash flow is intentional — don't try to bypass it by auto-computing the hash; let the user (or Claude) see the preview first.
