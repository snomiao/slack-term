// CLI integration tests for `slack todos` (Slack's To-dos tab, read-only):
// it reads saved.list, orders by due date, resolves each message, and never
// writes.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ENTRY = join(HERE, "..", "ts", "cli.ts");

let tmpHome: string;
beforeAll(() => { tmpHome = mkdtempSync(join(tmpdir(), "slack-todos-")); });
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(args: string[], baseUrl: string): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = { ...rest, HOME: tmpHome, SLACK_API_BASE: `${baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake" };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (exitCode: number | null) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
    child.on("error", reject);
  });
}

// One overdue to-do in a channel, one future to-do in a DM, one undated.
const PAST = 1_000_000_000;
const FUTURE = 4_000_000_000;
const fixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  "saved.list": {
    ok: true,
    saved_items: [
      { item_id: "D00000001", item_type: "message", ts: "1700000002.000200", date_due: FUTURE, date_completed: 0, state: "in_progress", todo_state: "to_do", is_archived: false },
      { item_id: "C00000001", item_type: "message", ts: "1700000003.000300", date_due: 0, date_completed: 0, state: "in_progress", todo_state: "to_do", is_archived: false },
      { item_id: "C00000001", item_type: "message", ts: "1700000001.000100", date_due: PAST, date_completed: 0, state: "in_progress", todo_state: "to_do", is_archived: false },
    ],
    response_metadata: { next_cursor: "" },
  },
  // The channel label is read with the session API (a POST), which the mock
  // keys by method alone — so every item resolves to this one channel.
  "conversations.info": { ok: true, channel: { id: "C00000001", name: "channel-01" } },
  "users.info__user=U00000002": { ok: true, user: { id: "U00000002", name: "bob", real_name: "Bob", profile: { display_name: "bob" } } },
  "conversations.replies__channel=C00000001&limit=1&ts=1700000001.000100": {
    ok: true, messages: [{ type: "message", user: "U00000002", text: "please review the deck\nsecond line", ts: "1700000001.000100" }],
  },
  "conversations.replies__channel=D00000001&limit=1&ts=1700000002.000200": {
    ok: true, messages: [{ type: "message", user: "U00000002", text: "send the invoice", ts: "1700000002.000200" }],
  },
  // A thread reply comes back inside its thread: the parent first, not the reply.
  "conversations.replies__channel=C00000001&limit=1&ts=1700000003.000300": {
    ok: true, messages: [{ type: "message", user: "U00000002", text: "the parent", ts: "1700000000.000001" }],
  },
};

describe("slack todos (CLI)", { timeout: 60_000 }, () => {
  let m: MockHandle;
  beforeAll(async () => { m = await startMock({ inline: fixtures }); });
  afterAll(async () => { await m.stop(); });

  test("lists to-dos soonest due first, with place, author, first line and link", async () => {
    const before = m.requests.length;
    const r = await run(["todos"], m.baseUrl);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^☐ due .+  OVERDUE  #channel-01$/);
    expect(lines[1]).toBe("   @bob: please review the deck");
    expect(lines[2]).toBe("   https://acme.slack.com/archives/C00000001/p1700000001000100");
    expect(lines[3]).toMatch(/^☐ due .+  #channel-01$/);
    expect(lines[3]).not.toContain("OVERDUE");
    expect(lines[4]).toBe("   @bob: send the invoice");
    // An unreadable message (a reply its thread read did not return) still lists.
    expect(lines[6]).toBe("☐ no due date  #channel-01");
    expect(lines[7]).toBe("   (message not readable)");
    const reqs = m.requests.slice(before);
    const saved = reqs.find((q) => q.method === "saved.list");
    expect(new URLSearchParams(saved!.body).get("filter")).toBe("todo");
    // Read-only: no write method is ever called.
    expect(reqs.filter((q) => /^(saved\.(add|update|delete)|chat\.|reactions\.)/.test(q.method))).toEqual([]);
  });

  test("--filter is passed through and -n caps the output after sorting", async () => {
    const before = m.requests.length;
    const r = await run(["todos", "ls", "--filter", "completed", "-n", "1"], m.baseUrl);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    // The overdue item is third in the response but first by due date.
    expect(lines[0]).toContain("OVERDUE");
    const saved = m.requests.slice(before).find((q) => q.method === "saved.list");
    const p = new URLSearchParams(saved!.body);
    expect([p.get("filter"), p.get("limit")]).toEqual(["completed", "50"]);
  });

  test("-n cuts only after every page is read and sorted", async () => {
    // Page 1 holds a later to-do; the overdue one is on page 2.
    const page = (ts: string, due: number, next: string) => ({
      ok: true,
      saved_items: [{ item_id: "C00000001", item_type: "message", ts, date_due: due, todo_state: "to_do", state: "in_progress" }],
      response_metadata: { next_cursor: next },
    });
    const e = await startMock({ inline: { ...fixtures, "saved.list": { __sequence: [page("1700000002.000200", FUTURE, "p2"), page("1700000001.000100", PAST, "")] } } });
    try {
      const r = await run(["todos", "-n", "1", "--json"], e.baseUrl);
      expect(r.exitCode, r.stderr).toBe(0);
      const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ts: "1700000001.000100", due: PAST });
      expect(e.requests.filter((q) => q.method === "saved.list")).toHaveLength(2);
    } finally {
      await e.stop();
    }
  });

  test("--json emits one object per item with the message text", async () => {
    const r = await run(["todos", "--json"], m.baseUrl);
    expect(r.exitCode).toBe(0);
    const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      channel: "C00000001", due: PAST, done: false, user: "U00000002",
      text: "please review the deck\nsecond line",
      permalink: "https://acme.slack.com/archives/C00000001/p1700000001000100",
    });
    expect(rows[2]).toMatchObject({ text: null, user: null });
  });

  test("an empty list says so", async () => {
    const e = await startMock({ inline: { ...fixtures, "saved.list": { ok: true, saved_items: [] } } });
    try {
      const r = await run(["todos", "--filter", "archived"], e.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("No archived items.");
      const t = await run(["todos"], e.baseUrl);
      expect(t.stdout.trim()).toBe("No to-dos.");
      // --json stays JSONL: no rows means no stdout at all.
      const j = await run(["todos", "--json"], e.baseUrl);
      expect(j.exitCode).toBe(0);
      expect(j.stdout.trim()).toBe("");
      expect(j.stderr).toContain("No to-dos.");
    } finally {
      await e.stop();
    }
  });

  test("a limit below 1 is rejected before any call", async () => {
    const before = m.requests.length;
    const r = await run(["todos", "-n", "0"], m.baseUrl);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--limit must be a whole number of at least 1");
    expect(m.requests.slice(before)).toEqual([]);
  });

  test("a bad --filter is rejected before any call", async () => {
    const r = await run(["todos", "--filter", "nope"], m.baseUrl);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Invalid values");
  });
});
