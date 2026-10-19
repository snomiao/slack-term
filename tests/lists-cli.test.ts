// CLI integration tests for `lists create / add / set` (gated, bot token) and
// that `lists <ref>` still reads after `lists` became a command group.

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
beforeAll(() => { tmpHome = mkdtempSync(join(tmpdir(), "slack-lists-")); });
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(args: string[], baseUrl: string, env: Record<string, string> = {}): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const fullEnv = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${baseUrl}/api`,
    SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    SLACK_BOT_TOKEN: "xoxb-fake",
    ...env,
  } as Record<string, string>;
  // An empty value means "unset" — an empty SLACK_BOT_TOKEN is not the same as none.
  for (const [k, v] of Object.entries(fullEnv)) if (v === "") delete fullEnv[k];
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env: fullEnv });
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

const authWith = (scopes: string) => ({
  ok: true, user_id: "U00000BOT", user: "testbot", team: "Acme", team_id: "T00000001",
  url: "https://acme.slack.com/", bot_id: "B00000001", __headers: { "x-oauth-scopes": scopes },
});
const AUTH = authWith("lists:read,lists:write,chat:write");
const LIST_SCHEMA = {
  ok: true,
  items: [],
  list: {
    id: "F00000LIST",
    list_metadata: {
      schema: [
        { id: "Col00001", key: "col1", name: "媒体/項目", type: "text", is_primary_column: true },
        { id: "Col00002", key: "col2", name: "状態", type: "select", options: { choices: [{ value: "todo", label: "todo" }, { value: "doing", label: "doing" }, { value: "done", label: "done" }] } },
        { id: "Col00003", key: "col3", name: "リンク", type: "link" },
        { id: "Col00004", key: "todo_completed", name: "Completed", type: "todo_completed" },
      ],
    },
  },
};
const calls = (m: MockHandle, method: string) => m.requests.filter((q) => q.method === method);
const COLS = ["--col", "媒体/項目:text", "--col", "状態:select:todo,doing,done", "--col", "担当:text", "--col", "リンク:link", "--todo"];

describe("lists create (CLI)", { timeout: 60_000 }, () => {
  test("gate: previews and does not create; the code then creates and prints the list URL", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH, "slackLists.create": { ok: true, list_id: "F00000LIST" } } });
    try {
      const dry = await run(["lists", "create", "テスト", ...COLS], m.baseUrl);
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).toContain("column:  媒体/項目 (text) [primary]");
      expect(dry.stdout).toContain("column:  状態 (select: todo/doing/done)");
      expect(dry.stdout).toContain("todo:    on");
      expect(dry.stdout).toContain("[as bot]");
      expect(calls(m, "slackLists.create")).toHaveLength(0);

      const r = await run(["lists", "create", "テスト", ...COLS, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Created list テスト  (F00000LIST)");
      expect(r.stdout).toContain("https://acme.slack.com/lists/T00000001/F00000LIST");
      const body = JSON.parse(calls(m, "slackLists.create")[0]!.body);
      expect(body.name).toBe("テスト");
      expect(body.todo_mode).toBe(true);
      expect(body.schema).toHaveLength(4);
      expect(body.schema[0]).toMatchObject({ name: "媒体/項目", type: "text", is_primary_column: true });
      expect(calls(m, "slackLists.create")[0]!.headers.authorization).toBe("Bearer xoxb-fake");
    } finally {
      await m.stop();
    }
  });

  test("a code for a different schema is rejected", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH, "slackLists.create": { ok: true, list_id: "F00000LIST" } } });
    try {
      const dry = await run(["lists", "create", "テスト", ...COLS], m.baseUrl);
      const r = await run(["lists", "create", "テスト", "--col", "媒体/項目:text", `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Code mismatch");
      expect(calls(m, "slackLists.create")).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });

  test("a bot without lists:write fails before the gate, naming the scope", async () => {
    const m = await startMock({ inline: { "auth.test": authWith("lists:read,chat:write") } });
    try {
      const r = await run(["lists", "create", "テスト", ...COLS], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("lacks the lists:write scope");
      expect(r.stderr).not.toContain("--code=");
    } finally {
      await m.stop();
    }
  });

  test("no bot token: clear error", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH } });
    try {
      const r = await run(["lists", "create", "テスト", ...COLS], m.baseUrl, { SLACK_BOT_TOKEN: "" });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("needs a bot token");
    } finally {
      await m.stop();
    }
  });

  test("a bad --col fails without calling Slack", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH } });
    try {
      const r = await run(["lists", "create", "テスト", "--col", "状態:select"], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("needs choices");
      expect(m.requests).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });
});

describe("lists add / set (CLI)", { timeout: 60_000 }, () => {
  const inline = {
    "auth.test": AUTH,
    "slackLists.items.list": LIST_SCHEMA,
    "slackLists.items.create": { ok: true, item: { id: "Rec00000001" } },
    "slackLists.items.update": { ok: true },
  };

  test("add maps column names to ids and is gated", async () => {
    const m = await startMock({ inline });
    try {
      const args = ["lists", "add", "https://acme.slack.com/lists/T00000001/F00000LIST", "hello 1", "--set", "状態=todo", "--set", "リンク=https://example.com"];
      const dry = await run(args, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).toContain("list:    F00000LIST");
      expect(calls(m, "slackLists.items.create")).toHaveLength(0);
      const r = await run([...args, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Added row Rec00000001  hello 1");
      const body = JSON.parse(calls(m, "slackLists.items.create")[0]!.body);
      expect(body.list_id).toBe("F00000LIST");
      expect(body.initial_fields.map((f: { column_id: string }) => f.column_id)).toEqual(["Col00001", "Col00002", "Col00003"]);
      expect(body.initial_fields[1].select).toEqual(["todo"]);
    } finally {
      await m.stop();
    }
  });

  test("set --done checks off the todo Completed column", async () => {
    const m = await startMock({ inline });
    try {
      const args = ["lists", "set", "F00000LIST", "Rec00000001", "--done", "--set", "状態=done"];
      const dry = await run(args, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      expect(calls(m, "slackLists.items.update")).toHaveLength(0);
      const r = await run([...args, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Updated row Rec00000001");
      const body = JSON.parse(calls(m, "slackLists.items.update")[0]!.body);
      expect(body.cells).toEqual([
        { row_id: "Rec00000001", column_id: "Col00002", select: ["done"] },
        { row_id: "Rec00000001", column_id: "Col00004", checkbox: true },
      ]);
    } finally {
      await m.stop();
    }
  });

  test("set with nothing to set fails", async () => {
    const m = await startMock({ inline });
    try {
      const r = await run(["lists", "set", "F00000LIST", "Rec00000001"], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("nothing to set");
    } finally {
      await m.stop();
    }
  });

  test("missing_scope from Slack names lists:write", async () => {
    const m = await startMock({ inline: { ...inline, "auth.test": authWith(""), "slackLists.items.create": { ok: false, error: "missing_scope" } } });
    try {
      const dry = await run(["lists", "add", "F00000LIST", "hello 1"], m.baseUrl);
      const r = await run(["lists", "add", "F00000LIST", "hello 1", `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("lists:write");
    } finally {
      await m.stop();
    }
  });
});

describe("lists share (CLI)", { timeout: 60_000 }, () => {
  test("gated grant to a user; the code then calls access.set", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH, "slackLists.access.set": { ok: true } } });
    try {
      const args = ["lists", "share", "F00000LIST", "--user", "U00000001"];
      const dry = await run(args, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).toContain("access:  write");
      expect(calls(m, "slackLists.access.set")).toHaveLength(0);
      const r = await run([...args, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Granted write on F00000LIST to U00000001");
      expect(JSON.parse(calls(m, "slackLists.access.set")[0]!.body)).toEqual({ list_id: "F00000LIST", access_level: "write", user_ids: ["U00000001"] });
    } finally {
      await m.stop();
    }
  });

  test("owner shows a warning; users + channels together or a channel owner are refused", async () => {
    const m = await startMock({ inline: { "auth.test": AUTH } });
    try {
      const own = await run(["lists", "share", "F00000LIST", "--user", "U00000001", "--level", "owner"], m.baseUrl);
      expect(own.stdout).toContain("transfers ownership");
      const both = await run(["lists", "share", "F00000LIST", "--user", "U00000001", "--channel", "C00000001"], m.baseUrl);
      expect(both.exitCode).toBe(1);
      expect(both.stderr).toContain("not both");
      const chOwner = await run(["lists", "share", "F00000LIST", "--channel", "C00000001", "--level", "owner"], m.baseUrl);
      expect(chOwner.exitCode).toBe(1);
      expect(chOwner.stderr).toContain("only a user can be made owner");
    } finally {
      await m.stop();
    }
  });
});

describe("lists <ref> (read) still works as the group default", { timeout: 60_000 }, () => {
  test("reads rows via lists.records.list", async () => {
    const m = await startMock({
      inline: { "lists.records.list": { ok: true, records: [{ id: "Rec00000009", fields: [{ key: "col1", text: "hello 9" }] }] } },
    });
    try {
      const r = await run(["lists", "F00000LIST"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Rec00000009  col1=hello 9");
    } finally {
      await m.stop();
    }
  });

  test("--as-bot reads via the public slackLists.items.list with the bot token", async () => {
    const m = await startMock({
      inline: { "slackLists.items.list": { ok: true, items: [{ id: "Rec00000008", fields: [{ key: "col1", text: "hello 8" }] }] } },
    });
    try {
      const r = await run(["lists", "F00000LIST", "--as-bot"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Rec00000008  col1=hello 8");
      const req = calls(m, "slackLists.items.list")[0]!;
      expect(req.headers.authorization).toBe("Bearer xoxb-fake");
      expect(calls(m, "lists.records.list")).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });
});
