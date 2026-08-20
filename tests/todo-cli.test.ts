// CLI-level tests for the `todo ls` / `mytodo ls` split.
//
// tests/todo.test.ts covers buildTodoQuery, which is deliberately neutral — it
// takes `shared` as an argument and defaults to hasmy:. The *CLI* is where the
// my-vs-everyone decision is actually made, so a regression there (both
// commands quietly searching the same scope) would not fail a single
// library-level test. These assert the scope each command actually sends.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

const fixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  "search.messages": { ok: true, messages: { matches: [] } },
};

let mock: MockHandle;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-todocli-"));
  mock = await startMock({ inline: fixtures });
});

afterAll(async () => {
  await mock.stop();
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(args: string[]): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${mock.baseUrl}/api`,
    SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
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

/** The `(query: …)` diagnostic the listing prints, which carries the scope. */
function queryOf(stderr: string): string {
  const m = stderr.match(/\(query: (.+)\)/);
  if (!m) throw new Error(`No query line in stderr:\n${stderr}`);
  return m[1]!;
}

describe("todo ls / mytodo ls scope split (CLI)", { timeout: 60_000 }, () => {
  test("todo ls searches EVERYONE's reactions (has:)", async () => {
    const r = await run(["todo", "ls"]);
    expect(r.exitCode).toBe(0);
    const q = queryOf(r.stderr);
    expect(q).toContain("has::pushpin:");
    // no hasmy: anywhere — strip has: first so the substring check is honest
    expect(q).not.toContain("hasmy:");
  });

  test("mytodo ls searches only YOUR reactions (hasmy:)", async () => {
    const r = await run(["mytodo", "ls"]);
    expect(r.exitCode).toBe(0);
    const q = queryOf(r.stderr);
    expect(q).toContain("hasmy::pushpin:");
    // every term is hasmy: — nothing widened to has:
    expect(q.replace(/hasmy:/g, "")).not.toContain("has:");
  });

  test("the two commands differ ONLY in scope, not in the rest of the query", async () => {
    const all = queryOf((await run(["todo", "ls", "--state", "stuck"])).stderr);
    const mine = queryOf((await run(["mytodo", "ls", "--state", "stuck"])).stderr);
    expect(mine.replace(/hasmy:/g, "has:")).toBe(all);
  });

  test("todo ls --mine narrows to hasmy: without switching command", async () => {
    const q = queryOf((await run(["todo", "ls", "--mine"])).stderr);
    expect(q).toContain("hasmy::pushpin:");
  });

  test("--shared still parses under .strict() — it is the default now, not an error", async () => {
    const r = await run(["todo", "ls", "--shared"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("Unknown argument");
    expect(queryOf(r.stderr)).toContain("has::pushpin:");
  });

  test("filters still apply on both commands", async () => {
    expect(queryOf((await run(["todo", "ls", "--in", "eng", "--from", "alice"])).stderr))
      .toContain("in:#eng from:@alice");
    expect(queryOf((await run(["mytodo", "ls", "--in", "eng"])).stderr))
      .toContain("in:#eng");
  });
});

describe("todo ls identity line (CLI)", { timeout: 60_000 }, () => {
  test("names the account the listing is relative to, and the scope", async () => {
    const r = await run(["todo", "ls"]);
    expect(r.stderr).toContain("From: @user1 (U00000001) — Acme");
    expect(r.stderr).toContain("anyone's reactions [has:]");
  });

  test("mytodo ls says whose reactions hasmy: resolves to", async () => {
    const r = await run(["mytodo", "ls"]);
    expect(r.stderr).toContain("From: @user1 (U00000001) — Acme");
    expect(r.stderr).toContain("your reactions only [hasmy:]");
  });

  test("--json keeps stdout free of the diagnostics", async () => {
    const r = await run(["mytodo", "ls", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("From:");
    expect(r.stdout).not.toContain("query:");
  });

  test("identity lookup failure is fail-soft — the listing still runs", async () => {
    const m = await startMock({ inline: { ...fixtures, "auth.test": { ok: false, error: "invalid_auth" } } });
    try {
      const { SLACK_MCP_XOXP_TOKEN: _t, HOME: _h, ...rest } = process.env as Record<string, string>;
      const r = await new Promise<RunResult>((resolve, reject) => {
        const child = spawn("bun", ["run", TS_ENTRY, "todo", "ls"], {
          cwd: tmpHome,
          env: { ...rest, HOME: tmpHome, SLACK_API_BASE: `${m.baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake" },
        });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
        child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
        child.on("close", (c: number | null) => resolve({ exitCode: c ?? -1, stdout, stderr }));
        child.on("error", reject);
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("From: (unknown — auth.test failed)");
      expect(r.stderr).toContain("(query:");
    } finally {
      await m.stop();
    }
  });
});
