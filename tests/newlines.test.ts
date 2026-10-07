// Line breaks must survive into the stored `.text` on every write path, and be
// readable again on messages Slack stored flattened (2026-10-07: a `markdown`
// block made Slack regenerate `.text` with every newline as a space, so push
// previews, `read --format jsonl` and every API reader saw one long line).
//
// Spawns the TS CLI against the mock and asserts on the request bodies.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures, type RecordedRequest } from "./mock.ts";
import { markdownToRichText } from "../ts/richtext.ts";
import { askBuildText, askParseMessage } from "../ts/ask.ts";

const TS_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "ts", "cli.ts");
const SELF = "U00000001";
const BOB = "U00000BOB";
const CHAN = "C00000001";
const DM = "D00000BOB";
const TS = "1700000000.000100"; // the ts the mock's chat.postMessage returns
const MULTI = "[slack-term-nl] 换行测试\n第一行\n第二行\n\n- 第三行\n- 第四行";

let tmpHome: string;
beforeAll(() => { tmpHome = mkdtempSync(join(tmpdir(), "slack-nl-")); });
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

type RunResult = { exitCode: number; stdout: string; stderr: string };
function run(args: string[], baseUrl: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = { ...rest, HOME: tmpHome, SLACK_API_BASE: `${baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake", SLACK_TERM_ATTRIBUTION: "off", ...extraEnv };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (exitCode: number | null) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
    child.on("error", reject);
  });
}

/** Run the two-step confirm: preview, then the same args with its --code. */
async function confirmed(args: string[], baseUrl: string, env: Record<string, string> = {}): Promise<RunResult> {
  const dry = await run(args, baseUrl, env);
  const m = dry.stderr.match(/--code=([0-9a-f]{4})/);
  if (!m) throw new Error(`no --code in:\n${dry.stdout}\n${dry.stderr}`);
  return run([...args, `--code=${m[1]}`], baseUrl, env);
}

const body = (q: RecordedRequest): Record<string, unknown> =>
  (q.body.startsWith("{") ? JSON.parse(q.body) : Object.fromEntries(new URLSearchParams(q.body)));
const nl = (s: unknown): number => String(s).split("\n").length - 1;
function blockNewlines(blocks: unknown): number {
  let n = 0;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (o.type === "text" && typeof o.text === "string") n += nl(o.text);
      Object.values(o).forEach(walk);
    }
  };
  walk(blocks);
  return n;
}
/** A write that keeps `.text`: the caller's text verbatim, and rich_text
 *  blocks — never a `markdown` block, which makes Slack flatten `.text`. */
function expectKeepsText(b: Record<string, unknown>, text: string): void {
  expect(b.text).toBe(text);
  const blocks = b.blocks as Array<Record<string, unknown>>;
  expect(Array.isArray(blocks)).toBe(true);
  expect(blocks.some((x) => x.type === "markdown")).toBe(false);
  expect(blocks[0]!.type).toBe("rich_text");
}

const AUTH: InlineFixtures = {
  "auth.test": { ok: true, user_id: SELF, user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  "users.list__limit=200": { ok: true, members: [{ id: SELF, name: "user1" }, { id: BOB, name: "bob", real_name: "Bob" }] },
  [`conversations.history__channel=${CHAN}&limit=1`]: { ok: true, messages: [{ type: "message", user: BOB, text: "hi", ts: "1690000000.000100" }] },
  [`conversations.info__channel=${CHAN}`]: { ok: true, channel: { id: CHAN, name: "channel-01" } },
  "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
    ok: true, channels: [{ id: CHAN, name: "channel-01", is_channel: true }], response_metadata: { next_cursor: "" },
  },
  [`chat.getPermalink__channel=${CHAN}&message_ts=${TS}`]: { ok: true, channel: CHAN, permalink: `https://acme.slack.com/archives/${CHAN}/p1700000000000100` },
};

describe("every write path keeps the caller's line breaks in .text", { timeout: 90_000 }, () => {
  test("send: text verbatim + rich_text blocks that render the same lines", async () => {
    const m = await startMock({ inline: AUTH });
    try {
      const r = await confirmed(["send", "#channel-01", MULTI, "--channel-id", CHAN, "--no-mentions"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const b = body(m.requests.find((q) => q.method === "chat.postMessage")!);
      expectKeepsText(b, MULTI);
      expect(nl(b.text)).toBe(5);
      // The blocks show the same lines: each list item is its own row, so the
      // two `- ` lines need no \n of their own.
      expect(b.blocks).toEqual(markdownToRichText(MULTI));
      expect(blockNewlines(b.blocks)).toBe(4);
    } finally {
      await m.stop();
    }
  });

  test("send as a thread reply", async () => {
    const parent = "1690000000.000100";
    const m = await startMock({ inline: {
      ...AUTH,
      [`conversations.replies__channel=${CHAN}&limit=100&ts=${parent}`]: { ok: true, messages: [{ type: "message", user: BOB, text: "parent", ts: parent }] },
    } });
    try {
      const r = await confirmed(["send", `#channel-01:${parent}`, MULTI, "--channel-id", CHAN, "--no-mentions"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const b = body(m.requests.find((q) => q.method === "chat.postMessage")!);
      expect(b.thread_ts).toBe(parent);
      expectKeepsText(b, MULTI);
    } finally {
      await m.stop();
    }
  });

  test("send --as-bot (bot token)", async () => {
    const m = await startMock({ inline: {
      ...AUTH,
      "auth.test": { ok: true, user_id: "U00000BOT", bot_id: "B00000001", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
    } });
    try {
      const env = { SLACK_BOT_TOKEN: "xoxb-fake" };
      const r = await confirmed(["send", "#channel-01", MULTI, "--channel-id", CHAN, "--as-bot", "--no-mentions"], m.baseUrl, env);
      expect(r.exitCode).toBe(0);
      const post = m.requests.find((q) => q.method === "chat.postMessage")!;
      expect(post.headers.authorization).toBe("Bearer xoxb-fake");
      expectKeepsText(body(post), MULTI);
    } finally {
      await m.stop();
    }
  });

  test("edit of an ordinary message", async () => {
    const m = await startMock({ inline: {
      ...AUTH,
      [`conversations.replies__channel=${CHAN}&limit=1&ts=${TS}`]: { ok: true, messages: [{ type: "message", user: SELF, ts: TS, text: "old" }] },
    } });
    try {
      const r = await confirmed(["edit", `#chan:${TS}`, MULTI, "--channel-id", CHAN, "--no-mentions"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expectKeepsText(body(m.requests.find((q) => q.method === "chat.update")!), MULTI);
    } finally {
      await m.stop();
    }
  });

  test("schedule send", async () => {
    const m = await startMock({ inline: AUTH });
    try {
      const r = await confirmed(["schedule", "send", "#channel-01", MULTI, "--at", "2099-01-01T00:00:00Z", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expectKeepsText(body(m.requests.find((q) => q.method === "chat.scheduleMessage")!), MULTI);
    } finally {
      await m.stop();
    }
  });

  test("ask and poll stay plain (no blocks): Slack keeps their text, which their parsers read back", async () => {
    const m = await startMock({ inline: AUTH });
    try {
      const a = await confirmed(["ask", "#chan", "@bob 出してよい?", "はい", "まって", "--channel-id", CHAN, "--body", "背景: 1行目\n2行目"], m.baseUrl);
      expect(a.exitCode).toBe(0);
      const ab = body(m.requests.find((q) => q.method === "chat.postMessage")!);
      expect(ab.blocks).toBeUndefined();
      expect(String(ab.text)).toContain("背景: 1行目\n2行目");
      expect(askParseMessage(String(ab.text)).kind).toBe("open");
    } finally {
      await m.stop();
    }
    const p = await startMock({ inline: AUTH });
    try {
      const r = await confirmed(["poll", "#chan", "どれ?", "A", "B", "--channel-id", CHAN], p.baseUrl);
      expect(r.exitCode).toBe(0);
      const pb = body(p.requests.find((q) => q.method === "chat.postMessage")!);
      expect(pb.blocks).toBeUndefined();
      expect(nl(pb.text)).toBeGreaterThan(1);
    } finally {
      await p.stop();
    }
  });

  test("if Slack refuses the converted blocks, the send is retried once with the markdown block", async () => {
    const m = await startMock({ inline: {
      ...AUTH,
      "chat.postMessage": { __whenBodyIncludes: { needle: "rich_text", response: { ok: false, error: "invalid_blocks" } } },
    } });
    try {
      const r = await confirmed(["send", "#channel-01", MULTI, "--channel-id", CHAN, "--no-mentions"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const posts = m.requests.filter((q) => q.method === "chat.postMessage").map(body);
      expect(posts).toHaveLength(2);
      expect((posts[1]!.blocks as Array<Record<string, unknown>>)[0]).toEqual({ type: "markdown", text: MULTI });
    } finally {
      await m.stop();
    }
  });

  test("markdown the converter does not model (a heading) keeps the markdown block", async () => {
    const m = await startMock({ inline: AUTH });
    try {
      const r = await confirmed(["send", "#channel-01", "# 見出し\n本文", "--channel-id", CHAN, "--no-mentions"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const b = body(m.requests.find((q) => q.method === "chat.postMessage")!);
      expect(b.blocks).toEqual([{ type: "markdown", text: "# 見出し\n本文" }]);
    } finally {
      await m.stop();
    }
  });
});

// A message sent with the old `markdown` block, as Slack stored it: `.text`
// with every newline as a space; the blocks still have the breaks.
const flat = (md: string) => ({ type: "message", user: SELF, ts: TS, text: md.replace(/\n/g, " "), blocks: markdownToRichText(md) });

describe("readers show line breaks for old flattened messages", { timeout: 90_000 }, () => {
  test("read --format jsonl", async () => {
    const m = await startMock({ inline: {
      ...AUTH,
      [`conversations.history__channel=${CHAN}&limit=20`]: { ok: true, messages: [flat(MULTI)] },
    } });
    try {
      const r = await run(["read", "#channel-01", "--format", "jsonl"], m.baseUrl);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout.trim().split("\n")[0]!).text).toBe(MULTI);
    } finally {
      await m.stop();
    }
  });

  test("thread --format jsonl", async () => {
    const m = await startMock({ inline: {
      ...AUTH,
      [`conversations.replies__channel=${CHAN}&limit=100&ts=${TS}`]: { ok: true, messages: [flat(MULTI)] },
    } });
    try {
      const r = await run(["thread", "#channel-01", TS, "--format", "jsonl"], m.baseUrl);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout.trim().split("\n")[0]!).text).toBe(MULTI);
    } finally {
      await m.stop();
    }
  });

  test("ask --waitFor collects a flattened ask, and the ✅ rewrite keeps its lines", async () => {
    const Q = askBuildText(`<@${BOB}> どっち?`, "背景: リリース前\n推奨: B", ["A", "B"], [], false);
    const msg = { ...flat(Q), reactions: [{ name: "two", users: [SELF, BOB], count: 2 }] };
    const m = await startMock({ inline: {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      [`conversations.history__channel=${DM}&inclusive=true&limit=1&oldest=${TS}`]: { ok: true, messages: [msg] },
      [`conversations.history__channel=${DM}&inclusive=true&limit=30&oldest=${TS}`]: { ok: true, messages: [msg] },
      [`conversations.history__channel=${DM}&limit=1`]: { ok: true, messages: [] },
    } });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${TS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("B");
      const upd = body(m.requests.find((q) => q.method === "chat.update")!);
      expect(askParseMessage(String(upd.text)).kind).toBe("resolved");
      expect(String(upd.text)).toContain("背景: リリース前\n推奨: B");
    } finally {
      await m.stop();
    }
  });
});
