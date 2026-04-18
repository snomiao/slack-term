// Cross-impl parity: TS CLI vs Rust binary against the mock server.
//
// Skips Rust cases if the release binary is absent — run
// `cargo build --release --manifest-path rs/Cargo.toml` first to enable.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RUST_BIN = join(ROOT, "rs", "target", "release", "slack");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");
const ANON_DIR = join(HERE, "fixtures", "anon");

const hasFixtures = existsSync(ANON_DIR) && readdirSync(ANON_DIR).some((f) => f.endsWith(".json"));

let mock: MockHandle | undefined;

beforeAll(async () => {
  if (hasFixtures) mock = await startMock();
});

afterAll(async () => {
  if (mock) await mock.stop();
});

type Case = { name: string; args: string[] };

const cases: Case[] = [
  { name: "news --limit 5", args: ["news", "--limit", "5"] },
  { name: "search deploy --count 10", args: ["search", "deploy", "--count", "10"] },
];

function runTs(args: string[], env: Record<string, string>): string {
  const r = spawnSync("bun", ["run", TS_ENTRY, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`ts exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

function runRust(args: string[], env: Record<string, string>): string {
  const r = spawnSync(RUST_BIN, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`rust exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

describe.skipIf(!hasFixtures).each(cases)("parity: $name", ({ args }) => {
  test("TS runs without error", () => {
    if (!mock) throw new Error("mock not started");
    const env = {
      SLACK_API_BASE: `${mock.baseUrl}/api`,
      SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    };
    const out = runTs(args, env);
    expect(out).toBeTypeOf("string");
  });

  test.skipIf(!existsSync(RUST_BIN))("TS and Rust produce identical output", () => {
    if (!mock) throw new Error("mock not started");
    const env = {
      SLACK_API_BASE: `${mock.baseUrl}/api`,
      SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    };
    const tsOut = runTs(args, env);
    const rustOut = runRust(args, env);
    expect(tsOut).toEqual(rustOut);
  });
});

describe.skipIf(hasFixtures)("parity (no fixtures)", () => {
  test.skip("run `bun run record` with a real token to enable parity tests", () => {});
});
