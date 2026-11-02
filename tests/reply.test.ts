// CLI: `slack init` / `alias` / `reply` / `read <alias>` / `send --to`, against
// the mock server, from a directory holding its own .slack-term/.
import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle } from "./mock.ts";

const TS_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "ts", "cli.ts");
const ROOT_TS = "1700000000.000100";
const REPLY_TS = "1700000000.000200";
const OTHER_ROOT = "1700000000.000900";
const thread = (root: string) => ({
  ok: true,
  messages: [
    { type: "message", user: "U00000002", text: "the question", ts: root, thread_ts: root, reply_count: 1 },
    { type: "message", user: "U00000002", text: "a follow-up", ts: root === ROOT_TS ? REPLY_TS : "1700000000.000950", thread_ts: root },
  ],
});

const fixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  "conversations.history__channel=C00000001&limit=1": { ok: true, messages: [] },
  [`conversations.replies__channel=C00000001&limit=1&ts=${REPLY_TS}`]: thread(ROOT_TS),
  [`conversations.replies__channel=C00000001&limit=100&ts=${ROOT_TS}`]: thread(ROOT_TS),
  [`conversations.replies__channel=C00000001&limit=1&ts=${ROOT_TS}`]: thread(ROOT_TS),
  [`conversations.replies__channel=C00000001&limit=1&ts=${OTHER_ROOT}`]: thread(OTHER_ROOT),
  [`conversations.replies__channel=C00000001&limit=100&ts=${OTHER_ROOT}`]: thread(OTHER_ROOT),
  "conversations.replies__channel=C00000001&limit=1&ts=1700000000.000400": { ok: true, messages: [{ type: "message", user: "U00000001", text: "[design] plan\n⬜ 1. build\n⬜ 2. test", ts: "1700000000.000400" }] },
  "users.info__user=U00000002": { ok: true, user: { id: "U00000002", name: "bob", real_name: "Bob", profile: { display_name: "" } } },
  "conversations.info__channel=C00000001": { ok: true, channel: { id: "C00000001", name: "channel-01" } },
  "chat.getPermalink__channel=C00000001&message_ts=1700000000.000100": { ok: true, channel: "C00000001", permalink: "https://acme.slack.com/archives/C00000001/p1700000000000100" },
};

let mock: MockHandle;
let tmpHome: string;
let lane: string;
beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-reply-"));
  lane = join(tmpHome, "tree", "design");
  mkdirSync(lane, { recursive: true });
  mock = await startMock({ inline: fixtures });
});
afterAll(async () => {
  await mock.stop();
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };
function run(args: string[], cwd = lane): Promise<RunResult> {
  const { SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h, SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w, SLACK_TERM_HOME: _g, ...rest } = process.env as Record<string, string>;
  const env = { ...rest, HOME: tmpHome, SLACK_TERM_HOME: join(tmpHome, "global"), SLACK_API_BASE: `${mock.baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake" };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
const code = (stderr: string): string => {
  const m = stderr.match(/--code=([0-9a-f]{4})/);
  if (!m) throw new Error(`No --code in stderr:\n${stderr}`);
  return m[1]!;
};
const REPLY_LINK = `https://acme.slack.com/archives/C00000001/p${REPLY_TS.replace(".", "")}`;
const posts = (from: number) => mock.requests.slice(from).filter((q) => q.method === "chat.postMessage").map((q) => JSON.parse(q.body) as { channel: string; thread_ts?: string; text: string });

describe("slack init / alias / reply (CLI)", { timeout: 90_000 }, () => {
  test("init writes .slack-term/ with the prefix", async () => {
    const r = await run(["init", "--prefix", "[design]"]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(lane, ".slack-term", ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(lane, ".slack-term", "settings.yml"), "utf8")).toContain('prefix: "[design]"');
  });

  test("alias set on a reply's bare permalink names its thread root", async () => {
    const r = await run(["alias", "set", "board", REPLY_LINK]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`board → C00000001 ${ROOT_TS}`);
    expect(r.stdout).toContain("is a reply: named its thread root");
    const ls = await run(["alias", "ls"]);
    expect(ls.stdout).toBe(`board\tC00000001\t${ROOT_TS}\tsettings.local.yml\n`);
  });

  test("an alias is per directory: another tree does not see it", async () => {
    const other = join(tmpHome, "tree", "other");
    mkdirSync(other, { recursive: true });
    const r = await run(["alias", "ls"], other);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no aliases");
  });

  test("reply <alias>: gate first, then posts in the thread with ONE prefix", async () => {
    const dry = await run(["reply", "board", "[design] done"]);
    expect(dry.exitCode).toBe(1);
    expect(dry.stdout).toContain("THREAD REPLY");
    const before = mock.requests.length;
    const r = await run(["reply", "board", "[design] done", `--code=${code(dry.stderr)}`]);
    expect(r.exitCode).toBe(0);
    expect(posts(before)).toEqual([expect.objectContaining({ channel: "C00000001", thread_ts: ROOT_TS, text: "[design] done" })]);
  });

  test("reply --to <reply permalink>: replies in that message's thread", async () => {
    const dry = await run(["reply", "--to", REPLY_LINK, "on it"]);
    expect(dry.exitCode).toBe(1);
    const before = mock.requests.length;
    const r = await run(["reply", "--to", REPLY_LINK, "on it", `--code=${code(dry.stderr)}`]);
    expect(r.exitCode).toBe(0);
    expect(posts(before)).toEqual([expect.objectContaining({ thread_ts: ROOT_TS, text: "[design] on it" })]);
  });

  test("reply into another thread than the --to message is refused, nothing posted", async () => {
    const before = mock.requests.length;
    const r = await run(["reply", `C00000001:${OTHER_ROOT}`, "on it", "--to", REPLY_LINK]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(`is in C00000001 thread ${ROOT_TS}`);
    expect(r.stderr).toContain(`destination is C00000001 thread ${OTHER_ROOT}`);
    expect(posts(before)).toEqual([]);
  });

  test("send --to refuses the same mismatch", async () => {
    const r = await run(["send", `C00000001:${OTHER_ROOT}`, "on it", "--to", REPLY_LINK]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--any-thread");
  });

  test("--any-thread lets it through to the gate", async () => {
    const r = await run(["reply", `C00000001:${OTHER_ROOT}`, "on it", "--to", REPLY_LINK, "--any-thread"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--code=[0-9a-f]{4}/);
  });

  test("reply never posts top level", async () => {
    const r = await run(["reply", "#channel-01", "hello"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not a thread");
  });

  test("read <alias> reads the thread", async () => {
    const r = await run(["read", "board"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the question");
    expect(r.stdout).toContain("a follow-up");
  });

  test("alias unset", async () => {
    expect((await run(["alias", "unset", "board"])).exitCode).toBe(0);
    expect((await run(["alias", "unset", "board"])).exitCode).toBe(2);
  });
});

describe("inbox / outbox / restrict (CLI)", { timeout: 120_000 }, () => {
  const ib = (): string => join(tmpHome, "tree", "ib");
  test("setup: a lane dir with an alias and one inbox entry", async () => {
    mkdirSync(ib(), { recursive: true });
    expect((await run(["init", "--prefix", "[ib]"], ib())).exitCode).toBe(0);
    expect((await run(["alias", "set", "board", `C00000001:${ROOT_TS}`], ib())).exitCode).toBe(0);
    writeFileSync(join(ib(), ".slack-term", "inbox", `C00000001-${REPLY_TS}.yml`),
      `ts: "${REPLY_TS}"\nchannel: C00000001\nthread_ts: "${ROOT_TS}"\nuser: U00000002\nuser_name: bob\ntext: a follow-up\npermalink: ${REPLY_LINK}\nalias: board\nreceived_at: 2026-11-02T00:00:00Z\n`);
    const ls = await run(["inbox", "ls"], ib());
    expect(ls.stdout).toBe(`${REPLY_TS}\tbob\tboard\ta follow-up\n`);
  });

  test("alias who finds the lane dir for a thread", async () => {
    const r = await run(["alias", "who", "C00000001", ROOT_TS, "--json"], ib());
    expect(JSON.parse(r.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ dir: ib(), alias: "board" })]));
  });

  test("outbox: add, flush shows the batch behind a code, then sends, records sent/, archives the answered entry", async () => {
    expect((await run(["outbox", "add", "board", "fixed", "--in-reply-to", REPLY_TS], ib())).exitCode).toBe(0);
    const dry = await run(["outbox", "flush"], ib());
    expect(dry.exitCode).toBe(1);
    expect(dry.stdout).toContain(`→ C00000001 thread ${ROOT_TS}: [ib] fixed`);
    const before = mock.requests.length;
    const r = await run(["outbox", "flush", `--code=${code(dry.stderr)}`], ib());
    expect(r.exitCode).toBe(0);
    expect(posts(before)).toEqual([expect.objectContaining({ channel: "C00000001", thread_ts: ROOT_TS, text: "[ib] fixed" })]);
    expect(readdirSync(join(ib(), ".slack-term", "outbox"))).toEqual([]);
    expect(readdirSync(join(ib(), ".slack-term", "sent")).length).toBe(1);
    expect(readdirSync(join(ib(), ".slack-term", "archived"))).toEqual([`C00000001-${REPLY_TS}.yml`]);
  });

  test("done: a missing ref exits 2", async () => {
    expect((await run(["done", REPLY_TS], ib())).exitCode).toBe(2);
  });

  test("restricted: lane alias set refuses, --shared works, reply elsewhere refuses", async () => {
    writeFileSync(join(ib(), ".slack-term", "settings.yml"), `prefix: "[ib]"\nrestrict_to_subscriptions: true\nowner: ${ib()}\n`);
    const set = await run(["alias", "set", "x", `C00000001:${OTHER_ROOT}`], ib());
    expect(set.exitCode).toBe(2);
    expect(set.stderr).toContain("restricted");
    // settings.local.yml's board no longer counts
    const r = await run(["reply", `C00000001:${ROOT_TS}`, "hi"], ib());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("restrict_to_subscriptions");
    expect((await run(["alias", "set", "board", `C00000001:${ROOT_TS}`, "--shared"], ib())).exitCode).toBe(0);
    const ok = await run(["reply", `C00000001:${ROOT_TS}`, "hi"], ib());
    expect(ok.exitCode).toBe(1); // reached the --code gate
    expect(ok.stderr).toMatch(/--code=[0-9a-f]{4}/);
    // a lane cannot post as someone else, nor --shared from outside the owner dir
    const pre = await run(["reply", `C00000001:${ROOT_TS}`, "hi", "--prefix", "[shr]"], ib());
    expect(pre.exitCode).toBe(2);
    expect(pre.stderr).toContain("--prefix / --as-bot are refused");
    const other = join(tmpHome, "tree", "other");
    const sh = await run(["alias", "set", "y", `C00000001:${OTHER_ROOT}`, "--shared", "--dir", ib()], other);
    expect(sh.exitCode).toBe(2);
    expect(sh.stderr).toContain("owned by");
  });

  test("alias import: allowlist.tsv → each lane's settings.yml", async () => {
    const tsv = join(tmpHome, "allowlist.tsv");
    writeFileSync(tsv, `# comment\n${ROOT_TS}\tguide\n${OTHER_ROOT}\tguide\n1700000000.000999\tnobody\n`);
    const guide = join(tmpHome, "tree", "guide");
    const r = await run(["alias", "import", tsv, "--channel", "D00000001", "--lane-dir", `guide=${guide}`], tmpHome);
    expect(r.stdout).toContain("imported 2 subscription(s)");
    expect(r.stderr).toContain(`skipped 1 line(s) for lane "nobody"`);
    expect(existsSync(join(guide, ".slack-term", ".gitignore"))).toBe(true);
    expect(readFileSync(join(guide, ".slack-term", "settings.yml"), "utf8")).toContain(`t-${OTHER_ROOT}`);
  });
});

describe("tick / edit keep the lane (CLI)", { timeout: 90_000 }, () => {
  const LIST = "https://acme.slack.com/archives/C00000001/p1700000000000400";
  test("tick 2: gate shows the ticked text, then chat.update changes only that item", async () => {
    const dry = await run(["tick", LIST, "2"]);
    expect(dry.exitCode).toBe(1);
    expect(dry.stdout).toContain("✅ 2. test");
    const before = mock.requests.length;
    const r = await run(["tick", LIST, "2", `--code=${code(dry.stderr)}`]);
    expect(r.exitCode).toBe(0);
    const upd = mock.requests.slice(before).find((q) => q.method === "chat.update")!;
    expect((JSON.parse(upd.body) as { text: string }).text).toBe("[design] plan\n⬜ 1. build\n✅ 2. test");
  });
  test("tick without n and two open items: exit 2, names them", async () => {
    const r = await run(["tick", LIST]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("several open items (1, 2)");
  });
  test("edit in a [design] scope keeps the tag", async () => {
    const dry = await run(["edit", LIST, "rewritten"]);
    expect(dry.exitCode).toBe(1);
    expect(dry.stdout).toContain("  [design] rewritten");
  });
});
