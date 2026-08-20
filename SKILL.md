---
name: slack-cli
description: "Terminal Slack CLI — read news/mentions/DMs/channel history, full-text search, and send messages with a confirm-hash gate. Also covers first-time setup of a user OAuth token (xoxp-...) via SLACK_MCP_XOXP_TOKEN. Trigger on requests like 'check my Slack', 'any mentions?', 'search Slack for X', 'DM @person', 'post to a channel', 'read a user', 'slack news', or auth errors (invalid_auth, missing_scope, not_authed) — even if the user doesn't say 'slack CLI' explicitly."
---

# Slack CLI Skill

A lightweight Slack CLI for quick workspace interaction from the terminal.
Two implementations share one command surface (parity-tested):

- **TypeScript** (bun-first), published as `slack-term` on npm.
- **Rust** native binary, installable via `cargo install`.

Binary name: `slack` (also aliased as `sl` / invoked via `sc sl ...` in some setups).

Part of the [agent-yes](https://github.com/snomiao/agent-yes) ecosystem — this is the CLI an
agent uses to talk to humans. Design notes:
[lab.agent-yes.com](https://lab.agent-yes.com/2026-08-11-slack-term-safe-writes).

## When to use

- User wants to read Slack activity, mentions, DMs, or channel history without opening the Slack app.
- User wants to search the workspace full-text.
- User wants to send a message to a channel or user from the terminal.
- User is setting up this CLI for the first time or hitting auth errors.

## Installation

TypeScript (recommended — any platform with Node 18+):

```sh
npm install -g slack-term
# or: bun add -g slack-term / pnpm add -g slack-term
```

> Previously published as `@snomiao/slack`; that name is deprecated on npm and
> no longer updated. Install `slack-term`.

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
# Thread parents are marked `[+N replies]` — a marked line means there is more to
# read inside the thread (`slack thread "#general" <ts>`); top-level output alone
# never shows thread replies. --json carries reply_count/reply_users_count/latest_reply.
slack read "#general" --unreplied   # only what's still awaiting your answer

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

# Ask a question with its choices pre-seeded as 1️⃣..🔟 reactions (same confirm gate)
# The question MUST @tag whoever may answer — only their reaction/reply counts.
slack ask "#eng" "@alice この PR 出してよい?" "出す" "待つ"
ANS=$(slack ask "@bob" "出してよい?" "はい" "待って" --code=<code> --wait)  # blocks
RESUME=$(slack ask "@bob" "出してよい?" "はい" "待って" --code=<code>)      # does not
#   RESUME -> slack ask --waitFor='<permalink>'    # collect the answer later
eval "$RESUME --timeout 0"                        # check once: 0 answered / 2 still open

# Task tracking on reactions — 📌 marks a task, a second reaction holds progress
slack todo ls                                     # EVERYONE's open tasks (has:)
slack mytodo ls                                   # only tasks YOU reacted to (hasmy:)
slack todo ls --state untriaged --in "#general"   # marked but no progress yet
slack mytodo ls --state stuck                     # my unfinished tasks + a reason flag
slack todo set "#general:1700000000.000100" doing # pending|doing|done|dropped
slack todo ls --state stuck --from "@alice"        # …and alice wrote it
slack todo flag "<permalink>" waiting             # alert|needs-discussion|waiting|blocked
                                                  # waiting = their ball, blocked = outside
slack todo doctor --in "#general" [--fix]         # messages stuck in two states

# Bulk export a channel's history
slack dump "#channel-name"

# Download a file attachment (by file ID or file permalink) to disk
slack download F0123ABC                      # → ./<filename>
slack download F0123ABC ./invoices/          # into a directory
slack download "https://acme.slack.com/files/U1/F0123ABC/invoice.pdf"
```

Targets for `send` are `#channel`, `@user`, `#channel:<thread_ts>`, or a Slack URL —
a message permalink replies in that message's thread; a channel-only URL posts top-level.
The confirm preview prints who it will be sent **as** (`From: @handle (Uxxxx) — Workspace`,
plus `[as bot]` under `--as-bot`) and the resolved destination (`→ ... — THREAD REPLY` or
`→ ... — NEW top-level message`); verify both before re-running with `--code`.

**Every** gated write opens its preview with that same `From:` line — `send`, `edit`,
`delete`, `upload`, `schedule send`, `schedule rm`, `channel create`, `drafts edit`,
`drafts delete` — and the identity is part of the confirm hash: switching
profile/token between preview and confirm invalidates the code instead of acting as
someone else. It matters most on `schedule send`, where the message goes out later,
unattended, as whoever the token was at schedule time.

`schedule send` prints its fire time in both zones —
`At:  2026-08-10 18:00:00 GMT+9 (local) / 2026-08-10T09:00:00.000Z (Unix: 1786352400)` —
because `--at` accepts both bare local times (`"2026-08-10 09:00"`) and `Z`-suffixed
UTC, and the two are easy to mix up. Check the side you meant before confirming.

`send` also runs a **warn-only untagged-mention lint**: if the body names a workspace
member in plain text (honorifics like `山田さん` / `王老师`, or `Hi Dave`) without a
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

### ask — a question whose answer is one tap

Choices are posted as 1️⃣..🔟 reactions on the question itself, so answering costs one tap
on an existing pill. Reactions, not Block Kit buttons: `block_actions` are delivered only
to a Request URL or a Socket Mode socket, neither of which a short-lived CLI can own
without losing clicks. A reaction is durable state anyone can read back later.

- **The question must @tag whoever may answer** (`@alice`, or `@here`/`@channel` for the
  whole channel). Only their reaction/reply is taken as the answer; an unaddressed
  question is refused (exit 3) rather than let the first bystander decide it. In a 1:1 DM
  the other party counts automatically.
- **Answer paths**: a pill, or free text. In a DM a plain reply counts; in a channel only
  reactions and thread replies do (a channel carries unrelated traffic).
- **Two pills pressed = no answer.** Changing your mind leaves both reactions in place, so
  `ask` says so in the thread once and keeps waiting rather than guessing.
- **Exit codes** are the contract: `0` answered (the answer alone on stdout), `2` timed
  out, `3` transport/config failure. Everything human-facing goes to stderr, so
  `ANS=$(slack ask … --wait)` is safe.

**Collecting an answer you did not block on.** Without `--wait`, stdout is a runnable
`slack ask --waitFor='<permalink>'`. Run it any time — it re-reads the question from Slack
and recovers everything it needs by parsing the message, so nothing is stored locally and
any machine with the link can collect. It reports an already-answered question (the
✅-stamped body) immediately, and refuses (exit 3) a message that is not an ask.
`--timeout 0` checks exactly once, which is what a periodic monitor should use: `--wait`
parks the process, and a parked lane still looks *active* in `ay ls`.

This path is not optional convenience — **a pressed pill is invisible to `slack tail`**,
which only sees `type: "message"` events and drops `message_changed`. Without `--waitFor`
an answer can be pressed and nobody ever hears about it.

### todo — tasks as reactions

A task is any message carrying the marker reaction 📌 `:pushpin:`. Progress lives in a
second reaction, ranked by priority — **1** ✅ `white_check_mark` done, **2** 🚫
`no_entry_sign` dropped, **3** 👀 `eyes` doing, **4** ⏳ `hourglass_flowing_sand` pending, **5** marker
only = undefined. A message may carry more than one progress reaction — readers collapse
to the highest priority, so ✅+👀 reads as *done*.

Reason flags stack independently of progress and of each other: ❗ `exclamation` alert,
❓ `question` needs-discussion, and two that say **whose ball it is** —

- 💬 `speech_balloon` **waiting** — someone **in this conversation** owes the next move
  (asked a question, waiting on a review/approval). Their ball.
- 🔒 `lock` **blocked** — stuck on something **outside** it: another task, a third party,
  an external dependency. Nobody here can unstick it by replying.

(⏳ `hourglass_flowing_sand` pending already means "my ball", which is why only these two are needed.)

- **`todo ls` = anyone's reactions (`has:`), `mytodo ls` = only yours (`hasmy:`).** Two
  commands rather than a flag, so the two lists can't be mistaken for each other. Both
  print `From: @handle (Uxxxx) — Workspace` first: `hasmy:` resolves against whoever the
  token is, so "my tasks" is only meaningful once you know who *my* is. `todo ls --mine`
  is a shortcut to the narrow view; `--shared` is accepted but is now the default.
- Both are read-only and issue **one** `search.messages` call; priority is encoded as
  negated `has:`/`hasmy:` terms.
  `search.messages` returns no reaction data, so this filtering can only happen in the
  query. The search index lags slightly behind `reactions.add`.
- `todo set` adds the target reaction **first**, then removes the stale ones one at a time.
  Never remove-then-add: an interruption in between leaves the task with no progress
  reaction and it vanishes from every query. Two reactions is the safe failure mode, and
  `todo doctor --fix` repairs it (also add-first).
- `todo ls --from <@user|me>` adds search's `from:` modifier (missing `@` supplied, `me`
  left bare) and composes with `--in` in the same single search. Reactions can't point at
  *who* a task waits on, but the sender usually is that person.
- Deliberately NOT implemented: a machine-readable token in a thread reply to carry the
  actual reference. Measured — Slack's index splits on punctuation, so quoted `"blocked-on"`
  gets 0 hits and `"1.91"` matches `1.91.0`; `todo:v1 blocked-on=@alice` is unsearchable.
  A future attempt needs one alphanumeric marker word (e.g. `tdblock`) + a bare `@mention`.
- `todo doctor` scans at most `--limit` messages (default 1000), pages sequentially, and
  explicitly reports when it hits the limit.
- Emoji overrides: `~/.config/slack-cli/todo.json`, e.g.
  `{ "marker": "round_pushpin", "progress": { "doing": "construction" } }`.
- Channel/user lookups are cached for 1h in `~/.config/slack-cli/cache.json`, keyed by
  workspace `team_id` (`--no-cache` to bypass). Reaction state and search results are never
  cached; a broken cache is ignored. Message listings read this cache too, behind their
  in-process map.
- Rate limits: `todo` commands catch Slack's 429, wait `Retry-After`, and retry up to 3
  times before failing loudly.

**Etiquette:** prefer a `react` over a reply for simple acks (了解 → `eyes`, 完了 →
`white_check_mark`, 処理中 → `hourglass_flowing_sand`) so threads stay short; read the thread with
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
- **Confirm code mismatch on any gated write** — the content, target or acting identity changed between preview and confirm (a different profile/`SLACK_TOKEN`, or `--as-bot` added or dropped). Re-run without `--code` for a fresh preview, and re-check the `From:` line and the `→` destination line (THREAD REPLY vs NEW top-level message).
- **Enterprise Grid / admin-locked workspace** — custom app installation may need admin approval or be disabled outright.

## Safety

- Treat `xoxp-...` like a password. Do not commit `.env` containing a real token — ensure it's gitignored.
- Revoke unused tokens from the app's **OAuth & Permissions** page.
- The `send` command's two-step confirm-hash flow is intentional — don't try to bypass it by auto-computing the hash; let the user (or Claude) see the preview first.
