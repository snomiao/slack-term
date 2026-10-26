// Refuse to act as the USER when the caller clearly meant the BOT.
//
// SLACK_BOT_TOKEN is only ever used by `--as-bot`: its documented home is the
// global ~/.config/slack-cli/.env, where it sits for `slack ask` and friends,
// and it must not turn every post into a bot post. But a lane that EXPORTS it
// (or puts it in its project's .env) without SLACK_TOKEN is saying "I am the
// bot" — and without --as-bot every write still went out under the logged-in
// person's session, silently (reported 2026-10-26: a lane posted a pinlog as
// the user). In that case writes are refused until the caller picks a side.

/** Write commands, as `argv._` spells them (aliases included). Read-only
 *  commands are never refused — reading as the user impersonates no one. */
const WRITES = new Set([
  "send", "ask", "poll", "vote", "edit", "delete", "react", "upload",
  "schedule send", "schedule rm",
  "pinlog new", "pinlog set", "pinlog note", "pinlog pin",
  "todo set", "todo flag",
  "lists create", "lists add", "lists set", "lists share",
  "drafts new", "drafts save", "drafts edit", "drafts update", "drafts delete", "drafts rm",
  "channel create", "channel new", "channel rename",
]);

export function isWriteCommand(path: (string | number)[]): boolean {
  const [a = "", b = ""] = path.map(String);
  return WRITES.has(a) || WRITES.has(`${a} ${b}`);
}

export type BotIntent = {
  /** Where SLACK_BOT_TOKEN (an xoxb-) came from: "shell", a dotenv path, or undefined when unset. */
  botTokenSource: string | undefined;
  /** dotenv paths that are the bot token's GLOBAL home — not a statement of intent. */
  globalPaths: string[];
  slackTokenSet: boolean;
  /** The token this command would act with is itself the bot token (no profiles). */
  activeTokenIsBot: boolean;
};

/** A refusal message, or null when the write may proceed. */
export function botIntentRefusal(
  cmd: (string | number)[],
  argv: Record<string, unknown>,
  intent: BotIntent,
): string | null {
  const src = intent.botTokenSource;
  if (!src || intent.globalPaths.includes(src)) return null;
  if (intent.slackTokenSet || intent.activeTokenIsBot) return null;
  if (!isWriteCommand(cmd) || argv["as-bot"] === true) return null;
  const from = src === "shell" ? "exported in the environment" : `set in ${src}`;
  const canBot = "as-bot" in argv;
  return [
    `Error: refusing to act as YOU — SLACK_BOT_TOKEN is ${from}, but \`${cmd.slice(0, 2).join(" ")}\` would use your user session, not the bot.`,
    canBot
      ? "  As the app:   add --as-bot"
      : "  This command has no --as-bot: it can only act as a user.",
    "  As yourself:  set SLACK_TOKEN, or clear the bot token for this run (SLACK_BOT_TOKEN= slack ...)",
  ].join("\n");
}
