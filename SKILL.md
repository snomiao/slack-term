---
name: slack-cli
description: "Terminal Slack CLI — read news/mentions/DMs/channel history, full-text search, and send messages with a confirm-hash gate. Also covers first-time setup of a user OAuth token (xoxp-...) via SLACK_MCP_XOXP_TOKEN. Trigger on requests like 'check my Slack', 'any mentions?', 'search Slack for X', 'DM @person', 'post to a channel', 'read a user', 'slack news', or auth errors (invalid_auth, missing_scope, not_authed) — even if the user doesn't say 'slack CLI' explicitly."
---

# Slack CLI Skill

A lightweight Slack CLI (Rust, also distributed as a Node N-API binary) for quick workspace interaction from the terminal.

Binary name: `slack` (also aliased as `sl` / invoked via `sc sl ...` in some setups).

## When to use

- User wants to read Slack activity, mentions, DMs, or channel history without opening the Slack app.
- User wants to search the workspace full-text.
- User wants to send a message to a channel or user from the terminal.
- User is setting up this CLI for the first time or hitting auth errors.

## Installation

Recommended (Rust):

```sh
cargo install --path .
```

Also works via npm (prebuilt N-API binaries):

```sh
npm install slack-cli
# or: bun add slack-cli / pnpm add slack-cli
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

# Read a specific channel or DM (quote #channel — unquoted # is a shell comment)
slack read "#general"
slack read @username

# Send a message (two-step confirm)
slack send "#general" "Hello team"
# Prints preview + a confirm hash. Re-run with --confirm=<hash> to actually send:
slack send "#general" "Hello team" --confirm=<hash>

# Bulk export a channel's history
slack dump "#channel-name"
```

Targets for `send` must be `#channel` or `@user` — raw IDs are rejected by design.

## Output formatting

- DM channels render as `@DisplayName`; public channels as `#channel-name`.
- `<@UID>` mention tokens are resolved to display names.
- `<!date^...>` markup is rendered as human-readable dates.
- Messages are grouped by day (Today / Yesterday / weekday).

## Getting a Slack token (first-time setup)

The CLI needs a **User OAuth Token** (`xoxp-...`), NOT a Bot Token.

### Required scopes

Under **User Token Scopes**:

- `search:read` — for `search` and `news`
- `channels:history`, `groups:history`, `im:history`, `mpim:history` — message history
- `channels:read`, `groups:read`, `im:read`, `mpim:read` — channel/DM listing
- `users:read` — resolve display names
- `chat:write` — send messages

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
echo 'SLACK_MCP_XOXP_TOKEN=xoxp-...' >> ~/.config/slack-cli/.env.local

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
- **Send is rejected with "use #channel or @user"** — the CLI enforces human-readable targets. Use `#channel-name` or `@display-name`, not raw IDs.
- **Confirm hash mismatch on `send`** — the message text changed between preview and confirm. Re-run without `--confirm` to get a fresh hash.
- **Enterprise Grid / admin-locked workspace** — custom app installation may need admin approval or be disabled outright.

## Safety

- Treat `xoxp-...` like a password. Do not commit `.env` containing a real token — ensure it's gitignored.
- Revoke unused tokens from the app's **OAuth & Permissions** page.
- The `send` command's two-step confirm-hash flow is intentional — don't try to bypass it by auto-computing the hash; let the user (or Claude) see the preview first.
