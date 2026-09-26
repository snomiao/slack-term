import { afterEach, beforeEach, expect, test } from "./harness.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = new URL("../ts/cli.ts", import.meta.url).pathname;
let testDir: string;

beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), "slack-auth-token-")); });
afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

function run(args: string[] = [], extraEnv: Record<string, string> = {}, command = "token") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SLACK_")));
  return spawnSync("bun", [entry, "auth", command, ...args], {
    cwd: testDir,
    env: { ...env, HOME: testDir, SLACK_API_BASE: "http://127.0.0.1:1", ...extraEnv },
    encoding: "utf8",
    timeout: 10000,
  });
}

function profile() {
  const dir = join(testDir, ".config", "slack-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify({ profiles: {
    acme: { token: "xoxc-fake-profile", cookie: "xoxd-fake-cookie", team: "Acme", user: "alice" },
  } }));
  mkdirSync(join(testDir, ".slack-cli"));
  writeFileSync(join(testDir, ".slack-cli", "workspace"), "acme\n");
}

test("prints only the environment token and newline without contacting Slack", () => {
  const result = run([], { SLACK_TOKEN: "xoxp-fake-env" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("xoxp-fake-env\n");
  expect(result.stderr).toBe("");
});

test("prints the selected profile token, never its cookie", () => {
  profile();
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("xoxc-fake-profile\n");
  expect(result.stderr).toBe("");
});

test("workspace flag overrides the environment token", () => {
  profile();
  const result = run(["--workspace", "acme"], { SLACK_TOKEN: "xoxp-fake-env" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("xoxc-fake-profile\n");
});

test("environment override still wins without the workspace flag", () => {
  profile();
  const result = run([], { SLACK_TOKEN: "xoxp-fake-env" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("xoxp-fake-env\n");
});

test("missing credentials fail with empty stdout and setup guidance on stderr", () => {
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("slack auth login");
});

test("unknown workspace fails without printing a different token", () => {
  profile();
  const result = run(["-w", "missing"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('Workspace "missing" not found');
});


test("env exports the selected desktop token and cookie as dotenv assignments", () => {
  profile();
  const result = run([], {}, "env");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("SLACK_TOKEN='xoxc-fake-profile'\nSLACK_COOKIE='xoxd-fake-cookie'\n");
  expect(result.stderr).toBe("");
});

test("env workspace overrides both environment credentials", () => {
  profile();
  const result = run(["-w", "acme"], {
    SLACK_TOKEN: "xoxc-fake-env", SLACK_COOKIE: "xoxd-fake-env",
  }, "env");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("SLACK_TOKEN='xoxc-fake-profile'\nSLACK_COOKIE='xoxd-fake-cookie'\n");
});

test("env quotes cookie punctuation and round-trips through dotenv loading", () => {
  const result = run([], {
    SLACK_TOKEN: "xoxc-fake-env", SLACK_COOKIE: "xoxd-fake+/=$#value",
  }, "env");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("SLACK_TOKEN='xoxc-fake-env'\nSLACK_COOKIE='xoxd-fake+/=$#value'\n");
  writeFileSync(join(testDir, ".env.local"), result.stdout);
  const reloaded = run([], {}, "env");
  expect(reloaded.status).toBe(0);
  expect(reloaded.stdout).toBe(result.stdout);
});

for (const prefix of ["xoxp", "xoxb"]) {
  test(`env omits cookies for ${prefix} tokens`, () => {
    const result = run([], { SLACK_TOKEN: `${prefix}-fake-env`, SLACK_COOKIE: "xoxd-fake-env" }, "env");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`SLACK_TOKEN='${prefix}-fake-env'\n`);
  });
}

test("env omits an unavailable desktop cookie", () => {
  const result = run([], { SLACK_TOKEN: "xoxc-fake-env" }, "env");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("SLACK_TOKEN='xoxc-fake-env'\n");
});

test("env missing credentials fails without stdout", () => {
  const result = run([], {}, "env");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

test("env rejects multiline credentials without partial output or leaking values", () => {
  const result = run([], { SLACK_TOKEN: "xoxc-fake-env", SLACK_COOKIE: "xoxd-fake\nINJECTED=value" }, "env");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Cannot export SLACK_COOKIE");
  expect(result.stderr).not.toContain("xoxd-fake");
});
