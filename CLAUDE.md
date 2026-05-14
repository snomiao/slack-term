# slack-term dev rules

## QA / Testing

**Read-only only.** Never run `send`, `edit`, `upload`, `drafts` (create/send), or any other write command against real Slack during QA or verification.
Only these commands are safe to run: `read`, `thread`, `channel ls/get`, `user ls/get`, `search`, `news`, `auth ls`.

Rationale: commands hit real workspaces — write commands would post/edit real messages.
