# UX Comparison: `@snomiao/slack-cli` vs `slkcli`

A side-by-side look at this project (`slack` / `@snomiao/slack-cli`) and
[`slkcli`](https://www.npmjs.com/package/slkcli)
([repo](https://github.com/therohitdas/slkcli)) by
[@therohitdas](https://github.com/therohitdas).

Both tools target the same itch — "Slack from the terminal, agent-friendly" —
but make very different choices about auth, platform reach, and command surface.

## TL;DR

| Dimension | `@snomiao/slack-cli` (this repo) | `slkcli` |
| --- | --- | --- |
| Language / runtime | Rust (napi bindings for Node) | Pure Node.js (zero deps) |
| Platform | macOS / Linux / Windows | **macOS only** |
| Auth model | `xoxp-` user token via env/`.env` | **Auto-extract `xoxc-` from Slack desktop app** (Keychain + LevelDB) |
| Setup friction | Create Slack App → scopes → install → copy token | `npx slkcli auth` (one keychain prompt) |
| Send safety | **Two-step confirm hash** (`--confirm=<hash>`) | Direct send |
| Target syntax | `#channel` / `@user` required; raw IDs rejected | Name **or** ID accepted |
| Command style | Few verbs (`news`, `msgs`, `search`, `read`, `send`, `dump`) | Broad (`auth`, `channels`, `dms`, `users`, `read`, `send`, `search`, `thread`, `react`, `activity`, `unread`, `starred`, `saved`, `pins`, `draft*`) |
| Drafts | — | First-class `draft` / `drafts` / `draft drop` |
| Threads | Flattened into history output | Dedicated `slk thread` + `--threads` auto-expand |
| Reactions | — | `slk react` |
| Mute awareness | — | `activity` / `unread` respect mute |
| Date filtering | — | `--from` / `--to YYYY-MM-DD` |
| Output polish | Day grouping (Today/Yesterday/weekday), `<@UID>` and `<!date^...>` resolution | Emoji rendering, `--no-emoji`, `--ts` for raw timestamps |

## Where we win

1. **Cross-platform.** `slkcli` is macOS-only by design — it reads the Slack
   desktop app's Keychain entry and LevelDB. Our CLI runs anywhere Rust or
   Node does.
2. **Explicit auth.** The `xoxp-` flow is tedious but auditable: the user
   picks exactly which scopes to grant, and the token can be revoked at
   `api.slack.com/apps` without uninstalling anything. `slkcli`'s auto-extract
   is frictionless but couples token lifetime to the desktop app's session.
3. **Safer `send`.** The confirm-hash gate (preview → hash → `--confirm=<hash>`)
   is a real guard against agents auto-sending the wrong message to the wrong
   channel. `slkcli` sends directly — fine for humans, risky for agents.
4. **Strict target syntax.** Rejecting raw channel IDs forces readable command
   history (`slack send "#general" ...` rather than `slk send C08A8AQ2AFP ...`),
   which matters when reviewing agent logs or shell history.
5. **Day-grouped output.** `news` / `msgs` group by Today / Yesterday / weekday,
   which reads better than raw timestamp lists.

## Where slkcli wins

1. **Zero-config onboarding.** `npx slkcli auth` → done. No Slack App, no scope
   picker, no token pasted into `.env`. For a solo user on macOS this is a huge
   UX win.
2. **Broader command surface.** We don't have `react`, `thread`, `activity`,
   `unread`, `starred`, `saved`, `pins`, or `draft*`. Each of those is a real
   workflow we currently can't cover.
3. **Drafts as a first-class concept.** `slk draft ... → slk drafts → slk draft drop`
   is a nicer mental model than our single-shot confirm hash for iterative
   composition. (We could combine: drafts for composition, confirm hash for
   sending.)
4. **Date range filtering.** `--from` / `--to YYYY-MM-DD` makes retrospectives
   and standup-prep trivial. We only expose `--limit N` and `--count N`.
5. **Thread handling.** Separate `slk thread <channel> <ts>` and a
   `--threads` global to auto-expand — much better than flattening threads
   into the main history.
6. **Mute-aware activity.** `activity` and `unread` filter out muted channels,
   which is exactly what you want when triaging.
7. **Name-or-ID flexibility.** Accepting `general` **or** `C08A8AQ2AFP` lowers
   the barrier for scripts that already have IDs in hand.

## Ideas worth stealing

Concrete additions that would measurably improve our UX without giving up our
principles (cross-platform, explicit auth, confirm-hash on send):

- `slack activity` / `slack unread` with mute-awareness
- `slack thread <channel> <ts>` + a `--threads` flag on `read` / `msgs`
- `slack react <channel> <ts> <emoji>`
- `slack users`, `slack channels`, `slack dms` listings
- `slack pins <channel>`, `slack saved`, `slack starred`
- `--from` / `--to YYYY-MM-DD` on `read` / `search` / `dump` / `news`
- Optional name-lookup layer so `slack read general` works (still preferring
  `#general` in docs; just don't reject the bare form on `read`)
- Draft flow: `slack draft "#general" "hello"` stores locally, `slack drafts`
  lists, and `slack send --draft <id>` promotes to the confirm-hash flow
- `--ts` global to show raw timestamps (useful for feeding back into
  `slack thread <channel> <ts>`)
- Agent-friendliness: document the exit codes (0 / 1) and keep errors on
  stderr (slkcli is explicit about this)

## Philosophical differences

- **slkcli** optimizes for a single macOS user who already has Slack open and
  wants the fastest possible loop. The tradeoff is platform lock-in and
  implicit credential handling.
- **@snomiao/slack-cli** optimizes for a reproducible, cross-platform,
  audit-friendly setup — suitable for CI, Linux servers, and agents where a
  Keychain prompt isn't available. The tradeoff is a heavier first-run.

Neither approach is strictly better. If we added a (optional, opt-in) macOS
auto-auth path alongside the explicit `xoxp-` flow, we'd close most of the
onboarding gap without losing portability.

## References

- slkcli on npm: https://www.npmjs.com/package/slkcli
- slkcli source: https://github.com/therohitdas/slkcli
- Slack user token scopes: https://api.slack.com/scopes
- Slack apps management: https://api.slack.com/apps
