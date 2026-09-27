# Auth UX redesign: user-level profiles + Chrome login

Drafted 2026-09-27. Restructures `slack auth` around the way Slack session auth
actually works: one browser/user identity holds a shared session cookie and many
per-workspace tokens. The token side (identity-grouped Chrome import, all
platforms) is implemented and batteries-included; the cookie side is at-rest on
macOS with manual attach elsewhere.

## Why

Slack session auth is two secrets with different scopes:

| Secret | Scope | Where it lives | Extractable at rest? |
| --- | --- | --- | --- |
| `xoxc-<teamId>-…` token | **per workspace** (embeds team ID) | Chrome LocalStorage LevelDB; Slack desktop app LevelDB | **Yes** — not encrypted (Snappy-compressed; a bundled reader decompresses), cross-platform |
| `xoxd-…` `d` cookie | **per user** (one shared cookie across every workspace in that browser profile) | Chrome `Network/Cookies` (encrypted); desktop app `Cookies` | **macOS only at rest** — Windows Chrome uses `v20` app-bound AES-256-GCM, which needs the Chrome-bound key |

A client API call needs **both** (`token=xoxc-…` + `Cookie: d=xoxd-…`). Neither
works alone; a real `xoxp-` OAuth token needs no cookie.

Two consequences drive the redesign:

1. **The cookie is workspace-agnostic**, but today `extractSessions()` copies the
   same `xoxd` onto *every* workspace profile. On cookie rotation you must rewrite
   N records. The natural key is **(user, workspace)**, i.e. a `user → workspaces`
   tree, which also handles the same workspace joined under two identities.
2. **The token is enough to identify a workspace** (team ID is in it) and Chrome
   LocalStorage holds it un-encrypted — so Chrome can be a *full* login source
   that creates the user and all its workspaces, not just a cookie top-up.

### Field survey (local Chrome, Windows)

A read-only survey of a real multi-profile Chrome confirmed the model: of 19
profiles, 3 held Slack sessions, each mapping to one user identity with 1–N
`xoxc` tokens. Chrome's `.ldb` data blocks are Snappy-compressed (a copy-op can
split `"token":"xoxc-…"` apart), so a bundled Snappy + SSTable reader
(`ts/leveldb.ts`) decompresses them before scanning — verified to recover all
three accounts' full-length tokens, names, and URLs on Windows.

### Token vs. cookie extraction

- **token** → read from LocalStorage on all platforms. Not encrypted; the
  bundled reader decompresses the Snappy `.ldb` blocks. This is the
  batteries-included path and needs no OS credential access.
- **cookie** → decrypted at rest on macOS (keychain, `v10`) and on Windows
  (`v20` app-bound, in `ts/chromeCookieWin.ts`). The Windows path needs one
  elevation (UAC): it runs the SYSTEM-context DPAPI and (flag 3) `NCryptDecrypt`
  of Chrome's `"Google Chromekey1"` via one-shot SYSTEM scheduled tasks, unwraps
  the master key (flag 1 AES-GCM / flag 2 ChaCha20 / flag 3 CNG+XOR+AES-GCM), and
  reads the exclusively-locked cookie DB through a VSS shadow snapshot. If any of
  that fails (e.g. a Chrome build that changes the flag/keys), `slack auth cookie`
  prints manual-paste guidance.

Firefox stores cookies un-encrypted, so its cookie path stays as-is.

## Current command surface (for reference)

```
slack auth token [--token … --name …]   # print active token, or save one
slack auth env                           # dotenv of active creds
slack auth app [--bot]                   # guided new-app wizard
slack auth login [--token … --name …]    # wizard: 1 desktop / 2 existing / 3 new-user / 4 new-bot
slack auth ls | status
slack auth use <name> [-g]
slack auth logout | rm | remove <name>
slack auth chrome | cookie [-w <ws>]     # attach xoxd cookie (macOS only, interactive)
slack auth firefox [-w <ws>]             # attach xoxd cookie (all platforms)
slack login …                            # hidden top-level alias of auth login
```

### Problems

1. **Inconsistent hierarchy** — `chrome`/`firefox` are auth *sources*, the same
   category as the desktop import buried inside the `login` wizard, yet they sit
   as siblings of `login`.
2. **`auth chrome` is misnamed** — it doesn't log in; it only attaches a cookie
   to an existing workspace. The `cookie` alias is the honest name.
3. **Dead-end off macOS** — `chrome` hard-exits on non-Darwin, though Chrome
   *token* import works everywhere (plaintext LocalStorage).
4. **Cookie duplicated per workspace** — one shared `xoxd` written onto every
   workspace record.
5. **Desktop import has no non-interactive form** — only wizard option 1, so
   scripts/agents and non-TTY shells can't use it.
6. **Two login entry points**, one hidden (`slack login` vs `slack auth login`).

## Proposed command surface

```
slack auth login                       # interactive wizard (unchanged default)
slack auth login desktop               # import xoxc from Slack desktop app
slack auth login chrome  [-p <email|profile>]   # import workspaces from Chrome, grouped by account
slack auth login firefox [-p <profile>]
slack auth login token --token … [--name …]
slack auth login app [--bot]
slack auth ls                          # grouped: user ▸ workspaces
slack auth use <user>/<workspace> | <workspace>
slack auth logout <user>/<workspace> | <user> | <workspace>
```

- `chrome`/`firefox` are subcommands of `login`; the wizard dispatches to them.
  (`login chrome` and `login firefox` are implemented; `desktop`/`token`/`app` as
  explicit subcommands are the remaining step — for now the wizard covers them.)
- `login chrome` reads the token(s) for the chosen account and creates a workspace
  per team in one step, grouped under the account's email as the identity. The
  shared cookie is captured at rest on macOS; elsewhere it is attached separately.
- `slack auth chrome`/`cookie` still attach a cookie (the honest name is `cookie`);
  the standalone `firefox` command is unchanged. No breaking change.
- `use` accepts a bare workspace name; grouping by identity is for display and for
  sharing one cookie across an account's workspaces.

## profiles.json shape (additive, back-compat)

The stored shape keeps the flat, name-keyed `profiles` map (so every existing
caller and lockfile keeps working) and adds:

- `identity` on a workspace — the owning account (e.g. email) it was imported
  under; groups an account's workspaces for display.
- a `users` side-table — the shared `xoxd` cookie stored **once** per identity,
  instead of duplicated onto every workspace.

```jsonc
{
  "profiles": {
    "acme":    { "token": "xoxc-…A", "team": "Acme",    "url": "https://acme.slack.com/",    "identity": "alice@example.com" },
    "widgets": { "token": "xoxc-…B", "team": "Widgets", "url": "https://widgets.slack.com/", "identity": "alice@example.com" }
  },
  "users": {
    "alice@example.com": { "cookie": "xoxd-…", "source": "chrome:Profile 3" }
  },
  "current": "acme"
}
```

- **Cookie resolution**: `resolveCookie(ws)` returns the workspace's own cookie if
  present, else its identity's shared cookie from `users`. `addProfile` hoists a
  cookie to `users[identity]` when the profile has an identity, so it is never
  duplicated. `listProfiles` surfaces the effective cookie so existing readers of
  `profile.cookie` keep working.
- **Rotation**: `setUserCookie(identity, …)` rewrites one field; every workspace
  under that identity picks it up.
- **Back-compat**: old flat files (no `identity`/`users`) load unchanged; a
  workspace with a plain `cookie` and no identity behaves exactly as before.
- A fully nested `users → workspaces` schema (identity-keyed `use`,
  `user/workspace` selection) remains a possible later step; the additive shape
  delivers the same benefits without renaming profile keys.

## Open questions

- Selection ergonomics when one workspace is joined under two identities — for now
  the flat name wins; a later step could disambiguate with `--user`.
- Whether to promote `desktop`/`token`/`app` to explicit `login <source>`
  subcommands (currently reachable via the wizard).

## Status

Implemented: bundled Snappy + SSTable reader (`ts/leveldb.ts`); cross-platform
Chrome session discovery (`discoverChromeSessions`); `slack auth login chrome`
(+ wizard entry, `--profile`); identity-grouped profiles with a shared-cookie
`users` side-table; **Windows app-bound (`v20`) cookie extraction for
`slack auth cookie`** (`ts/chromeCookieWin.ts`, flags 1/2/3, one UAC prompt);
updated auth help. Tests: `tests/leveldb.test.ts`, `tests/chrome-cookie-win.test.ts`
(pure-crypto round-trips), and new cases in `tests/auth.test.ts`.

Verified on Chrome 153 / Windows 11: `slack auth cookie -w <ws>` decrypts the
`d` cookie and a read-only API call succeeds.

Remaining: `desktop`/`token`/`app` as explicit `login` subcommands; optional
fully-nested schema; the `v20` embedded keys/flags are Chrome-version-specific
and may need updating across major Chrome releases.
