// CLI integration test for `slack upload` — BUG-1 follow-up: SKILL.md claims
// xoxc- + xoxd cookie works for upload, so cmdUpload must actually thread the
// cookie through resolveChannel/files.getUploadURLExternal/
// files.completeUploadExternal, not just accept it and drop it.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
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
