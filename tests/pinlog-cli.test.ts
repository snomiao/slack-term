// CLI-level tests for `slack pinlog`: every path in both directions — the
// write happens when it should, and does NOT happen when it should not (the
// preview, a failed edit, a non-board target). Requests are asserted on the
// mock, because "the output said ✓" is exactly what a fail-vs-absent bug fakes.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle, type InlineFixtures } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

const CH = "C00000001";
const HEAD_TS = "1700000000.000100";
const ID = `${CH}:${HEAD_TS}`;
const FOOTER = "_Pinlog · 最終更新 2026-10-08 15:00 JST · 更新はスレッドに_";
const HEAD_TEXT = `状態: 青\n- 見積: 済\n\n${FOOTER}`;

const base: InlineFixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "alice", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  "conversations.info": { ok: true, channel: { id: CH, name: "gtm" } },
  "users.info": { ok: true, user: { id: "U00000002", name: "bob" } },
  "pins.add": { ok: true },
  "conversations.replies": {
    ok: true,
    messages: [
      { ts: HEAD_TS, user: "U00000001", text: HEAD_TEXT, reply_count: 1 },
      { ts: "1700000100.000200", thread_ts: HEAD_TS, user: "U00000002", text: "見積: 未 → 済" },
    ],
  },
  "conversations.history": {
    ok: true,
    messages: [
      { ts: "1700000300.000300", user: "U00000002", text: "unrelated chatter" },
      { ts: HEAD_TS, user: "U00000001", text: HEAD_TEXT, reply_count: 3, pinned_to: [CH] },
    ],
  },
};

let tmpHome: string;
beforeAll(() => { tmpHome = mkdtempSync(join(tmpdir(), "slack-pinlogcli-")); });
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(m: MockHandle, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    SLACK_QUIET_START: _qs, SLACK_QUIET_END: _qe, SLACK_QUIET_TZ: _qt,
    ...rest
  } = process.env as Record<string, string>;
  const fullEnv = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${m.baseUrl}/api`,
    SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    SLACK_TERM_ATTRIBUTION: "off",
    // Never quiet unless a test says so (start > end is false and hour < 0 never holds).
    SLACK_QUIET_START: "0",
    SLACK_QUIET_END: "0",
    ...env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env: fullEnv, stdio: ["ignore", "pipe", "pipe"] });
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

function codeOf(r: RunResult): string {
  const m = r.stderr.match(/Rerun with --code=([0-9a-f]{4})/);
  if (!m) throw new Error(`no code in:\n${r.stdout}\n${r.stderr}`);
  return m[1]!;
}

/** Preview, then confirm with the code the preview printed. */
async function confirmed(m: MockHandle, args: string[], env: Record<string, string> = {}): Promise<{ dry: RunResult; r: RunResult; writes: string[] }> {
  const dry = await run(m, args, env);
  const before = m.requests.length;
  const r = await run(m, [...args, `--code=${codeOf(dry)}`], env);
  const writes = m.requests.slice(before).filter((q) => WRITES.has(q.method)).map((q) => q.method);
  return { dry, r, writes };
}

const WRITES = new Set(["chat.postMessage", "chat.update", "pins.add", "chat.delete"]);

async function withMock<T>(extra: InlineFixtures, fn: (m: MockHandle) => Promise<T>): Promise<T> {
  const m = await startMock({ inline: { ...base, ...extra } });
  try {
    return await fn(m);
  } finally {
    await m.stop();
  }
}

function body(m: MockHandle, method: string): Record<string, unknown> {
  const q = [...m.requests].reverse().find((x) => x.method === method);
  if (!q) throw new Error(`no ${method} request`);
  return JSON.parse(q.body) as Record<string, unknown>;
}

describe("pinlog create", { timeout: 60_000 }, () => {
  test("preview writes nothing and shows the HEAD with its footer", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "create", CH, "状態: 青"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("状態: 青");
      expect(r.stdout).toContain("Pinlog · 最終更新");
      expect(r.stdout).toContain("then pinned");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("confirmed: posts a plain top-level HEAD, pins it, prints the id", async () => {
    await withMock({}, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "create", CH, "状態: 青"]);
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.postMessage", "pins.add"]);
      const post = body(m, "chat.postMessage");
      expect(post.channel).toBe(CH);
      expect(post.thread_ts).toBeUndefined();
      // plain: no blocks, so the footer reads back verbatim for update/list
      expect(post.blocks).toBeUndefined();
      expect(String(post.text)).toMatch(/^状態: 青\n\n_Pinlog · 最終更新 \d{4}-\d{2}-\d{2} \d{2}:\d{2} JST · 更新はスレッドに_$/);
      expect(body(m, "pins.add")).toEqual({ channel: CH, timestamp: HEAD_TS });
      expect(r.stdout).toContain(`✓ Posted HEAD: ${ID}`);
      expect(r.stdout).toContain("✓ Pinned");
    });
  });

  test("missing pins:write: board still created, says NOT pinned, gives the pin command, exit 0", async () => {
    await withMock({ "pins.add": { ok: false, error: "missing_scope" } }, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "create", CH, "状態: 青", "--as-bot"], { SLACK_BOT_TOKEN: "xoxb-fake" });
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.postMessage", "pins.add"]);
      expect(r.stdout).toContain(`✓ Posted HEAD: ${ID}`);
      expect(r.stdout).not.toContain("✓ Pinned");
      expect(r.stderr).toContain("NOT pinned: the bot token lacks the pins:write scope");
      expect(r.stderr).toContain(`slack pinlog pin ${ID} --as-bot`);
    });
  });

  test("--as-bot posts and pins with the BOT token; without it, the user token", async () => {
    await withMock({}, async (m) => {
      await confirmed(m, ["pinlog", "create", CH, "x", "--as-bot"], { SLACK_BOT_TOKEN: "xoxb-fake" });
      const auths = m.requests.filter((q) => WRITES.has(q.method)).map((q) => q.headers.authorization);
      expect(auths).toEqual(["Bearer xoxb-fake", "Bearer xoxb-fake"]);
    });
    await withMock({}, async (m) => {
      // (No SLACK_BOT_TOKEN here: with no profiles, the legacy env path makes it
      // the DEFAULT token — pre-existing behaviour, not pinlog's to test.)
      await confirmed(m, ["pinlog", "create", CH, "x"]);
      const auths = m.requests.filter((q) => WRITES.has(q.method)).map((q) => q.headers.authorization);
      expect(auths).toEqual(["Bearer xoxp-fake", "Bearer xoxp-fake"]);
    });
  });

  test("a failed post is reported as a failure, and nothing is pinned", async () => {
    await withMock({ "chat.postMessage": { ok: false, error: "not_in_channel" } }, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "create", CH, "x"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("HEAD was NOT posted");
      expect(r.stdout).not.toContain("✓");
      expect(writes).toEqual(["chat.postMessage"]);
    });
  });

  test("--name registers the id; a second create with the same name is refused before any write", async () => {
    await withMock({}, async (m) => {
      const { r } = await confirmed(m, ["pinlog", "create", CH, "x", "--name", "dup-test"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("✓ Registered name: dup-test");
      const before = m.requests.length;
      const again = await run(m, ["pinlog", "create", CH, "y", "--name", "dup-test"]);
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toContain(`already exists → ${ID}`);
      expect(m.requests.slice(before).filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("a channel:ts target is refused — create makes a NEW message", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "create", `#gtm:${HEAD_TS}`, "x"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("NEW top-level message");
    });
  });
});

describe("pinlog update", { timeout: 60_000 }, () => {
  const args = ["pinlog", "update", ID, "状態: 黄\n- 見積: 済\n- 契約: 法務確認待ち", "--log", "契約: 法務確認待ちを追加"];

  test("preview shows current HEAD, new HEAD and the log line, and writes nothing", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, args);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Current HEAD");
      expect(r.stdout).toContain("状態: 青");
      expect(r.stdout).toContain("New HEAD (edited in place — silent)");
      expect(r.stdout).toContain("契約: 法務確認待ち");
      expect(r.stdout).toContain("Log reply (in the thread — notifies)");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("confirmed: edits HEAD (plain, footer refreshed) THEN posts one thread reply", async () => {
    await withMock({}, async (m) => {
      const { r, writes } = await confirmed(m, args);
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.update", "chat.postMessage"]);
      const upd = body(m, "chat.update");
      expect(upd).toMatchObject({ channel: CH, ts: HEAD_TS });
      expect(upd.blocks).toBeUndefined();
      expect(String(upd.text)).toMatch(/^状態: 黄\n- 見積: 済\n- 契約: 法務確認待ち\n\n_Pinlog · 最終更新 .* JST · 更新はスレッドに_$/);
      const log = body(m, "chat.postMessage");
      expect(log).toMatchObject({ channel: CH, thread_ts: HEAD_TS, text: "契約: 法務確認待ちを追加" });
      expect(r.stdout).toContain("✓ HEAD updated");
      expect(r.stdout).toContain("✓ Logged");
    });
  });

  test("a failed edit posts NO log line", async () => {
    await withMock({ "chat.update": { ok: false, error: "cant_update_message" } }, async (m) => {
      const { r, writes } = await confirmed(m, args);
      expect(r.exitCode).toBe(1);
      expect(writes).toEqual(["chat.update"]);
      expect(r.stderr).toContain("HEAD was NOT updated");
      expect(r.stderr).toContain("add --as-bot");
      expect(r.stdout).not.toContain("✓");
    });
  });

  test("a failed log post says so and prints a retry that works and posts ONLY the log", async () => {
    let retry = "";
    await withMock({ "chat.postMessage": { ok: false, error: "rate_limited_ish" } }, async (m) => {
      const { r, writes } = await confirmed(m, args);
      expect(r.exitCode).toBe(1);
      expect(writes).toEqual(["chat.update", "chat.postMessage"]);
      expect(r.stdout).toContain("✓ HEAD updated");
      expect(r.stderr).toContain("Log reply was NOT posted");
      expect(r.stderr).toContain("The HEAD IS updated");
      const line = r.stderr.split("\n").find((l) => l.includes("--log-only"));
      expect(line).toBeDefined();
      // eslint-disable-next-line no-control-regex
      retry = line!.replace(/\x1b\[[0-9;]*m/g, "").trim();
    });
    expect(retry).toMatch(/^slack pinlog update C00000001:1700000000\.000100 --log-only --log '契約: 法務確認待ちを追加' --code=[0-9a-f]{4}$/);
    await withMock({}, async (m) => {
      const code = retry.match(/--code=([0-9a-f]{4})/)![1]!;
      const r = await run(m, ["pinlog", "update", ID, "--log-only", "--log", "契約: 法務確認待ちを追加", `--code=${code}`]);
      expect(r.exitCode).toBe(0);
      expect(m.requests.filter((q) => WRITES.has(q.method)).map((q) => q.method)).toEqual(["chat.postMessage"]);
      expect(body(m, "chat.postMessage")).toMatchObject({ thread_ts: HEAD_TS });
    });
  });

  test("a message without the footer is refused before any write", async () => {
    const notBoard = { "conversations.replies": { ok: true, messages: [{ ts: HEAD_TS, user: "U00000001", text: "just a message" }] } };
    await withMock(notBoard, async (m) => {
      const r = await run(m, [...args, "--code=0000"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not a pinlog HEAD");
      expect(r.stderr).toContain("--adopt");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("--adopt turns a hand-run board into a pinlog (footer added) and can register a name", async () => {
    const handRun = { "conversations.replies": { ok: true, messages: [{ ts: HEAD_TS, user: "U00000001", text: "販売ブロッカー（随時更新）\n1. 見積" }] } };
    await withMock(handRun, async (m) => {
      const { dry, r, writes } = await confirmed(m, [...args, "--adopt", "--name", "adopted"]);
      expect(dry.stdout).toContain("Adopting: this message has no pinlog footer yet");
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.update", "chat.postMessage"]);
      expect(String(body(m, "chat.update").text)).toContain("Pinlog · 最終更新");
      expect(r.stdout).toContain("✓ Registered name: adopted");
    });
  });

  test("--name on update refuses a name that already points at another board", async () => {
    await withMock({}, async (m) => {
      await confirmed(m, ["pinlog", "create", CH, "x", "--name", "taken"]);
      const other = "C00000002:1700000000.000999";
      const otherHead = { "conversations.replies": { ok: true, messages: [{ ts: "1700000000.000999", user: "U00000001", text: HEAD_TEXT }] } };
      await withMock(otherHead, async (m2) => {
        const r = await run(m2, ["pinlog", "update", other, "y", "--log", "y", "--name", "taken"]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("already points at another board");
        expect(m2.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
      });
    });
  });

  test("a code minted against an older HEAD does not confirm (someone else updated it)", async () => {
    let code = "";
    await withMock({}, async (m) => { code = codeOf(await run(m, args)); });
    const moved = { "conversations.replies": { ok: true, messages: [{ ts: HEAD_TS, user: "U00000001", text: `状態: 赤\n\n${FOOTER}` }] } };
    await withMock(moved, async (m) => {
      const r = await run(m, [...args, `--code=${code}`]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Code mismatch");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("--log is required", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "update", ID, "new"]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("log");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("quiet hours: the confirmed run warns that the reply notified", async () => {
    await withMock({}, async (m) => {
      const { r } = await confirmed(m, args, { SLACK_QUIET_START: "0", SLACK_QUIET_END: "24" });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("⚠ Quiet hours (JST): the log reply notified");
    });
  });

  test("outside quiet hours: no warning", async () => {
    await withMock({}, async (m) => {
      const { r } = await confirmed(m, args);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain("Quiet hours");
    });
  });

  test("a registered name resolves to its board", async () => {
    await withMock({}, async (m) => {
      await confirmed(m, ["pinlog", "create", CH, "x", "--name", "by-name"]);
      const { r } = await confirmed(m, ["pinlog", "update", "by-name", "y", "--log", "y"]);
      expect(r.exitCode).toBe(0);
      expect(body(m, "chat.update")).toMatchObject({ channel: CH, ts: HEAD_TS });
    });
  });

  test("an unknown name is an error, not a guess", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "update", "no-such-board", "y", "--log", "y"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("is not a pinlog");
    });
  });
});

describe("pinlog show / list / pin", { timeout: 60_000 }, () => {
  test("show prints HEAD then the log", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "show", ID]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`=== HEAD ${ID} ===`);
      expect(r.stdout).toContain("状態: 青");
      expect(r.stdout).toContain("=== log (1) ===");
      expect(r.stdout).toMatch(/2023-11-15 \d{2}:\d{2} JST {2}@bob: 見積: 未 → 済/);
    });
  });

  test("show --json", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "show", ID, "--json"]);
      const j = JSON.parse(r.stdout) as { isPinlog: boolean; updated: string; log: unknown[] };
      expect(j.isPinlog).toBe(true);
      expect(j.updated).toBe("2026-10-08 15:00 JST");
      expect(j.log.length).toBe(1);
    });
  });

  test("show: an API failure is a failure, not an empty board", async () => {
    await withMock({ "conversations.replies": { ok: false, error: "channel_not_found" } }, async (m) => {
      const r = await run(m, ["pinlog", "show", ID]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).not.toContain("=== log");
    });
  });

  test("list finds boards by marker only, with pin state and log count", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "list", CH]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`📌 ${ID}`);
      expect(r.stdout).toContain("updated 2026-10-08 15:00 JST  log 3");
      expect(r.stdout).toContain("状態: 青");
      expect(r.stdout).not.toContain("unrelated chatter");
    });
  });

  test("list with no boards says how far it looked", async () => {
    await withMock({ "conversations.history": { ok: true, messages: [{ ts: "1700000300.000300", text: "hi" }] } }, async (m) => {
      const r = await run(m, ["pinlog", "list", CH]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("No pinlogs in the last 1 messages");
    });
  });

  test("list: an API failure is a failure, not \"no pinlogs\"", async () => {
    await withMock({ "conversations.history": { ok: false, error: "not_in_channel" } }, async (m) => {
      const r = await run(m, ["pinlog", "list", CH]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).not.toContain("No pinlogs");
    });
  });

  test("pin pins; already_pinned is fine; missing_scope fails", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "pin", ID]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`✓ Pinned ${ID}`);
    });
    await withMock({ "pins.add": { ok: false, error: "already_pinned" } }, async (m) => {
      const r = await run(m, ["pinlog", "pin", ID]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Already pinned");
    });
    await withMock({ "pins.add": { ok: false, error: "missing_scope" } }, async (m) => {
      const r = await run(m, ["pinlog", "pin", ID]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("pins:write");
    });
  });
});
