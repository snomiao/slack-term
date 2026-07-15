import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle } from "./mock.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(args: string[], baseUrl: string, envOverrides: Record<string, string> = {}): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${baseUrl}/api`,
    ...envOverrides,
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

let tmpHome: string;
let mock: MockHandle;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-read-bot-"));
  mock = await startMock({
    inline: {
      "conversations.history__channel=D0B0W2FGNHH&limit=20": {
        ok: true,
        messages: [{ ts: "1700000000.000100", username: "general2", text: "bot DM message" }],
      },
    },
  });
});

afterAll(async () => {
  await mock.stop();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("read --as-bot (CLI)", { timeout: 30_000 }, () => {
  test("resolves SLACK_BOT_TOKEN without a user profile", async () => {
    const result = await run(
      ["read", "D0B0W2FGNHH", "--as-bot"],
      mock.baseUrl,
      { SLACK_BOT_TOKEN: "xoxb-read-test" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bot DM message");
    const historyRequest = mock.requests.find((request) => request.method === "conversations.history");
    expect(historyRequest?.headers.authorization).toBe("Bearer xoxb-read-test");
  });

  test("errors cleanly when no bot token is configured", async () => {
    const result = await run(["read", "D0B0W2FGNHH", "--as-bot"], mock.baseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: --as-bot needs a bot token");
    expect(result.stderr).toContain("Set SLACK_BOT_TOKEN=xoxb-...");
    expect(result.stderr).not.toContain("No Slack token found");
  });
});
