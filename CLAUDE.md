# slack-term dev rules

## No real workspace data in this repo

This repo is public (GitHub + npm), and its fixtures come from **real** Slack
recordings — so real names, workspace subdomains and channel IDs have leaked in
before. Nothing that identifies a real person or workspace may be committed:
in test data, in fixture **filenames**, or in source comments.

Use placeholders: `alice` / `bob` / `山田` / `鈴木`, `acme.slack.com`,
`C00000001` / `U00000001` (a `0000` run marks an ID as fake).

A `.githooks/pre-commit` hook enforces this and blocks the commit. `bun install`
points `core.hooksPath` at it; set it manually with
`git config core.hooksPath .githooks`. Run it on demand with `bun run scan-pii`.
`--no-verify` bypasses it — only for a genuine false positive.

Re-record fixtures with `bun run record` and **always** `bun run anonymize`
before committing them; the anonymizer scrubs bodies *and* filenames.

## QA / Testing

**Read-only only.** Never run `send`, `edit`, `upload`, `react`, `drafts` (create/send), or any other write command against real Slack during QA or verification.
Only these commands are safe to run: `read`, `thread`, `channel ls/get`, `user ls/get`, `search`, `news`, `download`, `auth ls`.

Rationale: commands hit real workspaces — write commands would post/edit/react on real messages.

## Slack usage etiquette (for anyone — human or agent — driving this CLI)

These rules keep threads readable and avoid noise. They apply to real usage, not QA.

- **Prefer a reaction over a message for simple acknowledgements.** Don't post "了解"/"見ました"/"やっておきます" as a reply — react instead, so the thread doesn't grow:
  - 了解 / 受領 → `slack react "<target>" eyes` (👀)
  - 完了 / done → `slack react "<target>" white_check_mark` (✅)
  - 処理中 / working on it → `slack react "<target>" hourglass_flowing_sand` (⏳)
  - `target` is the same `#chan:<ts>` / permalink form as `send`/`edit`. Use `--remove` to take a reaction back.
- **Read the thread before replying.** Run `slack thread "#chan" <ts>` (or `slack read` on the permalink) first to see what's already been said — don't repeat a point someone (including you) already made. The `send` confirm gate previews the thread's recent messages and warns when your text is near-identical to an existing reply, but reading first is still the rule.
- **Consolidate.** When you have several things to say, put them in one message rather than firing off multiple replies.
