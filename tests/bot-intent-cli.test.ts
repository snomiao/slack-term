// CLI: an exported SLACK_BOT_TOKEN without --as-bot must not post as the user
// (reported 2026-10-26: a lane's `pinlog new` went out under the person's session).

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-botintent-"));
  // A user profile, so the user token is the one a write would act with.
  mkdirSync(join(tmpHome, ".config", "slack-cli"), { recursive: true });
  writeFileSync(join(tmpHome, ".config", "slack-cli", "profiles.json"), JSON.stringify({ profiles: {
    acme: { token: "xoxp-acme", team: "Acme", user: "alice" },
  } }));
});
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

function run(args: string[], baseUrl: string, extra: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = { ...rest, HOME: tmpHome, SLACK_API_BASE: `${baseUrl}/api`, SLACK_WORKSPACE: "acme", ...extra };
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

const FIXTURES: InlineFixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "alice", team: "Acme", team_id: "T1", url: "https://acme.slack.com/" },
};

describe("exported SLACK_BOT_TOKEN without --as-bot (CLI)", { timeout: 60_000 }, () => {
  test("a write is refused before any Slack call", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["pinlog", "new", "#channel-01", "ok", "first"], m.baseUrl, { SLACK_BOT_TOKEN: "xoxb-fake" });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("refusing to act as YOU");
      expect(r.stderr).toContain("add --as-bot");
      expect(m.requests.length).toBe(0);
    } finally {
      await m.stop();
    }
  });

  test("todos writes (aliases included) are refused too; todos ls is not", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      for (const sub of ["add", "done", "complete", "edit", "rm", "remove", "delete"]) {
        const r = await run(["todos", sub, "#channel-01:1700000000.000100", "--due", "none"], m.baseUrl, { SLACK_BOT_TOKEN: "xoxb-fake" });
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain(`\`todos ${sub}\``);
      }
      expect(m.requests.length).toBe(0);
      const ls = await run(["todos", "ls"], m.baseUrl, { SLACK_BOT_TOKEN: "xoxb-fake" });
      expect(ls.stderr).not.toContain("refusing to act as YOU");
    } finally {
      await m.stop();
    }
  });

  test("clearing the bot token, or setting SLACK_TOKEN, lets the user write again", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      for (const extra of [{ SLACK_BOT_TOKEN: "" }, { SLACK_BOT_TOKEN: "xoxb-fake", SLACK_TOKEN: "xoxp-acme" }]) {
        const r = await run(["react", "#channel-01:1700000000.000100", "eyes", "--channel-id", "C00000001"], m.baseUrl, extra);
        expect(r.stderr).not.toContain("refusing to act as YOU");
      }
    } finally {
      await m.stop();
    }
  });

  test("reads are unaffected", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["pinlog", "ls", "#channel-01"], m.baseUrl, { SLACK_BOT_TOKEN: "xoxb-fake" });
      expect(r.stderr).not.toContain("refusing to act as YOU");
    } finally {
      await m.stop();
    }
  });

  test("the GLOBAL ~/.config/slack-cli/.env bot token is not intent — nor is a child's inherited copy of it", async () => {
    const globalEnv = join(tmpHome, ".config", "slack-cli", ".env");
    writeFileSync(globalEnv, "SLACK_BOT_TOKEN=xoxb-global\n");
    const m = await startMock({ inline: FIXTURES });
    try {
      const args = ["pinlog", "new", "#channel-01", "ok", "first"];
      // Loaded from the global file only.
      expect((await run(args, m.baseUrl, {})).stderr).not.toContain("refusing to act as YOU");
      // The same value already in the env, as a process spawned by the CLI (e.g. under `slack agent`) inherits it.
      expect((await run(args, m.baseUrl, { SLACK_BOT_TOKEN: "xoxb-global" })).stderr).not.toContain("refusing to act as YOU");
      // A DIFFERENT bot token exported over it is still intent.
      const r = await run(args, m.baseUrl, { SLACK_BOT_TOKEN: "xoxb-other" });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("refusing to act as YOU");
    } finally {
      await m.stop();
      unlinkSync(globalEnv);
    }
  });

  test("a typed alias (`ch mv`) is a write too", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["ch", "mv", "#channel-01", "channel-02"], m.baseUrl, { SLACK_BOT_TOKEN: "xoxb-fake" });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("`ch mv`");
      expect(m.requests.length).toBe(0);
    } finally {
      await m.stop();
    }
  });
});
