// The relay turns Slack messages into instructions for local agents, so the
// filter that decides what counts as an instruction is the security boundary:
// only the token owner's own plain messages, never the relay's own posts.
import { describe, test, expect } from "./harness.ts";
import { redactSecrets, hasSecret, landedInInput, agentIdentity, mentionsUser, mentionGate, readBotToken, markDelivered, isInstruction, parseRoute, matchAgent, agentLabel, forwardText, clip, RELAY_MARK, FORWARD_PREFIX, type Agent } from "../ts/relay.ts";

const SELF = "U00000001";
const OTHER = "U00000002";

describe("isInstruction", () => {
  const own = new Set(["1700000000.000300"]);
  test("accepts the owner's plain message", () => {
    expect(isInstruction({ ts: "1700000000.000100", user: SELF, text: "@otoji hi" }, SELF, own)).toBe(true);
  });
  test("rejects anyone else, even with a route", () => {
    expect(isInstruction({ ts: "1700000000.000100", user: OTHER, text: "@otoji rm -rf" }, SELF, own)).toBe(false);
  });
  test("rejects subtypes and bot messages", () => {
    expect(isInstruction({ ts: "1", user: SELF, text: "x", subtype: "channel_join" }, SELF, own)).toBe(false);
    expect(isInstruction({ ts: "1", user: SELF, text: "x", bot_id: "B00000001" }, SELF, own)).toBe(false);
  });
  test("rejects the relay's own posts (by ts and by marker)", () => {
    expect(isInstruction({ ts: "1700000000.000300", user: SELF, text: "reply" }, SELF, own)).toBe(false);
    expect(isInstruction({ ts: "1700000000.000400", user: SELF, text: `${RELAY_MARK} *otoji*: done` }, SELF, own)).toBe(false);
  });
  test("rejects empty text and an unknown self id", () => {
    expect(isInstruction({ ts: "1", user: SELF, text: "  " }, SELF, own)).toBe(false);
    expect(isInstruction({ ts: "1", user: SELF, text: "x" }, "", own)).toBe(false);
  });
});

describe("parseRoute", () => {
  test("leading @name", () => {
    expect(parseRoute("@otoji ping")).toEqual({ route: "otoji", body: "ping" });
    expect(parseRoute("@BraDIY/mac-neck-load: status?")).toEqual({ route: "bradiy/mac-neck-load", body: "status?" });
  });
  test("no route", () => {
    expect(parseRoute(" just text ")).toEqual({ body: "just text" });
    expect(parseRoute("<@U00000001> hi")).toEqual({ body: "<@U00000001> hi" });
    expect(parseRoute("@otoji")).toEqual({ body: "@otoji" });
  });
});

describe("matchAgent", () => {
  const agents: Agent[] = [
    { pid: 101, cwd: "/home/alice/ws/acme/bradiy/tree/main", status: "idle", cli: "claude" },
    { pid: 102, cwd: "/home/alice/ws/acme/bradiy/tree/mac-neck-load", status: "idle", cli: "claude" },
    { pid: 103, cwd: "/home/alice/ws/acme/otoji/tree/main", status: "active", cli: "claude" },
  ];
  test("by repo, unique", () => expect(matchAgent("otoji", agents).agent?.pid).toBe(103));
  test("by pid", () => expect(matchAgent("102", agents).agent?.pid).toBe(102));
  test("by branch and repo/branch", () => {
    expect(matchAgent("mac-neck-load", agents).agent?.pid).toBe(102);
    expect(matchAgent("bradiy/mac-neck-load", agents).agent?.pid).toBe(102);
  });
  test("bare repo name is the main tree", () => {
    expect(matchAgent("bradiy", agents, 102).agent?.pid).toBe(101);
  });
  test("ambiguous repo without a main tree prefers the default", () => {
    const lanes = agents.filter((a) => a.pid !== 101).concat({ pid: 104, cwd: "/home/alice/ws/acme/bradiy/tree/x", status: "idle", cli: "claude" });
    expect(matchAgent("bradiy", lanes, 104).agent?.pid).toBe(104);
    expect(matchAgent("bradiy", lanes).agent).toBeUndefined();
  });
  test("unknown", () => expect(matchAgent("nope", agents).agent).toBeUndefined());
  test("labels", () => {
    expect(agentLabel(agents[0]!)).toBe("bradiy");
    expect(agentLabel(agents[1]!)).toBe("bradiy/mac-neck-load");
  });
});

describe("forwardText / clip", () => {
  test("prefixed and points at the outbox", () => {
    const t = forwardText("ping", { from: "@alice", agentPid: 103, outbox: "/tmp/ob" });
    expect(t.startsWith(FORWARD_PREFIX)).toBe(true);
    expect(t).toContain("/tmp/ob/103.md");
    expect(t).toContain("\nping\n");
  });
  test("clip bounds lines and chars", () => {
    const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    expect(clip(long, 5).split("\n").length).toBe(6);
    expect(clip("x".repeat(100), 15, 10)).toBe("x".repeat(10) + "…");
  });
});

describe("readBotToken / markDelivered", () => {
  test("reads only an xoxb- token from the dotenv file", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "relay-bot-"));
    writeFileSync(join(d, "a.env"), "# c\nSLACK_RELAY_BOT_TOKEN=xoxb-1-abc\n");
    writeFileSync(join(d, "b.env"), "SLACK_RELAY_BOT_TOKEN=xoxp-1-abc\n");
    expect(readBotToken(join(d, "a.env"))).toBe("xoxb-1-abc");
    expect(readBotToken(join(d, "b.env"))).toBeUndefined();
    expect(readBotToken(join(d, "missing.env"))).toBeUndefined();
  });
  test("a ts is delivered once; the list is capped", () => {
    const d: string[] = [];
    expect(markDelivered(d, "1.1")).toBe(true);
    expect(markDelivered(d, "1.1")).toBe(false);
    for (let i = 0; i < 10; i++) markDelivered(d, `2.${i}`, 5);
    expect(d.length).toBe(5);
  });
});

describe("mention mode", () => {
  const BOT = "U00000009";
  test("mentionsUser matches <@U…> and <@U…|name> anywhere", () => {
    expect(mentionsUser("hey <@U00000009> look", BOT)).toBe(true);
    expect(mentionsUser("<@U00000009|snobot> x", BOT)).toBe(true);
    expect(mentionsUser("hey @snobot", BOT)).toBe(false);
    expect(mentionsUser("<@U000000091> x", BOT)).toBe(false);
  });
  test("mentionGate: only a mention, or a bound thread, opens a mention-only channel", () => {
    const m = { ts: "1", user: "U00000001", text: "plain" };
    expect(mentionGate(m, { mentionsOnly: false, botId: BOT, threadBound: false })).toBe(true);
    expect(mentionGate(m, { mentionsOnly: true, botId: BOT, threadBound: false })).toBe(false);
    expect(mentionGate(m, { mentionsOnly: true, botId: BOT, threadBound: true })).toBe(true);
    expect(mentionGate({ ...m, text: "<@U00000009> go" }, { mentionsOnly: true, botId: BOT, threadBound: false })).toBe(true);
  });
});

describe("agentIdentity", () => {
  test("host:repo#worktree with a stable per-repo emoji", () => {
    const a = agentIdentity("tak", "bradiy", "main");
    expect(a.username).toBe("tak:bradiy#main");
    expect(agentIdentity("box", "bradiy", "main").icon_emoji).toBe(a.icon_emoji);
    expect(a.icon_emoji).toMatch(/^:[a-z_]+:$/);
    expect(agentIdentity("tak", "x", "y".repeat(200)).username.length).toBe(80);
  });
});

describe("landedInInput", () => {
  test("a busy agent's screen showing the pasted forward counts as delivered", () => {
    expect(landedInInput("exit 1 · last 10 lines ──\n  ✢ Garnishing…\n    paste again to expand\n")).toBe(true);
    expect(landedInInput("Press up to edit queued messages")).toBe(true);
    expect(landedInInput("warning: couldn't confirm the CLI acted on this message — it may still be sitting unsubmitted")).toBe(true);
    expect(landedInInput("target unreachable")).toBe(false);
  });
});

describe("redactSecrets", () => {
  test("Slack, Discord and GitHub tokens never reach the log", () => {
    const discord = "MTAwMDAwMDAwMDAwMDAwMDAwMA.Gabcde.abcdefghijklmnopqrstuvwxyz0123";
    expect(redactSecrets(`here ${discord} ok`)).toBe("here <redacted-secret> ok");
    expect(redactSecrets("xoxb-0000000000-abcdefghijkl")).toBe("<redacted-secret>");
    expect(redactSecrets("ghp_" + "a".repeat(36))).toBe("<redacted-secret>");
    expect(redactSecrets("plain text 1.2.3")).toBe("plain text 1.2.3");
    expect(hasSecret(discord)).toBe(true);
    expect(hasSecret("no secret")).toBe(false);
    expect(hasSecret(discord)).toBe(true); // no lastIndex carry-over
  });
});
