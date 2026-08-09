// CLI integration tests for thread visibility in `slack read`:
//   - `--format text` marks thread parents with `[+N replies]`
//   - `--json` carries reply_count / reply_users_count / latest_reply through
//   - `--unreplied` keeps only conversations whose last word isn't ours
//
// Regression context: top-level history rendered replies invisibly, so a reader
// could not tell a post with 3 replies from one with none and silently missed
// everything said inside the thread.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

let tmpHome: string;

beforeAll(() => { tmpHome = mkdtempSync(join(tmpdir(), "slack-read-")); });
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

function run(args: string[], baseUrl: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${baseUrl}/api`,
    SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (code: number | null) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

const SELF = "U00000001";
const OTHER = "U0000OTHER";

// Three top-level messages: a thread we already answered, a thread whose newest
// reply is somebody else's, and a plain post from somebody else.
const PARENT_ANSWERED = "1700000001.000100";
const PARENT_WAITING = "1700000002.000100";
const PLAIN_OTHER = "1700000003.000100";

const FIXTURES: InlineFixtures = {
  "auth.test": { ok: true, user_id: SELF, user: "me", team: "Acme", team_id: "T1", url: "https://acme.slack.com/" },
  "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
    ok: true, channels: [{ id: "C00000001", name: "general" }],
  },
  [`users.info__user=${SELF}`]: { ok: true, user: { id: SELF, name: "me", profile: { display_name: "me" } } },
  [`users.info__user=${OTHER}`]: { ok: true, user: { id: OTHER, name: "other", profile: { display_name: "other" } } },
  "conversations.history__channel=C00000001&limit=20": {
    ok: true,
    messages: [
      { type: "message", ts: PLAIN_OTHER, user: OTHER, text: "plain post, no thread" },
      {
        type: "message", ts: PARENT_WAITING, user: SELF, thread_ts: PARENT_WAITING,
        text: "asked a question", reply_count: 2, reply_users_count: 1, latest_reply: "1700000002.000300",
      },
      {
        type: "message", ts: PARENT_ANSWERED, user: OTHER, thread_ts: PARENT_ANSWERED,
        text: "customer asked", reply_count: 1, reply_users_count: 1, latest_reply: "1700000001.000200",
      },
    ],
  },
  [`conversations.replies__channel=C00000001&limit=200&ts=${PARENT_WAITING}`]: {
    ok: true,
    messages: [
      { type: "message", ts: PARENT_WAITING, user: SELF, thread_ts: PARENT_WAITING, text: "asked a question" },
      { type: "message", ts: "1700000002.000200", user: OTHER, thread_ts: PARENT_WAITING, text: "here you go" },
      { type: "message", ts: "1700000002.000300", user: OTHER, thread_ts: PARENT_WAITING, text: "and one more thing" },
    ],
  },
  [`conversations.replies__channel=C00000001&limit=200&ts=${PARENT_ANSWERED}`]: {
    ok: true,
    messages: [
      { type: "message", ts: PARENT_ANSWERED, user: OTHER, thread_ts: PARENT_ANSWERED, text: "customer asked" },
      { type: "message", ts: "1700000001.000200", user: SELF, thread_ts: PARENT_ANSWERED, text: "answered already" },
    ],
  },
};

describe("read — thread visibility", { timeout: 60_000 }, () => {
  test("text format marks thread parents with a reply count", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["read", "#general"], m.baseUrl);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain("customer asked  [+1 reply]");
      expect(r.stdout).toContain("asked a question  [+2 replies]");
      // A post with no replies must stay unmarked, or the signal is worthless.
      const plainLine = r.stdout.split("\n").find((l) => l.includes("plain post"))!;
      expect(plainLine).not.toContain("[+");
    } finally {
      await m.stop();
    }
  });

  test("json carries reply_count / reply_users_count / latest_reply", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["read", "#general", "--json"], m.baseUrl);
      expect(r.exitCode, r.stderr).toBe(0);
      const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const waiting = rows.find((x) => x.ts === PARENT_WAITING)!;
      expect(waiting.reply_count).toBe(2);
      expect(waiting.reply_users_count).toBe(1);
      expect(waiting.latest_reply).toBe("1700000002.000300");
      // Non-parents must not gain empty keys — the absence is itself the signal.
      const plain = rows.find((x) => x.ts === PLAIN_OTHER)!;
      expect(plain).not.toHaveProperty("reply_count");
    } finally {
      await m.stop();
    }
  });

  test("--unreplied drops conversations whose newest message is ours", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["read", "#general", "--unreplied", "--json"], m.baseUrl);
      expect(r.exitCode, r.stderr).toBe(0);
      const tss = r.stdout.trim().split("\n").map((l) => (JSON.parse(l) as { ts: string }).ts);
      // Kept: thread whose latest reply is someone else's, and their plain post.
      expect(tss).toContain(PARENT_WAITING);
      expect(tss).toContain(PLAIN_OTHER);
      // Dropped: we already answered inside that thread.
      expect(tss).not.toContain(PARENT_ANSWERED);
    } finally {
      await m.stop();
    }
  });
});
