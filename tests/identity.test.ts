// slack @<who>: identity lookup, applying it, and the user-session guard. Bun-only (Bun.YAML).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIdentity, inAgent, listIdentities, splitWho, userSessionRefusal } from "../ts/identity.ts";

const fakeBot = ["xox", "b-", "0000000000-0000000000000-", "faketokenfaketokenfake00"].join("");
const fakeUser = ["xox", "p-", "0000000000-0000000000-0000000000000-", "0".repeat(32)].join("");
let root: string;
const prevHome = process.env.SLACK_TERM_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ident-"));
  process.env.SLACK_TERM_HOME = join(root, "global");
  mkdirSync(join(root, "lane", ".slack-term"), { recursive: true });
  writeFileSync(join(root, "bot.env"), `# a comment\nexport SLACK_BOT_TOKEN="${fakeBot}"\n`);
  writeFileSync(join(root, "user.env"), `SLACK_TOKEN=${fakeUser}\n`);
  writeFileSync(join(root, "lane", ".slack-term", "settings.yml"),
    `identities:\n  sybot:\n    kind: bot\n    env_file: ${join(root, "bot.env")}\n  alice:\n    kind: user\n    env_file: ${join(root, "user.env")}\n  acme-alice:\n    kind: user\n    profile: acme\n  broken:\n    kind: bot\n    env_file: ${join(root, "user.env")}\n    env: SLACK_TOKEN\n`);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.SLACK_TERM_HOME;
  else process.env.SLACK_TERM_HOME = prevHome;
});

describe("splitWho", () => {
  test("@name first", () => expect(splitWho(["@sybot", "send", "x"])).toEqual({ who: "sybot", rest: ["send", "x"] }));
  test("no @", () => expect(splitWho(["send", "@bob", "x"])).toEqual({ rest: ["send", "@bob", "x"] }));
  test("@ alone or odd chars are not a name", () => expect(splitWho(["@", "x"]).who).toBeUndefined());
});

describe("applyIdentity", () => {
  const ids = () => listIdentities(join(root, "lane"));
  test("a bot: its token becomes SLACK_BOT_TOKEN and SLACK_TOKEN, nothing printed", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyIdentity("sybot", env, ids())).toEqual({ kind: "bot" });
    expect(env.SLACK_BOT_TOKEN).toBe(fakeBot);
    expect(env.SLACK_TOKEN).toBe(fakeBot);
  });
  test("a user from an env file: SLACK_TOKEN, and no bot token left", () => {
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: fakeBot };
    expect(applyIdentity("alice", env, ids())).toEqual({ kind: "user" });
    expect(env.SLACK_TOKEN).toBe(fakeUser);
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
  });
  test("a user by profile: SLACK_WORKSPACE", () => {
    const env: NodeJS.ProcessEnv = { SLACK_TOKEN: "x" };
    expect(applyIdentity("acme-alice", env, ids())).toEqual({ kind: "user" });
    expect(env.SLACK_WORKSPACE).toBe("acme");
    expect(env.SLACK_TOKEN).toBeUndefined();
  });
  test("unknown: lists the known ones", () => {
    const r = applyIdentity("nobody", {}, ids());
    expect("error" in r && r.error).toContain("Known: @acme-alice, @alice, @broken, @sybot");
  });
  test("a 'bot' whose token is not xoxb- is refused", () => {
    expect(applyIdentity("broken", {}, ids())).toEqual({ error: "@broken is a bot, but SLACK_TOKEN is not a bot token (xoxb-)" });
  });
});

describe("userSessionRefusal (the 11-02 'posted as taku' trap)", () => {
  const base = { isWrite: true, asBot: false, asUser: false, activeIsBot: false, identities: [] as string[], cmd: "ask" };
  test("inside an agent, a write as the user session is refused", () => {
    expect(userSessionRefusal({ ...base, agent: "AY_AGENT_ID" })).toContain("refusing to post as the user session from inside an agent");
  });
  test("…unless it names who, or says --as-bot / --as-user, or the token is a bot's", () => {
    for (const o of [{ who: "sybot" }, { asBot: true }, { asUser: true }, { activeIsBot: true }]) {
      expect(userSessionRefusal({ ...base, agent: "AY_AGENT_ID", ...o })).toBeNull();
    }
  });
  test("reads are never refused", () => expect(userSessionRefusal({ ...base, isWrite: false, agent: "CLAUDECODE" })).toBeNull());
  test("outside an agent: refused only when several identities exist", () => {
    expect(userSessionRefusal({ ...base })).toBeNull();
    expect(userSessionRefusal({ ...base, identities: ["sybot"] })).toBeNull();
    expect(userSessionRefusal({ ...base, identities: ["sybot", "taku"] })).toContain("several identities are configured (@sybot | @taku)");
  });
  test("inAgent names the variable", () => {
    expect(inAgent({ AGENT_YES_PID: "1" })).toBe("AGENT_YES_PID");
    expect(inAgent({})).toBeUndefined();
  });
});
