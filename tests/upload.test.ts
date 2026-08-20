// CLI integration test for `slack upload` — BUG-1 follow-up: SKILL.md claims
// xoxc- + xoxd cookie works for upload, so cmdUpload must actually thread the
// cookie through resolveChannel/files.getUploadURLExternal/
// files.completeUploadExternal, not just accept it and drop it.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-upload-"));
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

describe("upload cookie forwarding (CLI)", { timeout: 60_000 }, () => {
  test("xoxc- + SLACK_COOKIE attaches the Cookie header through the full upload flow", async () => {
    const m = await startMock({ inline: {} });
    try {
      const filePath = join(tmpHome, "test-upload.txt");
      writeFileSync(filePath, "hello world");
      const env = { SLACK_MCP_XOXP_TOKEN: "xoxc-fake", SLACK_COOKIE: "xoxd-secret" };

      const dry = await run(
        ["upload", "#channel-01", filePath, "--channel-id", "C00000001"],
        { baseUrl: m.baseUrl, env },
      );
      expect(dry.exitCode).toBe(1); // confirm gate

      const before = m.requests.length;
      const r = await run(
        ["upload", "#channel-01", filePath, "--channel-id", "C00000001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl, env },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Uploaded");

      const reqs = m.requests.slice(before);
      const urlReq = reqs.find((q) => q.method === "files.getUploadURLExternal");
      const completeReq = reqs.find((q) => q.method === "files.completeUploadExternal");
      expect(urlReq).toBeDefined();
      expect(completeReq).toBeDefined();
      expect(urlReq!.headers.cookie).toBe("d=xoxd-secret");
      expect(completeReq!.headers.cookie).toBe("d=xoxd-secret");
    } finally {
      await m.stop();
    }
  });
});

// The gate must name whoever the file will be uploaded AS — a file posted from
// the wrong profile is as wrong as a message sent from it, and unlike a message
// it can't be edited afterwards.
describe("upload identity in the confirm gate (CLI)", { timeout: 60_000 }, () => {
  const authFixture = {
    "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  };

  test("single-file gate shows the uploading identity above the destination", async () => {
    const m = await startMock({ inline: authFixture });
    try {
      const filePath = join(tmpHome, "identity-single.txt");
      writeFileSync(filePath, "hello world");
      const r = await run(["upload", "#channel-01", filePath, "--channel-id", "C00000001"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("  From:  @user1 (U00000001) — Acme");
      expect(r.stdout.indexOf("From:  @user1")).toBeLessThan(r.stdout.indexOf("To:    #channel-01"));
    } finally {
      await m.stop();
    }
  });

  test("batch gate shows it too, and the code stays valid for the confirmed upload", async () => {
    const m = await startMock({ inline: authFixture });
    try {
      const a = join(tmpHome, "identity-a.txt");
      const b = join(tmpHome, "identity-b.txt");
      writeFileSync(a, "a");
      writeFileSync(b, "b");
      const dry = await run(["upload", "#channel-01", a, b, "--channel-id", "C00000001"], { baseUrl: m.baseUrl });
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).toContain("--- Uploading 2 files");
      expect(dry.stdout).toContain("  From:  @user1 (U00000001) — Acme");

      const r = await run(
        ["upload", "#channel-01", a, b, "--channel-id", "C00000001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("[2/2] ✓ Uploaded");
    } finally {
      await m.stop();
    }
  });

  test("identity lookup failure is fail-soft: gate renders and the upload still runs", async () => {
    const m = await startMock({ inline: { "auth.test": { ok: false, error: "invalid_auth" } } });
    try {
      const filePath = join(tmpHome, "identity-failsoft.txt");
      writeFileSync(filePath, "hello");
      const dry = await run(["upload", "#channel-01", filePath, "--channel-id", "C00000001"], { baseUrl: m.baseUrl });
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).toContain("  From:  (unknown — auth.test failed)");

      const r = await run(
        ["upload", "#channel-01", filePath, "--channel-id", "C00000001", `--code=${extractCode(dry.stderr)}`],
        { baseUrl: m.baseUrl },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Uploaded");
    } finally {
      await m.stop();
    }
  });
});

// Same silent-delivery footgun as `send`: Slack never notifies you about your
// own message, so a file uploaded to your own DM lands and is never seen.
describe("upload self-DM warning (CLI)", { timeout: 60_000 }, () => {
  const SELF = "U00000001";
  const inline = {
    "auth.test": { ok: true, user_id: SELF, user: "user1", team: "Acme", url: "https://acme.slack.com/" },
    "conversations.info__channel=D00000001": { ok: true, channel: { id: "D00000001", is_im: true, user: SELF, name: "" } },
    "conversations.info__channel=D00000BOB": { ok: true, channel: { id: "D00000BOB", is_im: true, user: "U00000BOB", name: "" } },
  };

  test("warns when the destination is your own DM", async () => {
    const m = await startMock({ inline });
    try {
      const filePath = join(tmpHome, "selfdm.txt");
      writeFileSync(filePath, "hello");
      const r = await run(["upload", "@me", filePath, "--channel-id", "D00000001"], { baseUrl: m.baseUrl });
      expect(r.stderr).toContain("DM to yourself");
    } finally {
      await m.stop();
    }
  });

  test("stays quiet for a DM to someone else", async () => {
    const m = await startMock({ inline });
    try {
      const filePath = join(tmpHome, "otherdm.txt");
      writeFileSync(filePath, "hello");
      const r = await run(["upload", "@bob", filePath, "--channel-id", "D00000BOB"], { baseUrl: m.baseUrl });
      expect(r.stderr).not.toContain("DM to yourself");
    } finally {
      await m.stop();
    }
  });
});
