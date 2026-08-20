// CLI integration tests for `slack search` — BUG-3: search.messages is a
// user-token-only endpoint (rejects xoxb- with not_allowed_token_type). When
// the active profile is a bot token, the CLI should fall back to a sibling
// user-token profile automatically instead of just erroring.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(
  tmpHome: string,
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

// Seeds ~/.config/slack-cli/profiles.json with a bot profile + (optionally) a
// sibling user-token profile for the same team, and selects the bot profile
// as the active workspace (mirrors `slack auth use`).
function seedProfiles(tmpHome: string, opts: { withUserProfile: boolean }): void {
  const cfgDir = join(tmpHome, ".config", "slack-cli");
  mkdirSync(cfgDir, { recursive: true });
  const profiles: Record<string, unknown> = {
    "acme-bot": { token: "xoxb-fake", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "bot" },
  };
  if (opts.withUserProfile) {
    profiles["acme-alice"] = { token: "xoxc-fake", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "alice", cookie: "xoxd-secret" };
  }
  writeFileSync(join(cfgDir, "profiles.json"), JSON.stringify({ profiles }));
  const lockDir = join(tmpHome, ".slack-cli");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "workspace"), "acme-bot\n");
}

describe("search token-type fallback (CLI)", { timeout: 60_000 }, () => {
  let mock: MockHandle;
  let tmpHome: string;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        "search.messages__count=100&page=1&query=poc2&sort=timestamp&sort_dir=desc": {
          ok: true,
          messages: { matches: [{ user: "U00000001", text: "poc2 works", ts: "1700000000.000100", channel: { id: "C00000001", name: "channel-01" } }], paging: { count: 100, total: 1, page: 1, pages: 1 } },
        },
      },
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  test("bot-only profile: not_allowed_token_type surfaces a clear, actionable error", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "slack-search-noFallback-"));
    try {
      seedProfiles(tmpHome, { withUserProfile: false });
      const m = await startMock({ inline: { "search.messages": { ok: false, error: "not_allowed_token_type" } } });
      try {
        const r = await run(tmpHome, ["search", "poc2"], { baseUrl: m.baseUrl });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("requires a user token");
        expect(r.stderr).toContain("slack auth login");
      } finally {
        await m.stop();
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("bot profile + user profile for a DIFFERENT workspace must NOT fall back (would silently search the wrong workspace)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "slack-search-crossteam-"));
    try {
      const cfgDir = join(tmpHome, ".config", "slack-cli");
      mkdirSync(cfgDir, { recursive: true });
      const profiles = {
        "acme-bot": { token: "xoxb-fake", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "bot" },
        // Same profiles.json, but a different workspace entirely (different teamId).
        "other-alice": { token: "xoxc-other", team: "Other Co", teamId: "T99999999", url: "https://other.slack.com/", user: "alice", cookie: "xoxd-other-secret" },
      };
      writeFileSync(join(cfgDir, "profiles.json"), JSON.stringify({ profiles }));
      const lockDir = join(tmpHome, ".slack-cli");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, "workspace"), "acme-bot\n");

      const m = await startMock({ inline: { "search.messages": { ok: false, error: "not_allowed_token_type" } } });
      try {
        const r = await run(tmpHome, ["search", "poc2"], { baseUrl: m.baseUrl });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("requires a user token");
        expect(r.stderr).not.toContain("falling back");
        // Must never have attempted the cross-workspace token at all.
        const searchReqs = m.requests.filter((q) => q.method === "search.messages");
        expect(searchReqs.every((q) => q.headers.authorization !== "Bearer xoxc-other")).toBe(true);
      } finally {
        await m.stop();
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("bot profile + sibling user profile: falls back automatically and returns results", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "slack-search-fallback-"));
    try {
      seedProfiles(tmpHome, { withUserProfile: true });
      const m = await startMock({
        inline: {
          // Same method + identical query params either way — only the token
          // (Authorization header) differs between the bot's first attempt and
          // the fallback retry, so branch the response on it.
          "search.messages__count=100&page=1&query=poc2&sort=timestamp&sort_dir=desc": {
            __byAuth: {
              "Bearer xoxb-fake": { ok: false, error: "not_allowed_token_type" },
              "Bearer xoxc-fake": {
                ok: true,
                messages: { matches: [{ user: "U00000001", text: "poc2 works", ts: "1700000000.000100", channel: { id: "C00000001", name: "channel-01" } }], paging: { count: 100, total: 1, page: 1, pages: 1 } },
              },
            },
          },
          "users.info__user=U00000001": { ok: true, user: { id: "U00000001", name: "alice", real_name: "Alice" } },
        },
      });
      try {
        const r = await run(tmpHome, ["search", "poc2"], { baseUrl: m.baseUrl });
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain("falling back to profile");
        expect(r.stderr).toContain("acme-alice");
        expect(r.stdout).toContain("poc2 works");
        // the fallback actually used the user-token profile's request, not the bot's
        const searchReqs = m.requests.filter((q) => q.method === "search.messages");
        expect(searchReqs.some((q) => q.headers.authorization === "Bearer xoxc-fake")).toBe(true);

        // Authors render as @handle, not the raw U-id: search results go through
        // users.info like every other listing…
        expect(r.stdout).toContain("@alice");
        expect(r.stdout).not.toContain("@U00000001");
        // …and that lookup MUST carry the search token's session cookie. An xoxc-
        // token without its xoxd cookie is rejected by users.info, and the failure
        // is silent (userInfoPair falls back to the raw ID), so assert the header.
        const infoReqs = m.requests.filter((q) => q.method === "users.info");
        expect(infoReqs.length).toBeGreaterThan(0);
        expect(infoReqs.every((q) => q.headers.authorization === "Bearer xoxc-fake")).toBe(true);
        expect(infoReqs.every((q) => String(q.headers.cookie ?? "").includes("xoxd-secret"))).toBe(true);
      } finally {
        await m.stop();
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
