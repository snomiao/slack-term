// CLI-level tests for `slack pinlog`: every path in both directions — the
// write happens when it should, and does NOT happen when it should not (the
// preview, a failed edit, a non-board target). Requests are asserted on the
// mock, because "the output said ✓" is exactly what a fail-vs-absent bug fakes.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      const r = await run(m, ["pinlog", "new", CH, "状態: 青"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("状態: 青");
      expect(r.stdout).toContain("Pinlog · 最終更新");
      expect(r.stdout).toContain("then pinned");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("confirmed: posts a plain top-level HEAD, pins it, prints the id", async () => {
    await withMock({}, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "new", CH, "状態: 青"]);
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
      const { r, writes } = await confirmed(m, ["pinlog", "new", CH, "状態: 青", "--as-bot"], { SLACK_BOT_TOKEN: "xoxb-fake" });
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
      await confirmed(m, ["pinlog", "new", CH, "x", "--as-bot"], { SLACK_BOT_TOKEN: "xoxb-fake" });
      const auths = m.requests.filter((q) => WRITES.has(q.method)).map((q) => q.headers.authorization);
      expect(auths).toEqual(["Bearer xoxb-fake", "Bearer xoxb-fake"]);
    });
    await withMock({}, async (m) => {
      // (No SLACK_BOT_TOKEN here: with no profiles, the legacy env path makes it
      // the DEFAULT token — pre-existing behaviour, not pinlog's to test.)
      await confirmed(m, ["pinlog", "new", CH, "x"]);
      const auths = m.requests.filter((q) => WRITES.has(q.method)).map((q) => q.headers.authorization);
      expect(auths).toEqual(["Bearer xoxp-fake", "Bearer xoxp-fake"]);
    });
  });

  test("a failed post is reported as a failure, and nothing is pinned", async () => {
    await withMock({ "chat.postMessage": { ok: false, error: "not_in_channel" } }, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "new", CH, "x"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("HEAD was NOT posted");
      expect(r.stdout).not.toContain("✓");
      expect(writes).toEqual(["chat.postMessage"]);
    });
  });

  test("an ambiguous create failure says UNKNOWN and to list before retrying", async () => {
    await withMock({ "chat.postMessage": { ok: false, error: "fatal_error" } }, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "new", CH, "x"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("UNKNOWN whether the HEAD was posted");
      expect(r.stderr).toContain(`slack pinlog ls '${CH}'`);
      expect(writes).toEqual(["chat.postMessage"]);
    });
  });

  test("the preview shows the situation: boards already in the channel (set is probably meant)", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "new", CH, "x"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("1 board(s) already in this channel");
      expect(r.stdout + r.stderr).toContain(`${ID}  状態: 青`);
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
    await withMock({ "conversations.history": { ok: true, messages: [{ ts: "1700000300.000300", user: "U00000002", text: "chatter" }] } }, async (m) => {
      const r = await run(m, ["pinlog", "new", CH, "x"]);
      expect(r.stdout + r.stderr).toContain("no other boards in the last 200 messages");
    });
  });

  test("new with a reason posts it as the first thread reply, after the pin", async () => {
    await withMock({ "chat.postMessage": { ok: true, ts: HEAD_TS } }, async (m) => {
      const { dry, r, writes } = await confirmed(m, ["pinlog", "new", CH, "状態: 青", "10/9 リリース用に作成"]);
      expect(dry.stdout + dry.stderr).toContain("Reason (first thread reply");
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.postMessage", "pins.add", "chat.postMessage"]);
      expect(body(m, "chat.postMessage")).toMatchObject({ text: "10/9 リリース用に作成", thread_ts: HEAD_TS });
      expect(r.stdout).toContain("✓ Reason posted in the thread");
    });
  });

  test("show is an alias of get", async () => {
    await withMock({}, async (m) => {
      const a = await run(m, ["pinlog", "get", ID, "--json"]);
      const b = await run(m, ["pinlog", "show", ID, "--json"]);
      expect(b.exitCode).toBe(0);
      expect(b.stdout).toBe(a.stdout);
    });
  });

  test("new --file takes the reason as the only positional (it is posted, not dropped)", async () => {
    const f = join(tmpHome, "new-board.md");
    writeFileSync(f, "状態: 青\n");
    await withMock({ "chat.postMessage": { ok: true, ts: HEAD_TS } }, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "new", CH, "--file", f, "10/9 リリース用"]);
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.postMessage", "pins.add", "chat.postMessage"]);
      expect(body(m, "chat.postMessage")).toMatchObject({ text: "10/9 リリース用", thread_ts: HEAD_TS });
      const both = await run(m, ["pinlog", "new", CH, "x", "y", "--file", f]);
      expect(both.exitCode).toBe(2);
      expect(both.stderr).toContain("with --file, pass only the reason");
    });
  });

  test("a failed first reason prints a note retry that keeps --allow-url-adjacent and works", async () => {
    const reason = "詳細 https://example.com/ページ";
    let retry = "";
    let boardId = "";
    // The board post succeeds; only the thread reply (it carries thread_ts) fails.
    const replyFails = { "chat.postMessage": { __whenBodyIncludes: { needle: "thread_ts", response: { ok: false, error: "fatal_error" } } } };
    await withMock(replyFails, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "new", CH, "x", reason, "--allow-url-adjacent"]);
      expect(r.exitCode).toBe(1);
      expect(writes).toEqual(["chat.postMessage", "pins.add", "chat.postMessage"]);
      expect(r.stderr).toContain("UNKNOWN whether the reason was posted");
      boardId = r.stdout.match(/Posted HEAD: (\S+)/)![1]!;
      // eslint-disable-next-line no-control-regex
      retry = r.stderr.split("\n").find((l) => l.includes("slack pinlog note"))!.replace(/\x1b\[[0-9;]*m/g, "").trim();
    });
    expect(retry).toContain(`slack pinlog note ${boardId}`);
    expect(retry).toContain("--allow-url-adjacent");
    const argv = (await new Promise<string[]>((resolve) => {
      const c = spawn("bash", ["-c", `printf '%s\\0' ${retry.replace(/^slack /, "")}`]);
      let out = "";
      c.stdout.on("data", (d: Buffer) => { out += String(d); });
      c.on("close", () => resolve(out.split("\0").filter(Boolean)));
    }));
    await withMock({}, async (m) => {
      const r = await run(m, argv);
      expect(r.exitCode).toBe(0);
      expect(m.requests.filter((q) => WRITES.has(q.method)).map((q) => q.method)).toEqual(["chat.postMessage"]);
      expect(String(body(m, "chat.postMessage").text)).toBe(reason);
    });
  });

  test("ls on a board link is refused and points at get", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "ls", ID]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`slack pinlog get '${ID}'`);
    });
  });

  test("an oversized initial state is refused before any write", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "new", CH, "y".repeat(40_001)]);
      expect(r.exitCode).toBe(2);
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("a channel:ts target is refused — new makes a NEW board, and the error points at set", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "new", `#gtm:${HEAD_TS}`, "x"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("posts a NEW board");
      expect(r.stderr).toContain("slack pinlog set");
    });
  });
});

describe("pinlog update", { timeout: 60_000 }, () => {
  const args = ["pinlog", "set", ID, "状態: 黄\n- 見積: 済\n- 契約: 法務確認待ち", "契約: 法務確認待ちを追加"];

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
      const line = r.stderr.split("\n").find((l) => l.includes("slack pinlog note"));
      expect(line).toBeDefined();
      // eslint-disable-next-line no-control-regex
      retry = line!.replace(/\x1b\[[0-9;]*m/g, "").trim();
    });
    expect(retry).toMatch(/^slack pinlog note C00000001:1700000000\.000100 '契約: 法務確認待ちを追加' --code=[0-9a-f]{4}$/);
    await withMock({}, async (m) => {
      const code = retry.match(/--code=([0-9a-f]{4})/)![1]!;
      const r = await run(m, ["pinlog", "note", ID, "契約: 法務確認待ちを追加", `--code=${code}`]);
      expect(r.exitCode).toBe(0);
      expect(m.requests.filter((q) => WRITES.has(q.method)).map((q) => q.method)).toEqual(["chat.postMessage"]);
      expect(body(m, "chat.postMessage")).toMatchObject({ thread_ts: HEAD_TS });
    });
  });

  // Codex review: the retry shell-quoted the DECODED log, and the retry run
  // decodes again — so a literal `\n` turned into a newline and the code broke.
  test("the printed retry round-trips literal backslash escapes and yen", async () => {
    // As typed: `\\n` = a literal backslash-n, `¥¥` = one yen, `\n` = a newline.
    // (Not String.raw: bun turns non-ASCII inside it into \u escapes.)
    const tricky = "C:\\\\new ¥¥1000 \\\\n literal, \\n real";
    let retry = "";
    let posted = "";
    await withMock({ "chat.postMessage": { ok: false, error: "fatal_error" } }, async (m) => {
      const { r } = await confirmed(m, ["pinlog", "set", ID, "s", tricky]);
      posted = String(body(m, "chat.postMessage").text);
      expect(posted).toBe("C:\\new ¥1000 \\n literal, \n real");
      // eslint-disable-next-line no-control-regex
      retry = r.stderr.split("\n").find((l) => l.includes("slack pinlog note"))!.replace(/\x1b\[[0-9;]*m/g, "").trim();
    });
    // Run the printed command exactly as a shell would parse it.
    const argv = (await new Promise<string[]>((resolve) => {
      const c = spawn("bash", ["-c", `printf '%s\\0' ${retry.replace(/^slack /, "")}`]);
      let out = "";
      c.stdout.on("data", (d: Buffer) => { out += String(d); });
      c.on("close", () => resolve(out.split("\0").filter(Boolean)));
    }));
    await withMock({}, async (m) => {
      const r = await run(m, argv);
      expect(r.exitCode).toBe(0);
      expect(String(body(m, "chat.postMessage").text)).toBe(posted);
    });
  });

  test("the printed retry keeps --allow-url-adjacent (else it fails the URL guard)", async () => {
    const log = "詳細 https://example.com/ページ";
    let retry = "";
    await withMock({ "chat.postMessage": { ok: false, error: "fatal_error" } }, async (m) => {
      const { r } = await confirmed(m, ["pinlog", "set", ID, "s", log, "--allow-url-adjacent"]);
      // eslint-disable-next-line no-control-regex
      retry = r.stderr.split("\n").find((l) => l.includes("slack pinlog note"))!.replace(/\x1b\[[0-9;]*m/g, "").trim();
    });
    expect(retry).toContain("--allow-url-adjacent");
    const argv = (await new Promise<string[]>((resolve) => {
      const c = spawn("bash", ["-c", `printf '%s\\0' ${retry.replace(/^slack /, "")}`]);
      let out = "";
      c.stdout.on("data", (d: Buffer) => { out += String(d); });
      c.on("close", () => resolve(out.split("\0").filter(Boolean)));
    }));
    await withMock({}, async (m) => {
      const r = await run(m, argv);
      expect(r.exitCode).toBe(0);
      expect(String(body(m, "chat.postMessage").text)).toBe(log);
    });
  });

  // Codex round 3: a failure that MAY have landed (network, internal_error,
  // fatal_error) must not be reported as "NOT posted" with a blind retry —
  // retrying a reply that landed notifies everyone twice.
  test("an ambiguous log failure says UNKNOWN and to check the thread first", async () => {
    await withMock({ "chat.postMessage": { ok: false, error: "internal_error" } }, async (m) => {
      const { r } = await confirmed(m, args);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("UNKNOWN whether the log reply was posted");
      expect(r.stderr).not.toContain("Log reply was NOT posted");
      expect(r.stderr).toContain(`slack pinlog get ${ID}`);
      expect(r.stderr).toContain("only if it is not there");
    });
  });

  test("a definite log rejection says NOT posted, with no check-first detour", async () => {
    await withMock({ "chat.postMessage": { ok: false, error: "not_in_channel" } }, async (m) => {
      const { r } = await confirmed(m, args);
      expect(r.stderr).toContain("Log reply was NOT posted");
      expect(r.stderr).not.toContain("UNKNOWN");
    });
  });

  test("a state that would push the footer past Slack's 40k truncation is refused before any write", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "set", ID, "x".repeat(40_000), "big", "--code=0000"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("Slack truncates past 40000");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  // Merge-gate review: the HEAD comes from Slack; an escape sequence in it
  // could repaint the confirm preview.
  test("terminal escapes in the current HEAD are stripped from the preview", async () => {
    const evil = { "conversations.replies": { ok: true, messages: [{ ts: HEAD_TS, user: "U00000001", text: `ok\x1b[2J\x1b[Hfake\n\n${FOOTER}` }] } };
    await withMock(evil, async (m) => {
      const r = await run(m, args);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).not.toContain("\x1b[2J");
      expect(r.stdout).toContain("okfake");
    });
  });

  test("a concurrent update of the same board is refused before any write", async () => {
    const ldir = join(tmpHome, ".config", "slack-cli", "locks");
    mkdirSync(ldir, { recursive: true });
    const lock = join(ldir, `pinlog-${CH}-${HEAD_TS}.lock`);
    // A LIVE holder (this test process).
    writeFileSync(lock, `pid=${process.pid} since=now nonce=t\n`);
    try {
      await withMock({}, async (m) => {
        const r = await run(m, [...args, "--code=0000"]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("another update of");
        expect(r.stderr).toContain(`pid=${process.pid}`);
        expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
      });
      // A lock left by a DEAD process is broken, not obeyed forever.
      writeFileSync(lock, "pid=2147483646 since=then nonce=d\n");
      await withMock({}, async (m) => {
        const { r } = await confirmed(m, args);
        expect(r.exitCode).toBe(0);
      });
    } finally {
      rmSync(lock, { force: true });
    }
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

  test("--adopt turns a hand-run board into a pinlog (footer added)", async () => {
    const handRun = { "conversations.replies": { ok: true, messages: [{ ts: HEAD_TS, user: "U00000001", text: "販売ブロッカー（随時更新）\n1. 見積" }] } };
    await withMock(handRun, async (m) => {
      const { dry, r, writes } = await confirmed(m, [...args, "--adopt"]);
      expect(dry.stdout).toContain("Adopting: this message has no pinlog footer yet");
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.update", "chat.postMessage"]);
      expect(String(body(m, "chat.update").text)).toContain("Pinlog · 最終更新");
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

  test("the reason is required", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "set", ID, "new"]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("reason");
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

  test("a bare word is not a board: there are no names, only links (stateless)", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "set", "gtm-blockers", "y", "y"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("is a channel, not a board");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("set on a channel is refused with the ls hint — never a write of the wrong kind", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "set", "#gtm", "y", "y"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("slack pinlog ls '#gtm'");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("set without a reason is refused and points at note for reason-only", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "set", ID, "only state"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("slack pinlog note <board>");
      expect(m.requests.filter((q) => WRITES.has(q.method))).toEqual([]);
    });
  });

  test("set --file takes the reason as the only positional", async () => {
    const f = join(tmpHome, "board.md");
    writeFileSync(f, "状態: 緑\n");
    await withMock({}, async (m) => {
      const { r, writes } = await confirmed(m, ["pinlog", "set", ID, "--file", f, "法務: 済"]);
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.update", "chat.postMessage"]);
      expect(String(body(m, "chat.update").text)).toMatch(/^状態: 緑\n\n_Pinlog/);
      expect(body(m, "chat.postMessage")).toMatchObject({ text: "法務: 済", thread_ts: HEAD_TS });
      const both = await run(m, ["pinlog", "set", ID, "x", "y", "--file", f]);
      expect(both.exitCode).toBe(2);
      expect(both.stderr).toContain("with --file, pass only the reason");
    });
  });

  test("note posts only the reason; the state is untouched", async () => {
    await withMock({}, async (m) => {
      const { dry, r, writes } = await confirmed(m, ["pinlog", "note", ID, "まだ法務待ち — 再送済"]);
      expect(dry.stdout + dry.stderr).toContain("HEAD unchanged");
      expect(r.exitCode).toBe(0);
      expect(writes).toEqual(["chat.postMessage"]);
      expect(body(m, "chat.postMessage")).toMatchObject({ text: "まだ法務待ち — 再送済", thread_ts: HEAD_TS });
    });
  });
});

describe("pinlog show / list / pin", { timeout: 60_000 }, () => {
  test("show prints HEAD then the log", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "get", ID]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`=== HEAD ${ID} ===`);
      expect(r.stdout).toContain("状態: 青");
      expect(r.stdout).toContain("=== log (1) ===");
      expect(r.stdout).toMatch(/2023-11-15 \d{2}:\d{2} JST {2}@bob: 見積: 未 → 済/);
    });
  });

  // Codex review: Slack returns the OLDEST replies first, so one page drops the
  // newest entries — the ones a reader came for.
  test("show pages through the whole thread (newest entries included)", async () => {
    const p1 = `conversations.replies__channel=${CH}&limit=200&ts=${HEAD_TS}`;
    const p2 = `conversations.replies__channel=${CH}&cursor=c2&limit=200&ts=${HEAD_TS}`;
    const paged = {
      [p1]: { ok: true, messages: [{ ts: HEAD_TS, user: "U00000001", text: HEAD_TEXT }, { ts: "1700000100.000200", user: "U00000002", text: "old entry" }], response_metadata: { next_cursor: "c2" } },
      [p2]: { ok: true, messages: [{ ts: HEAD_TS, user: "U00000001", text: HEAD_TEXT }, { ts: "1700000200.000300", user: "U00000002", text: "NEWEST entry" }] },
    };
    await withMock(paged, async (m) => {
      const r = await run(m, ["pinlog", "get", ID]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("=== log (2) ===");
      expect(r.stdout).toContain("NEWEST entry");
      expect(r.stdout.split("=== HEAD").length).toBe(2);
      const j = JSON.parse((await run(m, ["pinlog", "get", ID, "--json"])).stdout) as { complete: boolean; log: unknown[] };
      expect(j.complete).toBe(true);
      expect(j.log.length).toBe(2);
    });
  });

  test("show looks each author up once, not once per entry", async () => {
    const many = { "conversations.replies": { ok: true, messages: [
      { ts: HEAD_TS, user: "U00000001", text: HEAD_TEXT },
      ...[1, 2, 3, 4, 5].map((i) => ({ ts: `170000010${i}.000200`, user: "U00000002", text: `entry ${i}` })),
    ] } };
    await withMock(many, async (m) => {
      const r = await run(m, ["pinlog", "get", ID]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("=== log (5) ===");
      expect(m.requests.filter((q) => q.method === "users.info").length).toBeLessThanOrEqual(1);
    });
  });

  test("show --json", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "get", ID, "--json"]);
      const j = JSON.parse(r.stdout) as { isPinlog: boolean; updated: string; log: unknown[] };
      expect(j.isPinlog).toBe(true);
      expect(j.updated).toBe("2026-10-08 15:00 JST");
      expect(j.log.length).toBe(1);
    });
  });

  test("show: an API failure is a failure, not an empty board", async () => {
    await withMock({ "conversations.replies": { ok: false, error: "channel_not_found" } }, async (m) => {
      const r = await run(m, ["pinlog", "get", ID]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).not.toContain("=== log");
    });
  });

  test("list finds boards by marker only, with pin state and log count", async () => {
    await withMock({}, async (m) => {
      const r = await run(m, ["pinlog", "ls", CH]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`📌 ${ID}`);
      expect(r.stdout).toContain("updated 2026-10-08 15:00 JST  log 3");
      expect(r.stdout).toContain("状態: 青");
      expect(r.stdout).not.toContain("unrelated chatter");
    });
  });

  test("list with no boards says how far it looked", async () => {
    await withMock({ "conversations.history": { ok: true, messages: [{ ts: "1700000300.000300", text: "hi" }] } }, async (m) => {
      const r = await run(m, ["pinlog", "ls", CH]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("No pinlogs in the last 1 messages");
    });
  });

  test("list: an API failure is a failure, not \"no pinlogs\"", async () => {
    await withMock({ "conversations.history": { ok: false, error: "not_in_channel" } }, async (m) => {
      const r = await run(m, ["pinlog", "ls", CH]);
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
