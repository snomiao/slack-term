// Sender attribution: every send/ask/edit/poll is written to a local SQLite log
// with who sent it (pid, cwd, git branch, agent CLI, session id), and the same
// attribution rides along as Slack message `metadata`. `slack sent` searches the
// log. Everything runs against the mock Slack server — no real posts.

import { describe, test, expect, beforeEach, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";
import { parseSince } from "../ts/sentlog.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

const TS = "1700000000.000100"; // what the mock's chat.postMessage returns
const CHAN = "C00000001";
const SESSION = "00000000-0000-4000-8000-000000000001";

const fixtures: InlineFixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  [`conversations.history__channel=${CHAN}&limit=1`]: { ok: true, messages: [] },
  [`conversations.info__channel=${CHAN}`]: { ok: true, channel: { id: CHAN, name: "channel-01" } },
  [`conversations.replies__channel=${CHAN}&limit=1&ts=${TS}`]: {
    ok: true, messages: [{ type: "message", user: "U00000001", text: "old text", ts: TS }],
  },
  [`chat.getPermalink__channel=${CHAN}&message_ts=${TS}`]: {
    ok: true, channel: CHAN, permalink: `https://acme.slack.com/archives/${CHAN}/p1700000000000100`,
  },
  "users.list__limit=200": { ok: true, members: [{ id: "U00000001", name: "user1" }, { id: "U00000BOB", name: "bob" }] },
  "reactions.add": { ok: true },
};

let tmpHome: string;
beforeEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = mkdtempSync(join(tmpdir(), "slack-sent-"));
});
afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

type RunResult = { exitCode: number; stdout: string; stderr: string };

/** The agent env is set EXPLICITLY — the suite itself may run under an agent
 *  whose own session id would otherwise leak into the assertions. */
function run(args: string[], baseUrl: string, env: Record<string, string> = {}): Promise<RunResult> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env as Record<string, string>)) {
    if (/^(SLACK_|CLAUDE|AI_AGENT|CODEX|AGENT_YES)/.test(k) || k === "HOME") continue;
    clean[k] = v;
  }
  const full = {
    ...clean,
    HOME: tmpHome,
    SLACK_API_BASE: `${baseUrl}/api`,
    SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
    CLAUDE_CODE_SESSION_ID: SESSION,
    CLAUDE_PID: "4242",
    AI_AGENT: "claude-code_9-9-9_agent",
    ...env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env: full, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (code: number | null) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

function code(out: string): string {
  const m = out.match(/--code=([0-9a-f]{4})/);
  if (!m) throw new Error(`no --code in:\n${out}`);
  return m[1]!;
}

/** Two-step confirm, as a script does it. */
async function confirmed(args: string[], baseUrl: string, env: Record<string, string> = {}): Promise<RunResult> {
  const dry = await run(args, baseUrl, env);
  return run([...args, `--code=${code(dry.stdout + dry.stderr)}`], baseUrl, env);
}

describe("sender attribution (send/ask/edit)", { timeout: 60_000 }, () => {
  test("send attaches the sender as Slack message metadata", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      const r = await confirmed(["send", "#chan", "hello", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const post = m.requests.find((q) => q.method === "chat.postMessage")!;
      const meta = JSON.parse(post.body).metadata;
      expect(meta.event_type).toBe("slack_term_sent");
      expect(meta.event_payload).toMatchObject({
        kind: "send", cli: "claude-code", session_id: SESSION, agent_pid: 4242, cwd: expect.stringContaining("slack-sent-"),
      });
    } finally {
      await m.stop();
    }
  });

  test("send is logged, and `slack sent` finds it with its sender", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      expect((await confirmed(["send", "#chan", "deploy note", "--channel-id", CHAN], m.baseUrl)).exitCode).toBe(0);
      const r = await run(["sent", "--json"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "send", channel: CHAN, target: "#chan", ts: TS, text: "deploy note",
        permalink: `https://acme.slack.com/archives/${CHAN}/p1700000000000100`,
        cli: "claude-code", session_id: SESSION, agent_pid: 4242, team: "Acme",
      });
      expect(rows[0].cwd).toContain("slack-sent-");
      // Human form names the sender on its own line.
      const h = await run(["sent"], m.baseUrl);
      expect(h.stdout).toContain(`session=${SESSION}`);
      expect(h.stdout).toContain("deploy note");
    } finally {
      await m.stop();
    }
  });

  test("`slack sent` filters by text, session, cwd, channel and kind", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      await confirmed(["send", "#chan", "alpha one", "--channel-id", CHAN], m.baseUrl);
      await confirmed(["send", "#chan", "beta two", "--channel-id", CHAN], m.baseUrl, { CLAUDE_CODE_SESSION_ID: "other-session" });
      const texts = async (args: string[]) =>
        (await run(["sent", "--json", ...args], m.baseUrl)).stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text);
      expect(await texts(["ALPHA"])).toEqual(["alpha one"]);
      expect(await texts(["--session", "other"])).toEqual(["beta two"]);
      expect(await texts(["--session", SESSION.slice(0, 8)])).toEqual(["alpha one"]);
      expect(await texts(["--cwd", tmpHome])).toEqual(["beta two", "alpha one"]);
      expect(await texts(["--cwd", "/nowhere"])).toEqual([]);
      expect(await texts(["--channel", "#chan"])).toEqual(["beta two", "alpha one"]);
      expect(await texts(["--channel", "C99999999"])).toEqual([]);
      expect(await texts(["--kind", "ask"])).toEqual([]);
      expect(await texts(["--since", "1h"])).toEqual(["beta two", "alpha one"]);
    } finally {
      await m.stop();
    }
  });

  test("a metadata rejection does not cost the send: retried without it", async () => {
    const m = await startMock({
      inline: {
        ...fixtures,
        "chat.postMessage": { __whenBodyIncludes: { needle: "\"metadata\"", response: { ok: false, error: "invalid_metadata_format" } } },
      },
    });
    try {
      const r = await confirmed(["send", "#chan", "hello", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const posts = m.requests.filter((q) => q.method === "chat.postMessage");
      expect(posts).toHaveLength(2);
      expect(JSON.parse(posts[1]!.body).metadata).toBeUndefined();
      // Still logged locally.
      expect((await run(["sent", "--json"], m.baseUrl)).stdout).toContain("\"hello\"");
    } finally {
      await m.stop();
    }
  });

  test("any other send failure is NOT retried (no duplicate post)", async () => {
    const m = await startMock({ inline: { ...fixtures, "chat.postMessage": { ok: false, error: "channel_not_found" } } });
    try {
      const r = await confirmed(["send", "#chan", "hello", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).not.toBe(0);
      expect(m.requests.filter((q) => q.method === "chat.postMessage")).toHaveLength(1);
    } finally {
      await m.stop();
    }
  });

  test("ask and edit are logged with their kind", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      expect((await confirmed(["ask", "#chan", "@bob ok?", "yes", "no", "--channel-id", CHAN], m.baseUrl)).exitCode).toBe(0);
      expect((await confirmed(["edit", `#chan:${TS}`, "new text", "--channel-id", CHAN], m.baseUrl)).exitCode).toBe(0);
      const rows = (await run(["sent", "--json"], m.baseUrl)).stdout.trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.map((r) => r.kind).sort()).toEqual(["ask", "edit"]);
      const ask = rows.find((r) => r.kind === "ask");
      expect(ask.text).toContain(":question:");
      expect(ask.session_id).toBe(SESSION);
      const upd = m.requests.find((q) => q.method === "chat.update")!;
      expect(JSON.parse(upd.body).metadata.event_payload.kind).toBe("edit");
    } finally {
      await m.stop();
    }
  });

  test("`slack sent` needs no token — it only reads the local log", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      const r = await run(["sent"], m.baseUrl, { SLACK_MCP_XOXP_TOKEN: "" });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("No sent messages match");
      expect(m.requests).toHaveLength(0);
    } finally {
      await m.stop();
    }
  });

  test("SLACK_TERM_ATTRIBUTION=off sends no metadata and logs nothing", async () => {
    const m = await startMock({ inline: fixtures });
    try {
      const off = { SLACK_TERM_ATTRIBUTION: "off" };
      expect((await confirmed(["send", "#chan", "hello", "--channel-id", CHAN], m.baseUrl, off)).exitCode).toBe(0);
      const post = m.requests.find((q) => q.method === "chat.postMessage")!;
      expect(JSON.parse(post.body).metadata).toBeUndefined();
      expect((await run(["sent", "--json"], m.baseUrl)).stdout.trim()).toBe("");
    } finally {
      await m.stop();
    }
  });
});

describe("parseSince", () => {
  const now = Date.UTC(2026, 8, 27, 12, 0, 0);
  test("durations", () => {
    expect(parseSince("30m", now)).toBe(now - 30 * 60e3);
    expect(parseSince("2h", now)).toBe(now - 2 * 3600e3);
    expect(parseSince("7d", now)).toBe(now - 7 * 86400e3);
  });
  test("an ISO date", () => {
    expect(parseSince("2026-09-01T00:00:00Z", now)).toBe(Date.UTC(2026, 8, 1));
  });
  test("garbage is undefined, not 'everything'", () => {
    expect(parseSince("yesterday-ish", now)).toBeUndefined();
  });
});
