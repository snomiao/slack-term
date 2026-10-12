// Piped output must arrive whole, or the process must fail loudly.
//
// Regression: `slack read "#chan" -n 400 --json` into a reader slower than the
// writer (a `subprocess.run(capture_output=True)` is enough) lost a contiguous
// block of rows from the middle — a different block each run — with exit 0, an
// empty stderr and an intact tail. Bun dropped `console.log` writes that met a
// full pipe once `process.stdout` had been touched (yargs touches it), and
// `process.exit()` discarded whatever `process.stdout.write` still had queued.
// Each test here holds the pipe full for a while before reading it.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");
const STDOUT_TS = join(ROOT, "ts", "stdout.ts");

let tmpHome: string;

beforeAll(() => { tmpHome = mkdtempSync(join(tmpdir(), "slack-stdout-")); });
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

type Run = { exitCode: number; stdout: string; stderr: string };

/** Spawn `bun <args>` and leave its stdout unread for `stallMs`, so the pipe
 *  fills and the child's writes meet a full pipe. `closeEarly` instead closes
 *  the read end at once, as `| head -1` would. */
function run(args: string[], env: Record<string, string>, stallMs: number, closeEarly = false): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", args, { cwd: tmpHome, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    // Resolve only once the child has exited AND its stdout is fully drained:
    // the child may exit while the pipe is still paused and full.
    let exitCode: number | undefined;
    let drained = false;
    const done = () => {
      if (exitCode !== undefined && drained) resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8"), stderr });
    };
    if (closeEarly) { child.stdout.destroy(); drained = true; }
    else {
      child.stdout.pause();
      child.stdout.on("data", (d: Buffer) => { chunks.push(d); });
      child.stdout.on("end", () => { drained = true; done(); });
      setTimeout(() => child.stdout.resume(), stallMs);
    }
    child.on("exit", (code: number | null, signal: string | null) => { exitCode = code ?? (signal ? -1 : -2); done(); });
    child.on("error", reject);
  });
}

function cliEnv(baseUrl: string): Record<string, string> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  return { ...rest, HOME: tmpHome, SLACK_API_BASE: `${baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake" };
}

// ~400 rows of ~1.5 KB: several times a pipe's 64 KB buffer.
const N = 400;
const PAD = "あ".repeat(500);
const MESSAGES = Array.from({ length: N }, (_, i) => ({
  type: "message",
  ts: `${1700000000 + N - i}.000100`, // history is newest first
  user: "U00000001",
  text: `row ${N - 1 - i} ${PAD}`,
}));
const FIXTURES: InlineFixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "me", team: "Acme", team_id: "T1", url: "https://acme.slack.com/" },
  "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
    ok: true, channels: [{ id: "C00000001", name: "general" }],
  },
  [`conversations.history__channel=C00000001&limit=${N}`]: { ok: true, messages: MESSAGES },
};

describe("piped output under a slow reader", { timeout: 60_000 }, () => {
  test("read --json delivers every row, in order, when the pipe stays full", async () => {
    const m = await startMock({ inline: FIXTURES });
    try {
      const r = await run(["run", TS_ENTRY, "read", "#general", "-n", String(N), "--json"], cliEnv(m.baseUrl), 1500);
      expect(r.exitCode, r.stderr).toBe(0);
      const lines = r.stdout.split("\n").filter((l) => l !== "");
      expect(lines.length).toBe(N);
      const rows = lines.map((l) => JSON.parse(l) as { text: string });
      expect(rows.map((x) => Number(x.text.split(" ")[1]))).toEqual(Array.from({ length: N }, (_, i) => i));
    } finally {
      await m.stop();
    }
  });

  test("writeAll output survives process.exit while the pipe is full", async () => {
    const script = join(tmpHome, "exit-after-write.ts");
    writeFileSync(script, [
      `import { outLine } from ${JSON.stringify(STDOUT_TS)};`,
      `process.stdout; // what yargs does at import`,
      `for (let i = 0; i < ${N}; i++) outLine(String(i) + " " + ${JSON.stringify(PAD)});`,
      `process.exit(3);`,
    ].join("\n"));
    const r = await run([script], { ...process.env as Record<string, string> }, 1500);
    expect(r.exitCode, r.stderr).toBe(3);
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    expect(lines.map((l) => Number(l.split(" ")[0]))).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  test("a reader that goes away makes the writer exit non-zero, not 0", async () => {
    const script = join(tmpHome, "epipe.ts");
    writeFileSync(script, [
      `import { outLine } from ${JSON.stringify(STDOUT_TS)};`,
      `await new Promise((r) => setTimeout(r, 300)); // let the parent close the pipe`,
      `for (let i = 0; i < ${N}; i++) outLine(String(i) + " " + ${JSON.stringify(PAD)});`,
    ].join("\n"));
    const r = await run([script], { ...process.env as Record<string, string> }, 0, true);
    expect(r.exitCode).not.toBe(0);
  });
});
