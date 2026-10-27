// CLI: `slack relay init` writes local files only. It needs no Slack token
// (no login wizard on a fresh machine) and is not a write for the bot-intent
// guard, even with SLACK_BOT_TOKEN exported and no SLACK_TOKEN.

import { describe, test, expect, beforeEach, afterEach } from "./harness.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TS_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "ts", "cli.ts");

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "slack-relay-cli-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function run(args: string[], extra: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h, SLACK_COOKIE: _c,
    SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w, SLACK_RELAY_URL: _u, SLACK_RELAY_TOKEN: _r,
    ...rest
  } = process.env as Record<string, string>;
  // Any network attempt goes nowhere.
  const env = { ...rest, HOME: home, SLACK_API_BASE: "http://127.0.0.1:9/api", ...extra };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: home, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (code: number | null) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("slack relay (CLI)", { timeout: 60_000 }, () => {
  test("init: default folder, token printed not written; again → exit 2; --force → 0", async () => {
    const r = await run(["relay", "init"], { SLACK_BOT_TOKEN: "xoxb-fake" });
    expect(r.stderr).not.toContain("refusing");
    expect(r.exitCode).toBe(0);
    const out = join(home, "slack-term-relay");
    expect(readdirSync(out).sort()).toEqual([".gitignore", "README.md", "package.json", "src", "wrangler.jsonc"]);
    const token = /RELAY_TOKEN[^\n]*\n {2}([0-9a-f]{64})\n/.exec(r.stdout)?.[1];
    expect(token).toBeDefined();
    for (const f of [".gitignore", "README.md", "package.json", "src/index.ts", "wrangler.jsonc"]) {
      expect(readFileSync(join(out, f), "utf8")).not.toContain(token!);
    }
    expect(r.stdout).toContain("npx wrangler deploy");
    // Nothing written outside the folder (no profile, no wizard state).
    expect(readdirSync(home).filter((f) => f !== ".bun").sort()).toEqual(["slack-term-relay"]); // .bun: the runtime's own cache

    writeFileSync(join(out, "README.md"), "mine");
    const again = await run(["relay", "init"]);
    expect(again.exitCode).toBe(2);
    expect(again.stderr).toContain("exists: package.json");
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("mine");

    const forced = await run(["relay", "init", "--force"]);
    expect(forced.exitCode).toBe(0);
    expect(readFileSync(join(out, "README.md"), "utf8")).toContain("# slack-term-relay");
  });

  test("init <dir> --name", async () => {
    const r = await run(["relay", "init", "x/relay", "--name", "team-relay"]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(home, "x", "relay", "wrangler.jsonc"), "utf8")).toContain('"name": "team-relay"');
    const bad = await run(["relay", "init", "y", "--name", "Nope!"]);
    expect(bad.exitCode).toBe(2);
    expect(existsSync(join(home, "y"))).toBe(false);
  });

  test("health without configuration → exit 2", async () => {
    const r = await run(["relay", "health"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("SLACK_RELAY_URL");
  });
});
