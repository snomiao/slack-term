import { afterEach, beforeEach, describe, expect, test, vi } from "./harness.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProfile, useProfile } from "../ts/profiles.ts";
import { authScopes, authTest, listConversations } from "../ts/slack.ts";

const envKeys = ["HOME", "SLACK_COOKIE", "SLACK_MCP_XOXD_COOKIE", "SLACK_MCP_XOXP_TOKEN", "SLACK_WORKSPACE"];
let savedEnv: Record<string, string | undefined>;
let originalCwd: string;
let testDir: string;
let requests: Headers[];
let response: Record<string, unknown>;

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  originalCwd = process.cwd();
  testDir = mkdtempSync(join(tmpdir(), "slack-cookie-"));
  for (const key of envKeys) delete process.env[key];
  // Isolate profile storage and stop the env-file walk at the temporary home.
  process.env.HOME = testDir;
  process.chdir(testDir);
  requests = [];
  response = { ok: true, channels: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(new Headers(init?.headers));
    return Response.json(response);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(testDir, { recursive: true, force: true });
});

for (const [name, request] of [["conversations.list", listConversations], ["authScopes", authScopes]] as const) {
  describe(`${name} session cookies`, () => {
    for (const envKey of ["SLACK_COOKIE", "SLACK_MCP_XOXD_COOKIE"]) {
      test(`resolves an implicit desktop cookie from ${envKey}`, async () => {
        process.env[envKey] = "xoxd-fake-env";
        await request("xoxc-fake-token");
        expect(requests).toHaveLength(1);
        expect(requests[0]!.get("Cookie")).toBe("d=xoxd-fake-env");
      });
    }

    test("resolves an implicit desktop cookie from the selected profile", async () => {
      addProfile("acme", {
        token: "xoxc-fake-token", cookie: "xoxd-fake-profile", team: "Acme",
        teamId: "T00000001", url: "https://acme.slack.com/", user: "alice",
      });
      useProfile("acme");
      await request("xoxc-fake-token");
      expect(requests[0]!.get("Cookie")).toBe("d=xoxd-fake-profile");
    });

    test("explicit desktop cookie wins over the environment", async () => {
      process.env.SLACK_COOKIE = "xoxd-fake-env";
      await request("xoxc-fake-token", "xoxd-fake-explicit");
      expect(requests[0]!.get("Cookie")).toBe("d=xoxd-fake-explicit");
    });

    for (const token of ["xoxp-fake-token", "xoxb-fake-token"]) {
      test(`${token.slice(0, 4)} never sends implicit or explicit cookies`, async () => {
        process.env.SLACK_COOKIE = "xoxd-fake-env";
        await request(token);
        await request(token, "xoxd-fake-explicit");
        expect(requests).toHaveLength(2);
        expect(requests.every(headers => !headers.has("Cookie"))).toBe(true);
      });
    }
  });
}

test("desktop token without any resolvable cookie retains the helpful error", async () => {
  response = { ok: false, error: "invalid_auth" };
  await expect(listConversations("xoxc-fake-token")).rejects.toThrow(
    "Desktop app token (xoxc-) needs its session cookie",
  );
  await expect(authTest("xoxc-fake-token")).rejects.toThrow("Desktop app token");
  expect(requests.every(headers => !headers.has("Cookie"))).toBe(true);
});

test("a rejected resolved cookie reports invalid_auth instead of a missing cookie", async () => {
  process.env.SLACK_COOKIE = "xoxd-fake-env";
  response = { ok: false, error: "invalid_auth" };
  await expect(listConversations("xoxc-fake-token")).rejects.toThrow(
    "Slack error on conversations.list?",
  );
});
