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

  // Thread-parent lookup for cmdDelete's original-message fetch (limit=1)
  "conversations.replies__channel=C00000001&limit=1&ts=1700000000.000100": {
    ok: true,
    messages: [{ type: "message", user: "U00000001", text: "hello world", ts: "1700000000.000100" }],
  },

  // Thread context for the send confirm gate (limit=100): parent + a prior reply,
  // so the gate can preview the tail and the dup guard has something to match.
  "conversations.replies__channel=C00000001&limit=100&ts=1700000000.000100": {
    ok: true,
    messages: [
      { type: "message", user: "U00000001", text: "hello world", ts: "1700000000.000100" },
      { type: "message", user: "U00000002", text: "a prior reply in the thread", ts: "1700000050.000300" },
    ],
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

  "reactions.add": { ok: true },
  "reactions.remove": { ok: true },
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
// `extra` overrides/augments env (e.g. SLACK_BOT_TOKEN) and the mock base URL.
function run(
  args: string[],
  extra: { env?: Record<string, string>; baseUrl?: string } = {},
): Promise<RunResult> {
  const { SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h, ...rest } = process.env as Record<string, string>;
  const env = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${extra.baseUrl ?? mock.baseUrl}/api`,
    SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    ...(extra.env ?? {}),
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

  test("thread gate previews the thread tail, not the channel's last message", async () => {
    const r = await run(["send", MSG_PERMALINK, "hi there"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("--- Recent messages in thread");
    // the thread's own prior reply, not the channel-history "reply" fixture
    expect(r.stdout).toContain("a prior reply in the thread");
    expect(r.stdout).not.toContain("--- Last message in channel");
  });

  test("dup guard warns when the message closely matches an existing thread reply", async () => {
    const r = await run(["send", MSG_PERMALINK, "a prior reply in the thread"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("possible duplicate");
  });

  test("no dup warning for a distinct thread reply", async () => {
    const r = await run(["send", MSG_PERMALINK, "something completely unrelated here"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("possible duplicate");
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

// "Unreplied" WARN: the destination's most recent message is our own (the
// other party hasn't replied yet) — non-blocking, points at `slack edit`
// instead of piling on a new message. Reply-status based, not time-based.
describe("unreplied-warn (CLI)", { timeout: 60_000 }, () => {
  const authSelf = { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" };

  test("channel target: warns when the channel's last message is our own", async () => {
    const m = await startMock({
      inline: {
        "auth.test": authSelf,
        "conversations.history__channel=C00000002&limit=1": {
          ok: true, messages: [{ type: "message", user: "U00000001", text: "my last msg", ts: "1700000200.000100" }],
        },
        "chat.getPermalink__channel=C00000002&message_ts=1700000200.000100": {
          ok: true, channel: "C00000002", permalink: "https://acme.slack.com/archives/C00000002/p1700000200000100",
        },
      },
    });
    try {
      const r = await run(["send", "#channel-02", "following up", "--channel-id", "C00000002"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1); // still stops at the confirm gate
      expect(r.stderr).toContain("相手はまだ返信していません");
      expect(r.stderr).toContain('slack edit "https://acme.slack.com/archives/C00000002/p1700000200000100"');
    } finally {
      await m.stop();
    }
  });

  test("channel target: no warn once someone else has replied", async () => {
    // default `mock` fixtures: last message in C00000001 is bob (U00000002), self is U00000001
    const r = await run(["send", "#channel-01", "hi there"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("相手はまだ返信していません");
  });

  test("thread target: warns when the thread's last reply is our own", async () => {
    const m = await startMock({
      inline: {
        "auth.test": authSelf,
        "conversations.replies__channel=C00000002&limit=100&ts=1700000000.000100": {
          ok: true,
          messages: [
            { type: "message", user: "U00000002", text: "hello world", ts: "1700000000.000100" },
            { type: "message", user: "U00000001", text: "my reply", ts: "1700000050.000300" },
          ],
        },
        "chat.getPermalink__channel=C00000002&message_ts=1700000050.000300": {
          ok: true, channel: "C00000002", permalink: "https://acme.slack.com/archives/C00000002/p1700000050000300",
        },
      },
    });
    try {
      const r = await run(
        ["send", "#channel-02:1700000000.000100", "following up", "--channel-id", "C00000002"],
        { baseUrl: m.baseUrl },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("相手はまだ返信していません");
      expect(r.stderr).toContain('slack edit "https://acme.slack.com/archives/C00000002/p1700000050000300"');
    } finally {
      await m.stop();
    }
  });

  test("thread target: no warn once the other party has replied in-thread", async () => {
    // default `mock` fixtures: thread's last reply is bob (U00000002), self is U00000001
    const r = await run(["send", MSG_PERMALINK, "something completely unrelated here"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("相手はまだ返信していません");
  });

  test("SLACK_UNREPLIED_WARN=0 disables the warning", async () => {
    const m = await startMock({
      inline: {
        "auth.test": authSelf,
        "conversations.history__channel=C00000002&limit=1": {
          ok: true, messages: [{ type: "message", user: "U00000001", text: "my last msg", ts: "1700000200.000100" }],
        },
        "chat.getPermalink__channel=C00000002&message_ts=1700000200.000100": {
          ok: true, channel: "C00000002", permalink: "https://acme.slack.com/archives/C00000002/p1700000200000100",
        },
      },
    });
    try {
      const r = await run(
        ["send", "#channel-02", "following up", "--channel-id", "C00000002"],
        { baseUrl: m.baseUrl, env: { SLACK_UNREPLIED_WARN: "0" } },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).not.toContain("相手はまだ返信していません");
    } finally {
      await m.stop();
    }
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

describe("react (CLI)", { timeout: 60_000 }, () => {
  test("adds a reaction (no confirm gate) via reactions.add", async () => {
    const before = mock.requests.length;
    const r = await run(["react", MSG_PERMALINK, "white_check_mark"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ Reacted :white_check_mark:");
    const add = mock.requests.slice(before).find((q) => q.method === "reactions.add");
    expect(add).toBeDefined();
    expect(JSON.parse(add!.body)).toEqual({ channel: "C00000001", timestamp: "1700000000.000100", name: "white_check_mark" });
  });

  test("--remove calls reactions.remove", async () => {
    const before = mock.requests.length;
    const r = await run(["react", MSG_PERMALINK, "eyes", "--remove"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ Removed :eyes:");
    const rm = mock.requests.slice(before).find((q) => q.method === "reactions.remove");
    expect(rm).toBeDefined();
    expect(JSON.parse(rm!.body)).toEqual({ channel: "C00000001", timestamp: "1700000000.000100", name: "eyes" });
  });

  test("strips surrounding colons from the emoji shortcode", async () => {
    const before = mock.requests.length;
    const r = await run(["react", "#channel-01:1700000000.000100", ":hourglass:"]);
    expect(r.exitCode).toBe(0);
    const add = mock.requests.slice(before).find((q) => q.method === "reactions.add");
    expect(JSON.parse(add!.body).name).toBe("hourglass");
  });

  test("target without ts is rejected", async () => {
    const r = await run(["react", "#channel-01", "eyes"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("must embed a message ts");
  });

  test("missing_scope → one clean line, no yargs usage dump", async () => {
    const m = await startMock({ inline: { "reactions.add": { ok: false, error: "missing_scope" } } });
    try {
      const r = await run(
        ["react", "#channel-01:1700000000.000100", "white_check_mark", "--channel-id", "C00000001"],
        { baseUrl: m.baseUrl },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("reactions:write");
      // the yargs usage dump (Commands:/Positionals:/Options:) must NOT appear
      expect(r.stderr).not.toContain("Positionals:");
      expect(r.stdout).not.toContain("slack react <target>");
    } finally {
      await m.stop();
    }
  });

  test("invalid_name → friendly emoji guidance", async () => {
    const m = await startMock({ inline: { "reactions.add": { ok: false, error: "invalid_name" } } });
    try {
      const r = await run(
        ["react", "#channel-01:1700000000.000100", "notarealemoji", "--channel-id", "C00000001"],
        { baseUrl: m.baseUrl },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("emoji shortcode");
      expect(r.stderr).not.toContain("Positionals:");
    } finally {
      await m.stop();
    }
  });
});

// Bot-token DM path + scope/messaging diagnostics.
describe("bot DM + doctor (CLI)", { timeout: 60_000 }, () => {
  // auth.test served with bot scopes via X-OAuth-Scopes; bots.info for app_id.
  function botFixtures(scopes: string) {
    return {
      "auth.test": {
        ok: true, user_id: "U00000BOT", bot_id: "B00000001", team: "Acme",
        url: "https://acme.slack.com/", __headers: { "x-oauth-scopes": scopes },
      },
      "bots.info__bot=B00000001": { ok: true, bot: { app_id: "A00000001", user_id: "U00000BOT" } },
      // DM channel context for the send confirm gate
      "conversations.history__channel=D00000001&limit=1": {
        ok: true, messages: [{ type: "message", user: "U00000BOT", text: "prev", ts: "1700000100.000200" }],
      },
      "conversations.info__channel=D00000001": { ok: true, channel: { id: "D00000001", name: "" } },
      "chat.getPermalink__channel=D00000001&message_ts=1700000000.000100": {
        ok: true, channel: "D00000001", permalink: "https://acme.slack.com/archives/D00000001/p1700000000000100",
      },
    };
  }

  test("doctor: complete scopes → two-way note, exit 0", async () => {
    const m = await startMock({ inline: botFixtures("chat:write,im:write,im:history,im:read") });
    try {
      const r = await run(["doctor"], { baseUrl: m.baseUrl, env: { SLACK_BOT_TOKEN: "xoxb-fake" } });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("scopes are complete");
      expect(r.stdout).toContain("Messages Tab");
      expect(r.stdout).toContain("https://api.slack.com/apps/A00000001");
    } finally {
      await m.stop();
    }
  });

  test("doctor: missing reply scopes → guidance, exit 1", async () => {
    const m = await startMock({ inline: botFixtures("chat:write,im:write") });
    try {
      const r = await run(["doctor"], { baseUrl: m.baseUrl, env: { SLACK_BOT_TOKEN: "xoxb-fake" } });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("replies will NOT be readable");
      expect(r.stdout).toContain("im:history, im:read");
    } finally {
      await m.stop();
    }
  });

  test("doctor: no bot token → error, exit 1", async () => {
    const r = await run(["doctor"]); // no SLACK_BOT_TOKEN
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no xoxb- token");
  });

  test("send --as-bot without a bot token → error, exit 1", async () => {
    const r = await run(["send", "@bob", "hi", "--as-bot"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--as-bot needs a bot token");
  });

  test("send --as-bot to a DM runs post-send diagnosis (missing scopes warn)", async () => {
    const m = await startMock({ inline: botFixtures("chat:write,im:write") });
    try {
      const env = { SLACK_BOT_TOKEN: "xoxb-fake" };
      const dry = await run(["send", "@bob", "escalation", "--as-bot", "--channel-id", "D00000001"], { baseUrl: m.baseUrl, env });
      expect(dry.exitCode).toBe(1); // confirm gate
      const r = await run(
        ["send", "@bob", "escalation", "--as-bot", "--channel-id", "D00000001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl, env },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Sent");
      // post-send diagnosis fired because scopes are incomplete
      expect(r.stderr).toContain("replies will NOT be readable");
    } finally {
      await m.stop();
    }
  });

  test("send --as-bot to a DM with complete scopes → Messages Tab note only", async () => {
    const m = await startMock({ inline: botFixtures("chat:write,im:write,im:history,im:read") });
    try {
      const env = { SLACK_BOT_TOKEN: "xoxb-fake" };
      const dry = await run(["send", "@bob", "escalation", "--as-bot", "--channel-id", "D00000001"], { baseUrl: m.baseUrl, env });
      const r = await run(
        ["send", "@bob", "escalation", "--as-bot", "--channel-id", "D00000001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl, env },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("enable Messages Tab");
      expect(r.stderr).not.toContain("replies will NOT be readable");
    } finally {
      await m.stop();
    }
  });

  test("--as-bot @user resolves the user via the user token, DMs via the bot", async () => {
    const m = await startMock({
      inline: {
        // user-token lookup: auth.test (self=user1, not bob) then users.list finds bob
        "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", url: "https://acme.slack.com/" },
        "users.list__limit=200": { ok: true, members: [{ id: "U00000BOB", name: "bob", real_name: "Bob" }] },
        // bot opens DM (conversations.open POST → built-in C00000099); gate context fail-soft
        "chat.getPermalink__channel=C00000099&message_ts=1700000000.000100": {
          ok: true, channel: "C00000099", permalink: "https://acme.slack.com/archives/C00000099/p1700000000000100",
        },
      },
    });
    try {
      const env = { SLACK_BOT_TOKEN: "xoxb-fake" };
      const dry = await run(["send", "@bob", "ping", "--as-bot"], { baseUrl: m.baseUrl, env });
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).not.toContain("slack send <target>"); // clean gate, not a usage dump
      const before = m.requests.length;
      const r = await run(["send", "@bob", "ping", "--as-bot", `--code=${extractCode(dry.stderr)}`], { baseUrl: m.baseUrl, env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Sent");
      const reqs = m.requests.slice(before);
      // bot opened the DM with the resolved user id …
      const open = reqs.find((q) => q.method === "conversations.open");
      expect(open && JSON.parse(open.body).users).toBe("U00000BOB");
      // … and posted to the opened DM channel
      const post = reqs.find((q) => q.method === "chat.postMessage");
      expect(post && JSON.parse(post.body).channel).toBe("C00000099");
    } finally {
      await m.stop();
    }
  });

  test("--as-bot with an unknown @user errors cleanly (no usage dump)", async () => {
    const m = await startMock({
      inline: {
        "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", url: "https://acme.slack.com/" },
        "users.list__limit=200": { ok: true, members: [{ id: "U00000099", name: "someone-else" }] },
      },
    });
    try {
      const r = await run(["send", "@ghost", "hi", "--as-bot"], { baseUrl: m.baseUrl, env: { SLACK_BOT_TOKEN: "xoxb-fake" } });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("could not resolve @ghost");
      expect(r.stdout).not.toContain("slack send <target>"); // not a yargs usage dump
    } finally {
      await m.stop();
    }
  });

  test("--as-bot send survives a bot lacking im:history (fail-soft preview)", async () => {
    const m = await startMock({
      inline: {
        ...botFixtures("chat:write,im:write,im:history,im:read"),
        // gate context fetch denied — must not block the send
        "conversations.history__channel=D00000001&limit=1": { ok: false, error: "missing_scope" },
      },
    });
    try {
      const env = { SLACK_BOT_TOKEN: "xoxb-fake" };
      const dry = await run(["send", "@bob", "msg", "--as-bot", "--channel-id", "D00000001"], { baseUrl: m.baseUrl, env });
      expect(dry.exitCode).toBe(1); // still reaches the confirm gate
      const r = await run(
        ["send", "@bob", "msg", "--as-bot", "--channel-id", "D00000001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl, env },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Sent");
    } finally {
      await m.stop();
    }
  });

  test("self-DM without --as-bot warns about no self-notification", async () => {
    const m = await startMock({
      inline: {
        "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", url: "https://acme.slack.com/" },
        "conversations.list__limit=200&types=im": { ok: true, channels: [{ id: "D00000001", user: "U00000001" }] },
        "conversations.history__channel=D00000001&limit=1": {
          ok: true, messages: [{ type: "message", user: "U00000001", text: "prev", ts: "1700000100.000200" }],
        },
        "conversations.info__channel=D00000001": { ok: true, channel: { id: "D00000001", name: "" } },
      },
    });
    try {
      const r = await run(["send", "@me", "note to self"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1); // stops at confirm gate
      expect(r.stderr).toContain("DM to yourself");
      expect(r.stderr).toContain("--as-bot");
    } finally {
      await m.stop();
    }
  });
});
