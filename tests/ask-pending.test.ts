// `slack ask --pending`: questions this machine asked that were answered but
// never collected, grouped by the asking session, with whether that agent is
// still alive, and the `--waitFor` line that collects each. Read-only; it never
// relays anything into another process. Mock Slack only.

import { describe, test, expect, beforeEach, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";
import { askBuildText, askBuildResolvedText } from "../ts/ask.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ENTRY = join(HERE, "..", "ts", "cli.ts");

const TS = "1700000000.000100";
const CHAN = "C00000001";
const SELF = "U00000001";
const BOB = "U00000BOB";
const SESSION = "00000000-0000-4000-8000-000000000002";
const DEAD_PID = "2147483646";
const LINK = `https://acme.slack.com/archives/${CHAN}/p1700000000000100`;

const BASE: InlineFixtures = {
  "auth.test": { ok: true, user_id: SELF, user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  [`conversations.history__channel=${CHAN}&limit=1`]: { ok: true, messages: [] },
  [`conversations.info__channel=${CHAN}`]: { ok: true, channel: { id: CHAN, name: "channel-01" } },
  [`chat.getPermalink__channel=${CHAN}&message_ts=${TS}`]: { ok: true, channel: CHAN, permalink: LINK },
  "users.list__limit=200": { ok: true, members: [{ id: SELF, name: "user1" }, { id: BOB, name: "bob" }] },
  [`users.info__user=${BOB}`]: { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
  "reactions.add": { ok: true },
  "reactions.remove": { ok: true },
};

const QUESTION = askBuildText(`<@${BOB}> ok?`, "", ["yes", "no"], [], true);

/** Slack's view of the question at collection time. */
function slackHas(msg: Record<string, unknown>): InlineFixtures {
  const messages = [{ type: "message", user: SELF, ts: TS, text: QUESTION, ...msg }];
  return {
    ...BASE,
    [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${TS}`]: { ok: true, messages },
    [`conversations.history__channel=${CHAN}&inclusive=true&limit=30&oldest=${TS}`]: { ok: true, messages },
  };
}
const PRESSED_NO = { reactions: [{ name: "question", users: [SELF] }, { name: "one", users: [SELF] }, { name: "two", users: [SELF, BOB] }] };

let tmpHome: string;
beforeEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = mkdtempSync(join(tmpdir(), "slack-pending-"));
});
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

type RunResult = { exitCode: number; stdout: string; stderr: string };
function run(args: string[], baseUrl: string, env: Record<string, string> = {}): Promise<RunResult> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env as Record<string, string>)) {
    if (/^(SLACK_|CLAUDE|AI_AGENT|CODEX|AGENT_YES)/.test(k) || k === "HOME") continue;
    clean[k] = v;
  }
  const full = {
    ...clean, HOME: tmpHome, SLACK_API_BASE: `${baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PID: DEAD_PID, AI_AGENT: "claude-code_9-9-9_agent", ...env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env: full, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (c: number | null) => resolve({ exitCode: c ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

/** Post the question for real (against the mock) so it lands in the log. */
async function askLogged(env: Record<string, string> = {}): Promise<void> {
  const m = await startMock({ inline: BASE });
  try {
    const args = ["ask", "#chan", "@bob ok?", "yes", "no", "--channel-id", CHAN];
    const dry = await run(args, m.baseUrl, env);
    const code = (dry.stdout + dry.stderr).match(/--code=([0-9a-f]{4})/)![1]!;
    const r = await run([...args, `--code=${code}`], m.baseUrl, env);
    expect(r.exitCode).toBe(0);
  } finally {
    await m.stop();
  }
}

async function pending(fx: InlineFixtures, args: string[] = [], env: Record<string, string> = {}) {
  const m = await startMock({ inline: fx });
  try {
    const r = await run(["ask", "--pending", ...args], m.baseUrl, env);
    return { ...r, writes: m.requests.filter((q) => q.httpMethod === "POST").map((q) => q.method) };
  } finally {
    await m.stop();
  }
}

describe("ask --pending", { timeout: 90_000 }, () => {
  test("an answered, uncollected ask is listed under its session with the answer", async () => {
    await askLogged();
    const r = await pending(slackHas(PRESSED_NO));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`session ${SESSION}`);
    expect(r.stdout).toContain(`pid ${DEAD_PID} (gone)`);
    expect(r.stdout).toContain("A: no");
    expect(r.stdout).toContain(`collect: slack ask --waitFor='${LINK}'`);
    expect(r.stderr).toContain("1 件が回答済み・未回収");
    // Read-only: it inspects questions, it does not settle them.
    expect(r.writes).toEqual([]);
  });

  test("--json carries the sender and the answer", async () => {
    await askLogged();
    const r = await pending(slackHas(PRESSED_NO), ["--json"]);
    const row = JSON.parse(r.stdout.trim());
    expect(row).toMatchObject({
      link: LINK, answer: "no", free_text: false,
      sender: { session_id: SESSION, cli: "claude-code", agent_pid: Number(DEAD_PID), alive: false },
    });
  });

  test("an unanswered ask is counted, not listed", async () => {
    await askLogged();
    const r = await pending(slackHas({}));
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("0 件が回答済み・未回収, 1 件が未回答");
  });

  test("once collected with --waitFor it is no longer pending", async () => {
    await askLogged();
    const m = await startMock({ inline: slackHas(PRESSED_NO) });
    try {
      const c = await run(["ask", "--waitFor", LINK, "--timeout", "0"], m.baseUrl);
      expect(c.exitCode).toBe(0);
      expect(c.stdout.trim()).toBe("no");
    } finally {
      await m.stop();
    }
    const r = await pending(slackHas(PRESSED_NO));
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("0 件の未回収の質問を確認");
  });

  test("a question stamped ✅ elsewhere is counted, not listed — and the log is left alone", async () => {
    await askLogged();
    const stamped = askBuildResolvedText(`<@${BOB}> ok?`, { answer: "no", how: "リアクション 2️⃣" }, "bob");
    const r = await pending(slackHas({ text: stamped }));
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("1 件は ✅ 回収済み");
    // Read-only against the log too: the same look gives the same answer.
    const again = await pending(slackHas({ text: stamped }));
    expect(again.stderr).toContain("1 件の未回収の質問を確認");
  });

  test("an ask from another workspace is named, not probed with this token", async () => {
    await askLogged();
    const other = { ...slackHas(PRESSED_NO), "auth.test": { ok: true, user_id: SELF, user: "user1", team: "Other", team_id: "T00000002" } };
    const m = await startMock({ inline: other });
    try {
      const r = await run(["ask", "--pending"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");
      expect(r.stderr).toContain("別のワークスペース「Acme」");
      expect(m.requests.some((q) => q.method === "conversations.history")).toBe(false);
    } finally {
      await m.stop();
    }
  });

  test("a LIVE asker is reported alive", async () => {
    // The test runner itself stands in for the live agent: it started before
    // the ask, and an unknown CLI name skips the process-name check.
    await askLogged({ CLAUDE_PID: String(process.pid), AI_AGENT: "", SLACK_TERM_AGENT_CLI: "test-agent" });
    const r = await pending(slackHas(PRESSED_NO));
    expect(r.stdout).toContain(`pid ${process.pid} (alive)`);
  });

  test("--since leaves older asks out", async () => {
    await askLogged();
    const r = await pending(slackHas(PRESSED_NO), ["--since", "2099-01-01"]);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("0 件の未回収の質問を確認");
  });

  // cross-vendor review 2026-09-27: a clarification delivered first must not
  // swallow the decision that comes after it. Delivery is now whatever
  // `--waitFor` actually handed its caller — nothing else marks it.
  test("a free-text reply collected with --waitFor is not re-reported; a later pill is, with the cursor", async () => {
    await askLogged();
    const REPLY_TS = "1700000100.000200";
    const clarify = slackHas({ reply_count: 1 });
    clarify[`conversations.replies__channel=${CHAN}&limit=30&ts=${TS}`] = { ok: true, messages: [
      { type: "message", user: SELF, ts: TS, text: QUESTION },
      { type: "message", user: BOB, ts: REPLY_TS, text: "背景を教えて", thread_ts: TS },
    ] };
    const before = await pending(clarify);
    expect(before.stdout).toContain("A: 背景を教えて");
    expect(before.stdout).toContain("決定ではありません");

    const m = await startMock({ inline: clarify });
    try {
      const c = await run(["ask", "--waitFor", LINK, "--timeout", "0"], m.baseUrl);
      expect(c.exitCode).toBe(5);
      expect(c.stdout.trim()).toBe("背景を教えて");
    } finally {
      await m.stop();
    }
    const after = await pending(clarify);
    expect(after.stdout.trim()).toBe("");
    expect(after.stderr).toContain("1 件が未回答");

    const decided = { ...clarify, ...slackHas({ reply_count: 1, ...PRESSED_NO }) };
    decided[`conversations.replies__channel=${CHAN}&limit=30&ts=${TS}`] = clarify[`conversations.replies__channel=${CHAN}&limit=30&ts=${TS}`]!;
    const r = await pending(decided);
    expect(r.stdout).toContain("A: no");
    expect(r.stdout).toContain(`collect: slack ask --waitFor='${LINK}' --after=${REPLY_TS}`);
  });

  test("there is no --deliver: answers are collected with --waitFor, never relayed via another tool", async () => {
    await askLogged();
    const r = await pending(slackHas(PRESSED_NO), ["--deliver"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/Unknown argument|deliver/i);
  });
});
