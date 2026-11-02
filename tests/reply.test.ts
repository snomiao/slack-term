// CLI: `slack init` / `alias` / `reply` / `read <alias>` / `send --to`, against
// the mock server, from a directory holding its own .slack-term/.
import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  [`conversations.replies__channel=C00000001&limit=200&ts=${ROOT_TS}`]: {
    ok: true,
    messages: [
      { type: "message", user: "U00000002", text: "the question", ts: ROOT_TS, thread_ts: ROOT_TS },
      { type: "message", user: "U00000002", text: "line1\nline2\twith tab \\ slash", ts: REPLY_TS, thread_ts: ROOT_TS, files: [{ id: "F00000001" }] },
      { type: "message", bot_id: "B00000001", text: "bot reply", ts: "1700000000.000300", thread_ts: ROOT_TS },
    ],
    response_metadata: { next_cursor: "" },
  },
  "reactions.add": { ok: true },
  "users.info__user=U00000002": { ok: true, user: { id: "U00000002", name: "bob", real_name: "Bob", profile: { display_name: "" } } },
  "conversations.info__channel=C00000001": { ok: true, channel: { id: "C00000001", name: "channel-01" } },
  "chat.getPermalink__channel=C00000001&message_ts=1700000000.000100": { ok: true, channel: "C00000001", permalink: "https://acme.slack.com/archives/C00000001/p1700000000000100" },
};

let mock: MockHandle;
let tmpHome: string;
let lane: string;
beforeAll(async () => {
  // realpath: macOS tmpdir() is /var/…, a symlink to /private/var/…, and scope dirs are reported resolved.
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "slack-reply-")));
  lane = join(tmpHome, "tree", "design");
  mkdirSync(lane, { recursive: true });
  mock = await startMock({ inline: fixtures, rememberEdits: true });
});
afterAll(async () => {
  await mock.stop();
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };
function run(args: string[], cwd = lane, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const { SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h, SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w, SLACK_TERM_HOME: _g, ...rest } = process.env as Record<string, string>;
  const env = { ...rest, HOME: tmpHome, SLACK_TERM_HOME: join(tmpHome, "global"), SLACK_API_BASE: `${mock.baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake", ...extraEnv };
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

  test("outbox flush: a URL glued to the text before it is refused and stays queued", async () => {
    expect((await run(["outbox", "add", "board", "見てhttps://example.com/x"], ib())).exitCode).toBe(0);
    const before = mock.requests.length;
    const r = await run(["outbox", "flush"], ib());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("refused (stays queued)");
    expect(r.stderr).toContain("Ambiguous URL boundary");
    expect(posts(before)).toEqual([]);
    expect(readdirSync(join(ib(), ".slack-term", "outbox")).length).toBe(1);
    for (const f of readdirSync(join(ib(), ".slack-term", "outbox"))) rmSync(join(ib(), ".slack-term", "outbox", f));
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
  test("tick without n and two open items: exit 2, names them (before any tick lands)", async () => {
    const r = await run(["tick", LIST]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("several open items (1, 2)");
  });
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
  test("edit in a [design] scope keeps the tag", async () => {
    const dry = await run(["edit", LIST, "rewritten"]);
    expect(dry.exitCode).toBe(1);
    expect(dry.stdout).toContain("  [design] rewritten");
  });
});

describe("choice-question hint (CLI)", { timeout: 60_000 }, () => {
  test("reply with (yes/no)? prints the hint on stderr, still reaches the gate", async () => {
    const r = await run(["reply", `C00000001:${ROOT_TS}`, "ship it now (yes/no)?"], join(tmpHome, "tree", "other"));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("hint: this looks like a choice question");
    expect(r.stderr).toMatch(/--code=[0-9a-f]{4}/);
  });
  test("a plain question gets no hint", async () => {
    const r = await run(["reply", `C00000001:${ROOT_TS}`, "can you check the build?"], join(tmpHome, "tree", "other"));
    expect(r.stderr).not.toContain("hint:");
  });
});

describe("thread --since --format tsv, inbox listen filters (CLI)", { timeout: 90_000 }, () => {
  test("tsv: one escaped line per message, files counted, bots by id", async () => {
    const r = await run(["thread", "C00000001", ROOT_TS, "--format", "tsv"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      `${ROOT_TS}\tU00000002\tthe question`,
      `${REPLY_TS}\tU00000002\tline1\\nline2\\twith tab \\\\ slash [files: 1]`,
      "1700000000.000300\tB00000001\tbot reply",
    ]);
  });
  test("--since drops what is not newer", async () => {
    const r = await run(["thread", "C00000001", ROOT_TS, "--format", "tsv", "--since", REPLY_TS]);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["1700000000.000300\tB00000001\tbot reply"]);
  });
  test("--since takes the ISO stamp `read` prints, and refuses what is no ts", async () => {
    const iso = await run(["thread", "C00000001", ROOT_TS, "--format", "tsv", "--since", "2023-11-14T22:13:20.000200"]);
    expect(iso.stdout.split("\n").filter(Boolean)).toEqual(["1700000000.000300\tB00000001\tbot reply"]);
    const bad = await run(["thread", "C00000001", ROOT_TS, "--format", "tsv", "--since", "yesterday"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("--since needs a message ts");
    expect(bad.stdout).toBe("");
  });
  test("inbox listen --thread / --from / --alias", async () => {
    const d = join(tmpHome, "tree", "listen");
    mkdirSync(d, { recursive: true });
    await run(["init"], d);
    const put = (ts: string, thread: string, user: string, alias: string) => writeFileSync(join(d, ".slack-term", "inbox", `C00000001-${ts}.yml`),
      `ts: "${ts}"\nchannel: C00000001\nthread_ts: "${thread}"\nuser: ${user}\ntext: hi\npermalink: x\nalias: ${alias}\nreceived_at: 2026-11-02T00:00:00Z\n`);
    put("1700000000.000201", ROOT_TS, "U00000002", "a");
    put("1700000000.000202", ROOT_TS, "U00000003", "a");
    put("1700000000.000203", OTHER_ROOT, "U00000002", "b");
    const ts = (o: string) => o.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { ts: string }).ts);
    expect(ts((await run(["inbox", "listen", "--timeout", "0", "--thread", ROOT_TS], d)).stdout)).toEqual(["1700000000.000201", "1700000000.000202"]);
    expect(ts((await run(["inbox", "listen", "--timeout", "0", "--thread", ROOT_TS, "--from", "U00000002"], d)).stdout)).toEqual(["1700000000.000201"]);
    expect(ts((await run(["inbox", "listen", "--timeout", "0", "--alias", "b"], d)).stdout)).toEqual(["1700000000.000203"]);
  });
});

describe("slack @<who>, and the agent trap (CLI)", { timeout: 90_000 }, () => {
  const fakeBot = ["xox", "b-", "0000000000-0000000000000-", "faketokenfaketokenfake00"].join("");
  const idDir = (): string => join(tmpHome, "tree", "ident");
  test("setup", async () => {
    mkdirSync(idDir(), { recursive: true });
    await run(["init"], idDir());
    writeFileSync(join(tmpHome, "sybot.env"), `SLACK_BOT_TOKEN=${fakeBot}\n`);
    writeFileSync(join(idDir(), ".slack-term", "settings.yml"), `identities:\n  sybot:\n    kind: bot\n    env_file: ${join(tmpHome, "sybot.env")}\n`);
  });
  test("inside an agent, send without who/--as-bot/--as-user is refused (nothing sent)", async () => {
    const before = mock.requests.length;
    const r = await run(["send", `C00000001:${ROOT_TS}`, "hi"], idDir(), { AY_AGENT_ID: "x" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("refusing to post as the user session from inside an agent (AY_AGENT_ID is set)");
    expect(r.stderr).toContain("slack @sybot send");
    expect(mock.requests.slice(before).filter((q) => q.method.startsWith("chat."))).toEqual([]);
  });
  test("--as-user lets it through to the gate", async () => {
    const r = await run(["send", `C00000001:${ROOT_TS}`, "hi", "--as-user"], idDir(), { AY_AGENT_ID: "x" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--code=[0-9a-f]{4}/);
  });
  test("slack @sybot send: acts with the bot's token (as --as-bot)", async () => {
    const before = mock.requests.length;
    const r = await run(["@sybot", "send", `C00000001:${ROOT_TS}`, "hi"], idDir(), { AY_AGENT_ID: "x" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--code=[0-9a-f]{4}/);
    const auths = mock.requests.slice(before).map((q) => String(q.headers.authorization ?? ""));
    expect(auths.some((a) => a === `Bearer ${fakeBot}`)).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(fakeBot);
  });
  test("an unknown @who lists the known ones", async () => {
    const r = await run(["@nobody", "send", "x", "y"], idDir());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown identity @nobody. Known: @sybot");
  });
  test("two identities, no @who, outside an agent: refused, listing them", async () => {
    writeFileSync(join(idDir(), ".slack-term", "settings.yml"), `identities:\n  sybot:\n    kind: bot\n    env_file: ${join(tmpHome, "sybot.env")}\n  alice:\n    kind: user\n    profile: acme\n`);
    const r = await run(["send", `C00000001:${ROOT_TS}`, "hi"], idDir());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("several identities are configured (@alice | @sybot)");
  });
});

describe("inbox nudge --eyes (CLI)", { timeout: 60_000 }, () => {
  test("puts 👀 on an overdue message once, records it, still exits 1", async () => {
    const d = join(tmpHome, "tree", "nudge");
    mkdirSync(d, { recursive: true });
    await run(["init"], d);
    writeFileSync(join(d, ".slack-term", "settings.yml"), "nudge_after_min: 1\n");
    const f = join(d, ".slack-term", "inbox", `C00000001-${REPLY_TS}.yml`);
    writeFileSync(f, `ts: "${REPLY_TS}"\nchannel: C00000001\nuser: U00000002\ntext: hi\npermalink: x\nalias: a\nreceived_at: 2026-11-02T00:00:00Z\n`);
    const { utimesSync } = await import("node:fs");
    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(f, old, old);
    const before = mock.requests.length;
    const r = await run(["inbox", "nudge", "--eyes"], d);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("\t👀");
    const adds = mock.requests.slice(before).filter((q) => q.method === "reactions.add");
    expect(adds).toHaveLength(1);
    expect(readFileSync(f, "utf8")).toContain("nudged_at:");
    const again = mock.requests.length;
    await run(["inbox", "nudge", "--eyes"], d);
    expect(mock.requests.slice(again).filter((q) => q.method === "reactions.add")).toHaveLength(0);
  });
  test("without --eyes nothing is written to Slack", async () => {
    const before = mock.requests.length;
    await run(["inbox", "nudge"], join(tmpHome, "tree", "nudge"));
    expect(mock.requests.slice(before).filter((q) => q.method.startsWith("reactions."))).toEqual([]);
  });
});
