import { describe, test, expect } from "./harness.ts";
import { botIntentRefusal, isWriteCommand } from "../ts/botIntent.ts";

const GLOBAL = ["/home/alice/.config/slack-cli/.env"];
const intent = (o: Partial<Parameters<typeof botIntentRefusal>[2]> = {}) => ({
  botTokenSource: "shell", globalPaths: GLOBAL, slackTokenSet: false, activeTokenIsBot: false, ...o,
});

describe("isWriteCommand", () => {
  test("top-level and nested writes, aliases included", () => {
    for (const c of [["send"], ["vote"], ["react"], ["pinlog", "new"], ["pinlog", "pin"], ["schedule", "send"], ["drafts", "save"], ["lists", "share"], ["channel", "new"]]) {
      expect(isWriteCommand(c)).toBe(true);
    }
  });
  test("reads are not writes", () => {
    for (const c of [["read"], ["pinlog", "ls"], ["pinlog", "get"], ["schedule", "ls"], ["drafts"], ["lists"], ["channel", "ls"], []]) {
      expect(isWriteCommand(c)).toBe(false);
    }
  });
});

describe("botIntentRefusal", () => {
  test("refuses a write as the user when the bot token was exported", () => {
    const msg = botIntentRefusal(["pinlog", "new", "#ops"], { "as-bot": false }, intent());
    expect(msg).toContain("refusing to act as YOU");
    expect(msg).toContain("SLACK_BOT_TOKEN is exported in the environment");
    expect(msg).toContain("`pinlog new`");
    expect(msg).toContain("add --as-bot");
  });

  test("names a project dotenv file as the source", () => {
    expect(botIntentRefusal(["send"], { "as-bot": false }, intent({ botTokenSource: "/w/proj/.env" })))
      .toContain("SLACK_BOT_TOKEN is set in /w/proj/.env");
  });

  test("a command with no --as-bot says so", () => {
    const msg = botIntentRefusal(["upload"], {}, intent());
    expect(msg).toContain("has no --as-bot");
    expect(msg).not.toContain("add --as-bot");
  });

  test("allows: --as-bot, reads, no/global bot token, SLACK_TOKEN set, bot is the active token", () => {
    expect(botIntentRefusal(["send"], { "as-bot": true }, intent())).toBeNull();
    expect(botIntentRefusal(["read"], {}, intent())).toBeNull();
    expect(botIntentRefusal(["send"], {}, intent({ botTokenSource: undefined }))).toBeNull();
    expect(botIntentRefusal(["send"], {}, intent({ botTokenSource: GLOBAL[0] }))).toBeNull();
    expect(botIntentRefusal(["send"], {}, intent({ slackTokenSet: true }))).toBeNull();
    expect(botIntentRefusal(["send"], {}, intent({ activeTokenIsBot: true }))).toBeNull();
  });
});
