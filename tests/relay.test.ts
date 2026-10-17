// The relay turns Slack messages into instructions for local agents, so the
// filter that decides what counts as an instruction is the security boundary:
// only the token owner's own plain messages, never the relay's own posts.
import { describe, test, expect } from "./harness.ts";
import { isInstruction, parseRoute, matchAgent, agentLabel, forwardText, clip, RELAY_MARK, FORWARD_PREFIX, type Agent } from "../ts/relay.ts";

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
