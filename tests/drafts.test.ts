// CLI integration tests for the `drafts edit` / `drafts delete` confirm gates.
// Both are gated writes, so both must name the acting identity and bind it into
// the safety code — a draft lives in one workspace under one account, and the
// same draft id means nothing in another.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
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
  tmpHome = mkdtempSync(join(tmpdir(), "slack-drafts-"));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(args: string[], extra: { env?: Record<string, string>; baseUrl: string }): Promise<RunResult> {
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

const draft = {
  id: "Dr001",
  channel_id: "C00000001",
  blocks: [{
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "half-written draft" }] }],
  }],
};

const fixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  "drafts.list": { ok: true, drafts: [draft] },
  "drafts.update": { ok: true, draft: { id: "Dr001" } },
  "drafts.delete": { ok: true },
};

describe("drafts edit/delete gates (CLI)", { timeout: 60_000 }, () => {
  test("edit gate names the identity above the draft diff", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      const r = await run(["drafts", "edit", "Dr001", "rewritten draft"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("--- Editing draft as ---");
      expect(r.stdout).toContain("  From: @user1 (U00000001) — Acme");
      expect(r.stdout.indexOf("From: @user1")).toBeLessThan(r.stdout.indexOf("--- Current draft"));
      expect(r.stdout).toContain("half-written draft");
      expect(r.stdout).toContain("rewritten draft");
    } finally {
      await m.stop();
    }
  });

  test("confirmed edit still goes through with the identity-bound code", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      const dry = await run(["drafts", "edit", "Dr001", "rewritten draft"], { baseUrl: m.baseUrl });
      const before = m.requests.length;
      const r = await run(["drafts", "edit", "Dr001", "rewritten draft", `--code=${extractCode(dry.stderr)}`], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Draft updated");
      expect(m.requests.slice(before).find((q) => q.method === "drafts.update")).toBeDefined();
    } finally {
      await m.stop();
    }
  });

  test("delete gate names the identity above the draft id", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      const r = await run(["drafts", "delete", "Dr001"], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Deleting draft");
      expect(r.stdout).toContain("  From: @user1 (U00000001) — Acme");
      expect(r.stdout.indexOf("From: @user1")).toBeLessThan(r.stdout.indexOf("id: Dr001"));
    } finally {
      await m.stop();
    }
  });

  test("confirmed delete calls drafts.delete", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      const dry = await run(["drafts", "delete", "Dr001"], { baseUrl: m.baseUrl });
      const before = m.requests.length;
      const r = await run(["drafts", "delete", "Dr001", `--code=${extractCode(dry.stderr)}`], { baseUrl: m.baseUrl });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Draft deleted");
      expect(m.requests.slice(before).find((q) => q.method === "drafts.delete")).toBeDefined();
    } finally {
      await m.stop();
    }
  });

  test("a delete code minted under another identity is rejected", async () => {
    const m = await startMock({ inline: fixtures });
    const other = await startMock({
      inline: { ...fixtures, "auth.test": { ok: true, user_id: "U0000OTHER", user: "someone-else", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" } },
    });
    try {
      const dry = await run(["drafts", "delete", "Dr001"], { baseUrl: m.baseUrl });
      const before = other.requests.length;
      const r = await run(["drafts", "delete", "Dr001", `--code=${extractCode(dry.stderr)}`], { baseUrl: other.baseUrl });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Code mismatch");
      expect(r.stdout).toContain("From: @someone-else (U0000OTHER)");
      expect(other.requests.slice(before).find((q) => q.method === "drafts.delete")).toBeUndefined();
    } finally {
      await m.stop();
      await other.stop();
    }
  });
});
