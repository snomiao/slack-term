# slack-term → renamed to **slack-hub**

This package is **deprecated**. The project is now published as
[`slack-hub`](https://www.npmjs.com/package/slack-hub)
([GitHub](https://github.com/snomiao/slack-hub)). For a transition period every
release is still mirrored here under the old name, so toolchains that depend
on `slack-term` keep working, but this mirror will eventually stop. Installs stay
quiet; the `slack` command prints a one-line deprecation notice on stderr
(stdout is untouched; silence it with `SLACK_HUB_NO_RENAME_NOTICE=1`).

## Migrate

```sh
npm uninstall -g slack-term
npm install -g slack-hub
# or: bun remove -g slack-term && bun add -g slack-hub
```

The command is still `slack`, and your existing setup keeps working:

| Before (slack-term) | Now (slack-hub) | Old one still read? |
|---|---|---|
| `.slack-term/` (per directory) | `.slack-hub/` | yes. An existing `.slack-term/` is found when there is no `.slack-hub/` |
| `~/.config/slack-term/` | `~/.config/slack-hub/` | yes, when the new one does not exist |
| `~/.slack-term/.env.local` | `~/.slack-hub/.env.local` | yes, when the new one does not exist |
| `$XDG_STATE_HOME/slack-term/` | `$XDG_STATE_HOME/slack-hub/` | yes, when the new one does not exist |
| `SLACK_TERM_*` env vars | `SLACK_HUB_*` | yes. `SLACK_HUB_*` wins when both are set |
| `slack-term/worker` (relay import) | `slack-hub/worker` | change the import and the dependency |
| relay subprotocol `slack-term-relay.v1` | `slack-hub-relay.v1` | yes, both directions |
| message metadata `slack_term_sent` | `slack_hub_sent` | (new messages only) |

### If you deployed the relay (`slack relay init`)

In your relay folder, replace the dependency and the import:

```sh
npm uninstall slack-term && npm install slack-hub
sed -i 's#"slack-term/worker"#"slack-hub/worker"#' src/index.ts
npx wrangler deploy
```

Old and new clients and relays still talk to each other, so you can upgrade
them in any order.

To move to new names you can rename `.slack-term/` → `.slack-hub/` and
`~/.config/slack-term/` → `~/.config/slack-hub/` at any time. Do it before
anything creates the new one, or merge the two yourself.
