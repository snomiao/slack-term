// CLI integration tests for send/delete targeting — spawns the TS CLI against
// the mock server and asserts on the confirm gate and the requests it issues.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

const fixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },

  // cmdSend context: last message in channel
  "conversations.history__channel=C00000001&limit=1": {
    ok: true,
    messages: [{ type: "message", user: "U00000002", text: "reply", ts: "1700000100.000200" }],
  },

  // Thread-parent lookup for the confirm gate (and cmdDelete's original-message fetch)
  "conversations.replies__channel=C00000001&limit=1&ts=1700000000.000100": {
    ok: true,
    messages: [{ type: "message", user: "U00000001", text: "hello world", ts: "1700000000.000100" }],
  },

  "users.info__user=U00000001": {
    ok: true,
    user: { id: "U00000001", name: "alice", real_name: "Alice", profile: { display_name: "Alice A" } },
  },

  "users.info__user=U00000002": {
    ok: true,
    user: { id: "U00000002", name: "bob", real_name: "Bob", profile: { display_name: "" } },
  },

  // destLabel + #channel-01 resolution
  "conversations.info__channel=C00000001": {
    ok: true,
    channel: { id: "C00000001", name: "channel-01" },
  },

  "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
    ok: true,
    channels: [{ id: "C00000001", name: "channel-01", is_channel: true }],
    response_metadata: { next_cursor: "" },
  },

  // Success line after chat.postMessage (mock returns ts 1700000000.000100)
  "chat.getPermalink__channel=C00000001&message_ts=1700000000.000100": {
    ok: true,
    channel: "C00000001",
    permalink: "https://acme.slack.com/archives/C00000001/p1700000000000100",
  },
};

let mock: MockHandle;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-send-"));
  mock = await startMock({ inline: fixtures });
});

afterAll(async () => {
  await mock.stop();
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };

// Isolated home + explicit fake token so no real profiles/tokens bleed in.
function run(args: string[]): Promise<RunResult> {
  const { SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, HOME: _h, ...rest } = process.env as Record<string, string>;
  const env = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${mock.baseUrl}/api`,
    SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (exitCode: number | null) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

function extractCode(stderr: string): string {
  const m = stderr.match(/--code=([0-9a-f]{4})/);
  if (!m) throw new Error(`No --code found in stderr:\n${stderr}`);
  return m[1]!;
}

const MSG_PERMALINK = "https://acme.slack.com/archives/C00000001/p1700000000000100";

describe("send targeting (CLI)", { timeout: 60_000 }, () => {
  test("message permalink: gate shows THREAD REPLY with parent preview", async () => {
    const r = await run(["send", MSG_PERMALINK, "hi there"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("— THREAD REPLY");
    expect(r.stdout).toContain("#channel-01 (C00000001)");
    expect(r.stdout).toContain("@Alice A");
    expect(r.stdout).toContain("hello world");
    expect(r.stderr).toMatch(/--code=[0-9a-f]{4}/);
  });

  test("message permalink: confirmed send posts with thread_ts", async () => {
    const dry = await run(["send", MSG_PERMALINK, "hi there"]);
    const before = mock.requests.length;
    const r = await run(["send", MSG_PERMALINK, "hi there", `--code=${extractCode(dry.stderr)}`]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ Sent: https://acme.slack.com/archives/C00000001/p1700000000000100");
    const post = mock.requests.slice(before).find((q) => q.method === "chat.postMessage");
    expect(post).toBeDefined();
    const body = JSON.parse(post!.body) as { channel: string; thread_ts?: string };
    expect(body.channel).toBe("C00000001");
    expect(body.thread_ts).toBe("1700000000.000100");
  });

  test("permalink with ?thread_ts= replies to that parent, not the message itself", async () => {
    const target = "https://acme.slack.com/archives/C00000001/p1700000000000200?thread_ts=1700000000.000100&cid=C00000001";
    const dry = await run(["send", target, "hi there"]);
    expect(dry.exitCode).toBe(1);
    // parent preview comes from ts=1700000000.000100 (the thread_ts), not p...000200
    expect(dry.stdout).toContain("— THREAD REPLY");
    expect(dry.stdout).toContain("hello world");

    const before = mock.requests.length;
    const r = await run(["send", target, "hi there", `--code=${extractCode(dry.stderr)}`]);
    expect(r.exitCode).toBe(0);
    const post = mock.requests.slice(before).find((q) => q.method === "chat.postMessage");
    const body = JSON.parse(post!.body) as { thread_ts?: string };
    expect(body.thread_ts).toBe("1700000000.000100");
  });

  test("channel target: gate shows NEW top-level message", async () => {
    const r = await run(["send", "#channel-01", "hi there"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("— NEW top-level message");
    expect(r.stdout).toContain("#channel-01");
  });

  test("channel-only permalink stays top-level", async () => {
    const before = mock.requests.length;
    const dry = await run(["send", "https://acme.slack.com/archives/C00000001", "hi there"]);
    expect(dry.exitCode).toBe(1);
    expect(dry.stdout).toContain("— NEW top-level message");

    const r = await run(["send", "https://acme.slack.com/archives/C00000001", "hi there", `--code=${extractCode(dry.stderr)}`]);
    expect(r.exitCode).toBe(0);
    const post = mock.requests.slice(before).find((q) => q.method === "chat.postMessage");
    const body = JSON.parse(post!.body) as { thread_ts?: string };
    expect(body.thread_ts).toBeUndefined();
  });
});

describe("delete (CLI)", { timeout: 60_000 }, () => {
  test("gate shows the message being deleted", async () => {
    const r = await run(["delete", MSG_PERMALINK]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Deleting message");
    expect(r.stdout).toContain("#channel-01 (C00000001)");
    expect(r.stdout).toContain("hello world");
    expect(r.stderr).toMatch(/--code=[0-9a-f]{4}/);
  });

  test("confirmed delete calls chat.delete with channel and ts", async () => {
    const dry = await run(["delete", MSG_PERMALINK]);
    const before = mock.requests.length;
    const r = await run(["delete", MSG_PERMALINK, `--code=${extractCode(dry.stderr)}`]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ Deleted (ts: 1700000000.000100)");
    const del = mock.requests.slice(before).find((q) => q.method === "chat.delete");
    expect(del).toBeDefined();
    expect(JSON.parse(del!.body)).toEqual({ channel: "C00000001", ts: "1700000000.000100" });
  });

  test("target without ts is rejected", async () => {
    const r = await run(["delete", "#channel-01"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("must embed a message ts");
  });

  test("#chan:ts target resolves channel by name", async () => {
    const r = await run(["delete", "#channel-01:1700000000.000100"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("hello world");
  });
});
