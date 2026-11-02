// The relay turns Slack messages into instructions for local agents, so the
// filter that decides what counts as an instruction is the security boundary:
// only the token owner's own plain messages, never the relay's own posts.
import { describe, test, expect } from "./harness.ts";
import { stripSelfMention, isSlackFileUrl, audioFiles, slackTranscript, voiceText, wakeTarget, parseWake, wakeNote, sharedText, splitOutbox, liveliest, laneIdentity, actsHere, threadHostOf, redactSecrets, hasSecret, landedInInput, agentIdentity, mentionsUser, mentionGate, readBotToken, markDelivered, isInstruction, parseRoute, matchAgent, agentLabel, forwardText, splitForSlack, RELAY_MARK, FORWARD_PREFIX, type Agent } from "../ts/relay.ts";

const SELF = "U00000001";
const OTHER = "U00000002";

describe("voice messages", () => {
  const clip = { id: "F00000001", subtype: "slack_audio", mimetype: "audio/mp4", filetype: "m4a" };
  test("a voice-only message from the owner is an instruction; an image-only one is not", () => {
    expect(isInstruction({ ts: "1.1", user: SELF, text: "", files: [clip] }, SELF, new Set())).toBe(true);
    expect(isInstruction({ ts: "1.1", user: SELF, text: "", files: [{ id: "F00000002", mimetype: "image/png" }] }, SELF, new Set())).toBe(false);
    expect(isInstruction({ ts: "1.1", user: OTHER, text: "", files: [clip] }, SELF, new Set())).toBe(false);
  });
  test("audioFiles picks clips and audio uploads", () => {
    const m = { ts: "1.1", files: [clip, { id: "F00000002", mimetype: "audio/webm" }, { id: "F00000003", mimetype: "image/png" }] };
    expect(audioFiles(m).map((f) => f.id)).toEqual(["F00000001", "F00000002"]);
  });
  test("Slack's transcript is used only when complete and whole", () => {
    expect(slackTranscript({ ...clip, transcription: { status: "complete", preview: { content: " 你好 ", has_more: false } } })).toBe("你好");
    expect(slackTranscript({ ...clip, transcription: { status: "complete", preview: { content: "你好", has_more: true } } })).toBeUndefined();
    expect(slackTranscript({ ...clip, transcription: { status: "processing" } })).toBeUndefined();
    expect(slackTranscript(clip)).toBeUndefined();
  });
  test("a voice-only message is not reported as a bare mention", () => {
    expect(stripSelfMention("", "U00000009", "snobot")).toBe("");
    expect(stripSelfMention("<@U00000009>", "U00000009", "snobot")).toBe("(you were mentioned, no text)");
  });
  test("a token is only ever sent to https://files.slack.com", () => {
    expect(isSlackFileUrl("https://files.slack.com/files-pri/T00000001-F00000001/download/clip.m4a")).toBe(true);
    expect(isSlackFileUrl("http://files.slack.com/x")).toBe(false);
    expect(isSlackFileUrl("https://files.slack.com.evil.example/x")).toBe(false);
    expect(isSlackFileUrl("https://evil.example/files.slack.com/x")).toBe(false);
    expect(isSlackFileUrl("not a url")).toBe(false);
  });
  test("voiceText quotes each transcript and names failures", () => {
    expect(voiceText([{ text: "line1\nline2" }, { error: "no speech recognised" }]))
      .toBe("[voice message, transcribed]\n> line1\n> line2\n\n[voice message — could not transcribe: no speech recognised]");
  });
});

describe("isInstruction", () => {
  test("a forwarded message is passed on, quoted, with its author and link", () => {
    const m = {
      ts: "1", user: SELF, text: "fix it",
      attachments: [{ is_share: true, author_name: "alice", text: "line one\nline two", from_url: "https://acme.slack.com/archives/C00000001/p1700000000000100" }],
    };
    expect(sharedText(m)).toBe("[forwarded message from @alice, https://acme.slack.com/archives/C00000001/p1700000000000100]\n> line one\n> line two");
    expect(sharedText({ ts: "1", attachments: [{ text: "a link preview" }] })).toBe("");
    // A bare forward with no comment of its own is still the owner speaking.
    expect(isInstruction({ ...m, text: "" }, SELF, new Set())).toBe(true);
  });
  test("an owner upload whose files an agent posted is not an instruction", () => {
    const own = new Set<string>();
    const agentFiles = new Set(["F00000001"]);
    const m = { ts: "1", user: SELF, text: "chart attached", files: [{ id: "F00000001" }] };
    expect(isInstruction(m, SELF, own, agentFiles)).toBe(false);
    expect(isInstruction({ ...m, files: [{ id: "F00000001" }, { id: "F00000002" }] }, SELF, own, agentFiles)).toBe(true);
    expect(isInstruction(m, SELF, own)).toBe(true);
  });
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
  test("Windows cwds (backslashes, as `ay ls` reports them) resolve the same way", () => {
    const win: Agent[] = [
      { pid: 201, cwd: "C:\\Users\\alice\\ws\\acme\\bradiy\\tree\\main", status: "active", cli: "claude" },
      { pid: 202, cwd: "C:\\Users\\alice\\ws\\acme\\bradiy\\tree\\lane\\stt", status: "idle", cli: "claude" },
    ];
    expect(matchAgent("bradiy", win).agent?.pid).toBe(201);
    expect(matchAgent("bradiy/lane/stt", win).agent?.pid).toBe(202);
    expect(agentLabel(win[0]!)).toBe("bradiy");
    expect(agentLabel(win[1]!)).toBe("bradiy/lane/stt");
  });
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
  test("splitForSlack keeps every line, splitting long text into parts", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(splitForSlack(long)).toEqual([long]);
    const parts = splitForSlack(long, 60);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 60)).toBe(true);
    expect(parts.join("\n")).toBe(long);
  });
  test("splitForSlack hard-cuts one over-long line without losing chars", () => {
    const parts = splitForSlack("x".repeat(250), 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join("")).toBe("x".repeat(250));
  });
  test("splitForSlack closes and reopens a code fence at a cut", () => {
    const text = ["intro", "```", ...Array.from({ length: 20 }, (_, i) => `code ${i}`), "```", "outro"].join("\n");
    const parts = splitForSlack(text, 80);
    for (const p of parts) expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(parts.join("\n").replace(/\n```\n```/g, "")).toBe(text);
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

describe("multi-machine: exactly one relay acts", () => {
  test("parseRoute takes an optional host", () => {
    expect(parseRoute("@jr:bradiy status?")).toEqual({ host: "jr", route: "bradiy", body: "status?" });
    expect(parseRoute("@bradiy: status?")).toEqual({ route: "bradiy", body: "status?" });
  });
  const both = (o: Omit<Parameters<typeof actsHere>[0], "host">) => [actsHere({ ...o, host: "mac" }), actsHere({ ...o, host: "JR" })];
  test("unrouted → the channel home only", () => {
    expect(both({ home: "jr", boundHere: false })).toEqual([false, true]);
    expect(both({ boundHere: false })).toEqual([true, true]); // no home: single-machine setups unchanged
  });
  test("a host route wins over home and bindings", () => {
    expect(both({ home: "jr", routeHost: "mac", boundHere: false })).toEqual([true, false]);
  });
  test("a thread stays with the machine whose agent posts in it", () => {
    expect(both({ home: "jr", boundHere: false, threadHost: "mac" })).toEqual([true, false]);
    expect(actsHere({ host: "mac", home: "jr", boundHere: true })).toBe(true);
  });
  test("threadHostOf reads the latest agent identity", () => {
    expect(threadHostOf([
      { ts: "1", user: "U00000001", text: "hi" },
      { ts: "2", bot_id: "B00000001", username: "jr:bradiy#main", text: "a" },
      { ts: "3", bot_id: "B00000001", text: "plain notice" },
      { ts: "4", bot_id: "B00000001", username: "mac:bradiy#lane/x", text: "b" },
      { ts: "5", user: "U00000001", text: "next" },
    ])).toBe("mac");
    expect(threadHostOf([{ ts: "1", user: "U00000001", username: "x:y" }])).toBeUndefined();
  });
});

describe("same-name agents and lane identity", () => {
  const stuck: Agent = { pid: 301, cwd: "C:\\Users\\alice\\ws\\acme\\bradiy\\tree\\main", status: "idle", cli: "codex", seen: 1_000 };
  const live: Agent = { pid: 302, cwd: "C:\\Users\\alice\\ws\\acme\\bradiy\\tree\\main", status: "idle", cli: "claude", seen: 9_000 };
  test("the default route picks the agent that printed last, not the first listed", () => {
    expect(matchAgent("bradiy", [stuck, live]).agent?.pid).toBe(302);
    expect(liveliest([live, { ...stuck, status: "active" }])?.pid).toBe(301); // working right now wins
  });
  test("two agents in one non-main worktree are not ambiguous", () => {
    const a = { ...stuck, cwd: "/w/acme/bradiy/tree/lane/x" }, b = { ...live, cwd: "/w/acme/bradiy/tree/lane/x" };
    expect(matchAgent("bradiy/lane/x", [a, b]).agent?.pid).toBe(302);
  });
  test("laneIdentity matches the relay's agent identity", () => {
    expect(laneIdentity("/Users/alice/ws/acme/bradiy/tree/mac-blueprint", "mac").username).toBe("mac:bradiy#mac-blueprint");
    expect(threadHostOf([{ ts: "1", bot_id: "B00000001", username: laneIdentity("/w/acme/bradiy/tree/main", "mac").username }])).toBe("mac");
  });
});

describe("splitOutbox", () => {
  test("plain text is a reply", () => expect(splitOutbox("hi\n")).toEqual({ reply: "hi", threads: [] }));
  test("marker lines open new top-level threads", () => {
    expect(splitOutbox("done\n--- new thread ---\n日本語\n  --- New Thread ---  \n中文\n")).toEqual({ reply: "done", threads: ["日本語", "中文"] });
    expect(splitOutbox("--- new thread ---\nonly new")).toEqual({ reply: "", threads: ["only new"] });
  });
  test("a dash rule inside a reply is just text", () => expect(splitOutbox("a\n---\nb").threads).toEqual([]));
});

describe("deliverable (ay send's length cap)", () => {
  test("a short forward goes as is", async () => {
    const { deliverable } = await import("../ts/relay.ts");
    const msg = forwardText("ping", { from: "@alice", agentPid: 103, outbox: "/tmp/ob" });
    expect(deliverable(msg, { from: "@alice", file: "/tmp/in/1.md" })).toEqual({ text: msg, spill: false });
  });
  test("a long forward becomes a short pointer to the file and the thread", async () => {
    const { deliverable, AY_BODY_MAX } = await import("../ts/relay.ts");
    const msg = forwardText("長".repeat(2000), { from: "@alice", agentPid: 103, outbox: "/tmp/ob" });
    const d = deliverable(msg, { from: "@alice", file: "/tmp/in/1.md", readCmd: "slack thread -w ws 'C1' 1.2" });
    expect(d.spill).toBe(true);
    expect(d.text.length).toBeLessThanOrEqual(AY_BODY_MAX);
    expect(d.text).toContain("cat /tmp/in/1.md");
    expect(d.text).toContain("slack thread -w ws 'C1' 1.2");
    expect(d.text.startsWith(FORWARD_PREFIX)).toBe(true);
  });
});

describe("lane wake (no running agent takes a message)", () => {
  test("target: the exited agent's checkout, else the route, else the default", () => {
    expect(wakeTarget({ boundCwd: "/w/acme/tree/main", route: "otoji", defaultAgent: "slack-term" })).toBe("/w/acme/tree/main");
    expect(wakeTarget({ route: "otoji", defaultAgent: "slack-term" })).toBe("otoji");
    expect(wakeTarget({ defaultAgent: "slack-term" })).toBe("slack-term");
  });
  test("a pid or repo/branch names no checkout; nothing usable → no target", () => {
    expect(wakeTarget({ route: "12345", defaultAgent: "slack-term" })).toBe("slack-term");
    expect(wakeTarget({ route: "acme/feat-x" })).toBeUndefined();
    expect(wakeTarget({ defaultAgent: "4242" })).toBeUndefined();
    expect(wakeTarget({})).toBeUndefined();
  });
  test("parseWake reads the last JSON line; errors and junk are not ok", () => {
    expect(parseWake('log line\n{"ok":true,"action":"resumed","lane":"acme","pid":77,"agentId":"a1","note":"session s1"}\n'))
      .toEqual({ ok: true, action: "resumed", lane: "acme", pid: 77, note: "session s1" });
    expect(parseWake('{"ok":false,"error":"no checkout for nope"}')).toEqual({ ok: false, error: "no checkout for nope" });
    expect(parseWake("").ok).toBe(false);
    expect(parseWake("bun: command not found")).toEqual({ ok: false, error: "lane wake printed no result: bun: command not found" });
  });
  test("a note for resumed / started / revived, none when it was already running", () => {
    expect(wakeNote({ ok: true, action: "resumed", lane: "acme", pid: 77, note: "session s1" })).toBe("▶ resumed lane acme (pid 77, session s1)");
    expect(wakeNote({ ok: true, action: "started", lane: "acme", pid: 78 })).toBe("▶ started a fresh lane acme (pid 78)");
    expect(wakeNote({ ok: true, action: "running", lane: "acme", pid: 79 })).toBeUndefined();
  });
});
