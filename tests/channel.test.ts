// CLI integration tests for `channel create --invite` — cookie forwarding
// (xoxc- + session cookie) and the restricted-guest invite warning (BUG-2:
// conversations.invite returns ok:true but silently no-ops for a
// single-channel guest).

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-channel-"));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(
  args: string[],
  extra: { env?: Record<string, string>; baseUrl: string },
): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${extra.baseUrl}/api`,
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

describe("channel create --invite (CLI)", { timeout: 60_000 }, () => {
  test("BUG-2: warns before inviting a single-channel guest (is_ultra_restricted)", async () => {
    const m = await startMock({
      inline: {
        "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
        "conversations.create": { ok: true, channel: { id: "C00000042", name: "new-channel" } },
        "users.info__user=U0GUEST001": {
          ok: true,
          user: { id: "U0GUEST001", name: "guest1", real_name: "Guest One", is_ultra_restricted: true },
        },
        "conversations.invite": { ok: true },
      },
    });
    try {
      const env = {};
      const dry = await run(["channel", "create", "new-channel", "--invite", "U0GUEST001"], { baseUrl: m.baseUrl, env });
      expect(dry.exitCode).toBe(1); // confirm gate
      const r = await run(
        ["channel", "create", "new-channel", "--invite", "U0GUEST001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl, env },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Created");
      expect(r.stderr).toContain("single-channel guest");
      expect(r.stdout).toContain("✓ Invited 1 member");
    } finally {
      await m.stop();
    }
  });

  // The creator owns the channel and is the inviter of record, so the gate has
  // to name them — creating a channel from the wrong profile is not undoable.
  test("gate names the creating identity", async () => {
    const m = await startMock({
      inline: {
        "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
        "conversations.create": { ok: true, channel: { id: "C00000042", name: "new-channel" } },
      },
    });
    try {
      const r = await run(["channel", "create", "new-channel", "--invite", "U0REG00001"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("  From:    @user1 (U00000001) — Acme");
      expect(r.stdout.indexOf("From:    @user1")).toBeLessThan(r.stdout.indexOf("name:    #new-channel"));
    } finally {
      await m.stop();
    }
  });

  test("identity is bound to the code: a code minted as someone else is rejected", async () => {
    const inline = {
      "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
      "conversations.create": { ok: true, channel: { id: "C00000042", name: "new-channel" } },
    };
    const m = await startMock({ inline });
    const other = await startMock({
      inline: { ...inline, "auth.test": { ok: true, user_id: "U0000OTHER", user: "someone-else", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" } },
    });
    try {
      const dry = await run(["channel", "create", "new-channel"], { baseUrl: m.baseUrl });
      const before = other.requests.length;
      const r = await run(["channel", "create", "new-channel", `--code=${extractCode(dry.stderr)}`], { baseUrl: other.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Code mismatch");
      expect(other.requests.slice(before).find((q) => q.method === "conversations.create")).toBeUndefined();
    } finally {
      await m.stop();
      await other.stop();
    }
  });

  test("no warning for a regular (non-restricted) member", async () => {
    const m = await startMock({
      inline: {
        "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
        "conversations.create": { ok: true, channel: { id: "C00000042", name: "new-channel" } },
        "users.info__user=U0REG00001": {
          ok: true,
          user: { id: "U0REG00001", name: "regular", real_name: "Regular User" },
        },
        "conversations.invite": { ok: true },
      },
    });
    try {
      const env = {};
      const dry = await run(["channel", "create", "new-channel", "--invite", "U0REG00001"], { baseUrl: m.baseUrl, env });
      const r = await run(
        ["channel", "create", "new-channel", "--invite", "U0REG00001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl, env },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain("single-channel guest");
      expect(r.stderr).not.toContain("multi-channel guest");
    } finally {
      await m.stop();
    }
  });

  test("BUG-1: xoxc- + SLACK_COOKIE attaches the Cookie header to conversations.create/invite", async () => {
    const m = await startMock({
      inline: {
        "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
        "conversations.create": { ok: true, channel: { id: "C00000042", name: "new-channel" } },
        "users.info__user=U0REG00001": { ok: true, user: { id: "U0REG00001", name: "regular" } },
        "conversations.invite": { ok: true },
      },
    });
    try {
      const env = { SLACK_MCP_XOXP_TOKEN: "xoxc-fake", SLACK_COOKIE: "xoxd-secret" };
      const dry = await run(["channel", "create", "new-channel", "--invite", "U0REG00001"], { baseUrl: m.baseUrl, env });
      const before = m.requests.length;
      const r = await run(
        ["channel", "create", "new-channel", "--invite", "U0REG00001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl, env },
      );
      expect(r.exitCode).toBe(0);
      const reqs = m.requests.slice(before);
      const create = reqs.find((q) => q.method === "conversations.create");
      const invite = reqs.find((q) => q.method === "conversations.invite");
      expect(create?.headers.cookie).toBe("d=xoxd-secret");
      expect(invite?.headers.cookie).toBe("d=xoxd-secret");
    } finally {
      await m.stop();
    }
  });
});

describe("channel rename (CLI)", { timeout: 60_000 }, () => {
  const AUTH = { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" };
  const LIST = {
    "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
      ok: true,
      channels: [{ id: "C00000042", name: "old-name" }],
    },
  };
  const INFO = { "conversations.info__channel=C00000042": { ok: true, channel: { id: "C00000042", name: "old-name" } } };
  const RENAMED = { "conversations.rename": { ok: true, channel: { id: "C00000042", name: "new-name" } } };
  const renameCalls = (m: { requests: { method: string }[] }) => m.requests.filter((q) => q.method === "conversations.rename");

  test("gate: no --code previews old -> new and does not call the API; the code then renames", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH, ...LIST, ...INFO, ...RENAMED } });
    try {
      const dry = await run(["channel", "rename", "#old-name", "new-name"], { baseUrl: m.baseUrl });
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).toContain("from:    #old-name");
      expect(dry.stdout).toContain("to:      #new-name");
      expect(dry.stdout).toContain("From:    @user1 (U00000001)");
      expect(renameCalls(m)).toHaveLength(0);

      const r = await run(["channel", "rename", "#old-name", "new-name", `--code=${extractCode(dry.stderr)}`], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Renamed #old-name -> #new-name  (C00000042)");
      const calls = renameCalls(m);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toContain("C00000042");
      expect(calls[0]!.body).toContain("new-name");
    } finally {
      await m.stop();
    }
  });

  test("a wrong --code is rejected without renaming", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH, ...INFO, ...RENAMED } });
    try {
      const r = await run(["channel", "rename", "C00000042", "new-name", "--code=0000"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Code mismatch");
      expect(renameCalls(m)).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });

  test("the code is bound to the new name", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH, ...INFO, ...RENAMED } });
    try {
      const dry = await run(["channel", "rename", "C00000042", "new-name"], { baseUrl: m.baseUrl });
      const r = await run(["channel", "rename", "C00000042", "other-name", `--code=${extractCode(dry.stderr)}`], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Code mismatch");
      expect(renameCalls(m)).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });

  test("--dry-run resolves a bare name and prints old -> new without calling the API", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH, ...LIST, ...INFO, ...RENAMED } });
    try {
      const r = await run(["channels", "rename", "old-name", "#New-Name", "--dry-run"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("#old-name -> #new-name  (C00000042)");
      expect(r.stderr).not.toContain("--code=");
      expect(renameCalls(m)).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });

  test("an unresolvable channel fails clearly", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH, ...LIST } });
    try {
      const r = await run(["channel", "rename", "#no-such-channel", "new-name"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("could not resolve channel #no-such-channel");
      expect(renameCalls(m)).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });

  test("missing_scope names channels:manage / groups:write", async () => {
    const m = await startMock({
      inline: { "auth.test": AUTH, ...INFO, "conversations.rename": { ok: false, error: "missing_scope" } },
    });
    try {
      const env = { SLACK_MCP_XOXP_TOKEN: "xoxb-fake" };
      const dry = await run(["channel", "rename", "C00000042", "new-name"], { baseUrl: m.baseUrl, env });
      const r = await run(["channel", "rename", "C00000042", "new-name", `--code=${extractCode(dry.stderr)}`], { baseUrl: m.baseUrl, env });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("channels:manage");
      expect(r.stderr).toContain("groups:write");
    } finally {
      await m.stop();
    }
  });
});
