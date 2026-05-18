// Cross-impl parity: TS CLI vs Rust binary against the mock server.
//
// Skips Rust cases if the release binary is absent — run
// `cargo build --release --manifest-path rs/Cargo.toml` first to enable.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RUST_BIN = join(ROOT, "rs", "target", "release", "slack");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");
const MOCK_DIR = join(HERE, "fixtures", "mock");

const hasFixtures = existsSync(MOCK_DIR) && readdirSync(MOCK_DIR).some((f) => f.endsWith(".json"));

let mock: MockHandle | undefined;
let tmpHome: string;

beforeAll(async () => {
  // Isolated home so no profiles.json / lockfiles bleed in from the real user env.
  tmpHome = mkdtempSync(join(tmpdir(), "slack-parity-"));
  if (hasFixtures) mock = await startMock();
});

afterAll(async () => {
  if (mock) await mock.stop();
  rmSync(tmpHome, { recursive: true, force: true });
});

type Case = { name: string; args: string[] };

const cases: Case[] = [
  { name: "news --limit 5", args: ["news", "--limit", "5"] },
  { name: "search deploy --count 10", args: ["search", "deploy", "--count", "10"] },
];

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  // Strip real token / real HOME so the subprocess sees only the mock config.
  const { SLACK_MCP_XOXP_TOKEN: _t, HOME: _h, ...rest } = process.env as Record<string, string>;
  return { ...rest, HOME: tmpHome, ...extra };
}

// Async spawn wrapper — spawnSync blocks the event loop, preventing the
// in-process mock HTTP server from handling requests.
function runProcess(cmd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: cleanEnv(env), encoding: "utf8" } as Parameters<typeof spawn>[2]);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr!.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (code: number | null) => {
      if (code !== 0) reject(new Error(`exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    child.on("error", reject);
  });
}

function runTs(args: string[], env: Record<string, string>): Promise<string> {
  return runProcess("bun", ["run", TS_ENTRY, ...args], env);
}

function runRust(args: string[], env: Record<string, string>): Promise<string> {
  return runProcess(RUST_BIN, args, env);
}

describe.skipIf(!hasFixtures).each(cases)("parity: $name", ({ args }) => {
  test("TS runs without error", { timeout: 60_000 }, async () => {
    if (!mock) throw new Error("mock not started");
    const env = {
      SLACK_API_BASE: `${mock.baseUrl}/api`,
      SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    };
    const out = await runTs(args, env);
    expect(out).toBeTypeOf("string");
  });

  test.skipIf(!existsSync(RUST_BIN))("TS and Rust produce identical output", { timeout: 60_000 }, async () => {
    if (!mock) throw new Error("mock not started");
    const env = {
      SLACK_API_BASE: `${mock.baseUrl}/api`,
      SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    };
    const tsOut = await runTs(args, env);
    const rustOut = await runRust(args, env);
    expect(tsOut).toEqual(rustOut);
  });
});

describe.skipIf(hasFixtures)("parity (no fixtures)", () => {
  test.skip("run `bun run record` with a real token to enable parity tests", () => {});
});
