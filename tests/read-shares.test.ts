// CLI integration tests: `slack read` shows forwarded/shared messages.
//
// Regression context: Slack's "Forward" puts the forwarded message in
// attachments[] (is_share), and the CLI dropped attachments entirely, so a
// forward read as just the comment typed with it (reported 2026-10-25).

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
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
const BOB = "U0000000B";
const SHARE_TS = "1700000005.000100";
const LINK = "https://acme.slack.com/archives/C00000002/p1690000000000100";

const FIXTURES: InlineFixtures = {
  "auth.test": { ok: true, user_id: SELF, user: "me", team: "Acme", team_id: "T1", url: "https://acme.slack.com/" },
  "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
    ok: true, channels: [{ id: "C00000001", name: "general" }],
  },
  [`users.info__user=${SELF}`]: { ok: true, user: { id: SELF, name: "me", profile: { display_name: "me" } } },
  [`users.info__user=${BOB}`]: { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
  "conversations.history__channel=C00000001&limit=20": {
    ok: true,
    messages: [
      {
        type: "message", ts: SHARE_TS, user: SELF, text: "see this forwarded msg",
        attachments: [{
          is_share: true, is_msg_unfurl: true, author_id: BOB, author_name: "bob",
          channel_id: "C00000002", ts: "1690000000.000100",
          text: "deploy is done, ping <@U0000000B> if broken", fallback: "[forwarded] deploy is done", from_url: LINK,
        }],
      },
      {
        type: "message", ts: "1700000004.000100", user: SELF, text: "link only",
        attachments: [{ original_url: "https://example.com/", from_url: "https://example.com/", title: "Example Domain", text: "page blurb" }],
      },
      { type: "message", ts: "1700000003.000100", user: BOB, text: "plain post" },
    ],
  },
};

describe("read — forwarded/shared messages", { timeout: 60_000 }, () => {
  test("text format shows the shared message's author, channel, ts, text and permalink", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["read", "#general"], m.baseUrl);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain("see this forwarded msg");
      expect(r.stdout).toContain("↪ shared message from @bob in <#C00000002> · 2023-07-22T04:26:40.000100");
      expect(r.stdout).toContain("│ deploy is done, ping @bob if broken");
      expect(r.stdout).toContain(LINK);
      // A web-page link preview is not content anyone wrote — left out.
      expect(r.stdout).not.toContain("page blurb");
    } finally {
      await m.stop();
    }
  });

  test("json carries attachments only on messages that have them", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["read", "#general", "--json"], m.baseUrl);
      expect(r.exitCode, r.stderr).toBe(0);
      const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const share = rows.find((x) => x.ts === SHARE_TS)!;
      expect(share.attachments).toEqual([{
        shared: true, unfurl: false, author_id: BOB, author_name: "bob", channel_id: "C00000002",
        ts: "1690000000.000100", title: null, text: "deploy is done, ping <@U0000000B> if broken", permalink: LINK,
      }]);
      expect(rows.find((x) => x.ts === "1700000003.000100")).not.toHaveProperty("attachments");
    } finally {
      await m.stop();
    }
  });
});
