// CLI integration tests for `slack ask` — the confirm gate, the seeded
// reactions, and the three ways `--wait` can end (reaction answer, text answer,
// timeout). Everything runs against the mock Slack server; per the project's
// QA rule, `ask` is a write command and must never be pointed at real Slack.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";
import { askBuildText, askBuildResolvedText, askBuildVoidText, askParseMessage } from "../ts/ask.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");

const QTS = "1700000000.000100"; // ts the mock's chat.postMessage always returns
const SELF = "U00000001";
const BOB = "U00000BOB";
const ALICE = "U0000ALIC";
const CHAN = "C00000001";
const DM = "D00000BOB";

let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-ask-"));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(args: string[], baseUrl: string): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w,
    ...rest
  } = process.env as Record<string, string>;
  const env = {
    ...rest,
    HOME: tmpHome,
    SLACK_API_BASE: `${baseUrl}/api`,
    SLACK_MCP_XOXP_TOKEN: "xoxp-fake",
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", TS_ENTRY, ...args], { cwd: tmpHome, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    child.on("close", (exitCode: number | null) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

function extractCode(stderr: string): string {
  const m = stderr.match(/--code=([0-9a-f]{4})/);
  if (!m) throw new Error(`No --code found in stderr:\n${stderr}`);
  return m[1]!;
}

const AUTH = {
  "auth.test": { ok: true, user_id: SELF, user: "user1", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },
  // The @tags in the question decide who may answer, so every channel ask has
  // to resolve them against the directory.
  "users.list__limit=200": {
    ok: true,
    members: [
      { id: SELF, name: "user1", real_name: "User One" },
      { id: BOB, name: "bob", real_name: "Bob" },
      { id: ALICE, name: "alice", real_name: "Alice" },
    ],
  },
};

/** The question message as `conversations.history` returns it while polling. */
function questionMsg(extra: Record<string, unknown> = {}) {
  return { type: "message", user: SELF, ts: QTS, text: "*質問*", ...extra };
}

/** Poll response for the `--wait` loop. The gate's own preview fetch uses
 *  limit=1, so keying this at limit=30 keeps the two apart.
 *
 *  `inclusive=true` is part of the key on purpose: Slack's `oldest` is
 *  exclusive, so without it the real API would omit the question message — and
 *  with it every reaction/thread answer path goes dead. The mock replays
 *  fixtures verbatim and cannot model that, so pinning the key here is what
 *  makes the test notice if the flag is ever dropped. */
function pollFixture(channel: string, messages: unknown[]): InlineFixtures {
  return {
    [`conversations.history__channel=${channel}&inclusive=true&limit=30&oldest=${QTS}`]: { ok: true, messages },
    [`conversations.history__channel=${channel}&limit=1`]: { ok: true, messages: [] },
  };
}

describe("ask confirm gate (CLI)", { timeout: 60_000 }, () => {
  test("gate names the asking identity, the destination and every choice", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const r = await run(["ask", "#chan", "@bob deploy してよい?", "はい", "まって", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("  From: @user1 (U00000001) — Acme");
      expect(r.stdout).toContain(`  Question: <@${BOB}> deploy してよい?`);
      expect(r.stdout).toContain(`  Answerable by: @Bob (${BOB})`);
      expect(r.stdout).toContain("1️⃣ はい");
      expect(r.stdout).toContain("2️⃣ まって");
      // Nothing may be posted before the code is supplied.
      expect(m.requests.some((q) => q.method === "chat.postMessage")).toBe(false);
    } finally {
      await m.stop();
    }
  });

  test("choices beyond the tenth are flagged as text-answer-only", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const choices = Array.from({ length: 11 }, (_, i) => `c${i + 1}`);
      const r = await run(["ask", "#chan", "@bob どれ?", ...choices, "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("🔟 c10");
      expect(r.stdout).toContain("(11) c11 — text answer only");
    } finally {
      await m.stop();
    }
  });

  test("changing a choice invalidates a code minted for the old wording", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const dry = await run(["ask", "#chan", "@bob q", "はい", "いいえ", "--channel-id", CHAN], m.baseUrl);
      const code = extractCode(dry.stderr);
      // Same question, one choice reworded — the hash covers the posted body,
      // so the old code must not confirm it.
      const r = await run(["ask", "#chan", "@bob q", "はい", "だめ", "--channel-id", CHAN, `--code=${code}`], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Code mismatch");
    } finally {
      await m.stop();
    }
  });
});

// The audience is what makes an answer binding. Posting an unaddressed question
// into a busy channel means the first person to react has decided something that
// was never theirs to decide — so `ask` refuses to post one at all.
describe("ask requires an addressee (CLI)", { timeout: 60_000 }, () => {
  test("an untagged channel question is refused before anything is posted", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const r = await run(["ask", "#chan", "やっていい?", "はい", "いいえ", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("no one is tagged");
      expect(m.requests.some((q) => q.method === "chat.postMessage")).toBe(false);
      expect(m.requests.some((q) => q.method === "reactions.add")).toBe(false);
    } finally {
      await m.stop();
    }
  });

  test("a tag that matches nobody grants nobody — still refused, and says why", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const r = await run(["ask", "#chan", "@nobody やっていい?", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("matched no one");
      expect(m.requests.some((q) => q.method === "chat.postMessage")).toBe(false);
    } finally {
      await m.stop();
    }
  });

  test("tagging only yourself grants nothing — your reactions are the seeds", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const r = await run(["ask", "#chan", "@user1 やっていい?", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("no one is tagged");
    } finally {
      await m.stop();
    }
  });

  test("a 1:1 DM needs no tag — the other party is the only possible answerer", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "@bob", "やっていい?", "はい", "いいえ", "--channel-id", DM], m.baseUrl);
      expect(r.exitCode).toBe(1); // reached the gate, i.e. not refused
      expect(r.stdout).toContain(`  Answerable by: @bob (${BOB})`);
    } finally {
      await m.stop();
    }
  });

  test("the copy follows the answerer's Slack locale, and the gate says why", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      "users.info__include_locale=true&user=U00000BOB": { ok: true, user: { id: BOB, locale: "en-US" } },
    };
    const m = await startMock({ inline });
    try {
      // Written in Japanese, but bob reads Slack in English — bob is the one
      // who has to follow the instructions.
      const base = ["ask", "@bob", "やっていい?", "はい", "いいえ", "--channel-id", DM];
      const dry = await run(base, m.baseUrl);
      expect(dry.stdout).toContain("Language: en (answerers' Slack locale; override with --lang)");
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const post = m.requests.slice(before).find((q) => q.method === "chat.postMessage")!;
      const posted = JSON.parse(post.body).text as string;
      expect(posted).toContain(":question: Other — reply to this message");
      expect(posted).toContain("_Press one of the reactions below to answer.");

      // --lang overrides it.
      const ja = await run([...base, "--lang", "ja"], m.baseUrl);
      expect(ja.stdout).toContain("Language: ja (--lang; override with --lang)");
    } finally {
      await m.stop();
    }
  });

  test("@here opens it to the channel and posts a real broadcast tag", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", "#chan", "@here 誰か見れる?", "見る", "あとで", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).toContain("Answerable by: anyone in #chan (@here)");
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const posted = JSON.parse(m.requests.slice(before).find((q) => q.method === "chat.postMessage")!.body).text as string;
      // <!here> is what Slack actually broadcasts on; "@here" as plain text
      // would look like a ping and notify no one.
      expect(posted).toContain("<!here> 誰か見れる?");
    } finally {
      await m.stop();
    }
  });
});

// A permalink names WHERE to ask, never WHAT to reply to. `send` treats a pasted
// permalink as "reply to that message", and `ask` inheriting that turned every
// question given a permalink target into a thread reply — buried under an
// unrelated message, where the people it was addressed to never saw it.
// (Reported against a real workspace 2026-08-20.)
describe("ask(permalink) posts top-level, never a thread reply", () => {
  const LINK = `http://example.slack.com/archives/${CHAN}/p1700000000000100`;

  test("a permalink target resolves the channel and drops its thread", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", LINK, "@alice これは新規の質問", "はい", "いいえ", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      // The gate is where a human would have caught this, so it is asserted too.
      expect(dry.stdout).toContain("NEW top-level message");
      expect(dry.stdout).not.toContain("THREAD REPLY");
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const body = JSON.parse(m.requests.slice(before).find((q) => q.method === "chat.postMessage")!.body);
      // The actual bug: thread_ts inherited from the pasted link.
      expect(body.thread_ts).toBeUndefined();
    } finally {
      await m.stop();
    }
  });

  test("the explicit #chan:<ts> form still threads — saying so is the opt-in", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", `#chan:${QTS}`, "@alice スレッドで聞く", "はい", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      expect(dry.stdout).toContain("THREAD REPLY");
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const body = JSON.parse(m.requests.slice(before).find((q) => q.method === "chat.postMessage")!.body);
      expect(body.thread_ts).toBe(QTS);
    } finally {
      await m.stop();
    }
  });
});

// Escapes must be interpreted BEFORE the body is built, because `askBuildText`
// flattens a choice's newlines to spaces — a newline in a pill would split it
// into a line the parser cannot read back. Unescaping afterwards would be a
// no-op that silently did nothing, so the ordering is the whole feature here.
describe("ask interprets escapes, and the gate previews what will post", () => {
  test("a question keeps its line break; a choice is flattened, and previewed flattened", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", "#chan", "@bob 質問\\n2行目", "はい\\nyes", "いいえ", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      // The pill posts as one line, so the gate must show one line — otherwise
      // the preview describes something that never gets sent.
      expect(dry.stdout).toContain("1️⃣ はい yes");
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const posted = JSON.parse(m.requests.slice(before).find((q) => q.method === "chat.postMessage")!.body).text as string;
      expect(posted).toContain("質問\n2行目");   // question keeps the break
      // The POSTED body uses the shortcode — that is the form Slack stores, so
      // writing it keeps sent and read-back bytes identical. The terminal gate
      // above still shows the glyph, which is right: it is for a human to read.
      expect(posted).toContain(":one: はい yes"); // choice flattened to one line
      expect(posted).not.toContain("\\n");        // no literal backslash-n survives
    } finally {
      await m.stop();
    }
  });

  test("the yen spelling works the same", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", "#chan", "@bob 質問\u00A5n2行目", "はい", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const posted = JSON.parse(m.requests.slice(before).find((q) => q.method === "chat.postMessage")!.body).text as string;
      expect(posted).toContain("質問\n2行目");
    } finally {
      await m.stop();
    }
  });
});

describe("ask restricts answers to the people tagged (CLI)", { timeout: 90_000 }, () => {
  const inline = (messages: unknown[]): InlineFixtures => ({
    ...AUTH,
    "users.info__user=U0000ALIC": { ok: true, user: { id: ALICE, name: "alice", profile: { display_name: "alice" } } },
    ...pollFixture(CHAN, messages),
  });

  test("a bystander's reaction is ignored; the tagged person's answers", async () => {
    // Bob is not tagged and pressed 1️⃣ first; only Alice's 2️⃣ counts.
    const m = await startMock({
      inline: inline([questionMsg({
        reactions: [
          { name: "one", users: [SELF, BOB], count: 2 },
          { name: "two", users: [SELF, ALICE], count: 2 },
        ],
      })]),
    });
    try {
      const base = ["ask", "#chan", "@alice どっち?", "A", "B", "--channel-id", CHAN, "--wait", "--timeout", "20"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      // Both pills carry a human, but only one carries an ADDRESSEE — so this is
      // an answer, not the ambiguous two-answer case.
      expect(r.stdout.trim()).toBe("B");
    } finally {
      await m.stop();
    }
  });

  test("a bystander alone is no answer at all", async () => {
    const m = await startMock({
      inline: inline([questionMsg({ reactions: [{ name: "one", users: [SELF, BOB], count: 2 }] })]),
    });
    try {
      const base = ["ask", "#chan", "@alice どっち?", "A", "B", "--channel-id", CHAN, "--wait", "--timeout", "2"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim()).toBe("");
    } finally {
      await m.stop();
    }
  });

  test("@here lets a bystander answer — that is what it was asked for", async () => {
    const m = await startMock({
      inline: {
        ...AUTH,
        "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
        ...pollFixture(CHAN, [questionMsg({ reactions: [{ name: "one", users: [SELF, BOB], count: 2 }] })]),
      },
    });
    try {
      const base = ["ask", "#chan", "@here どっち?", "A", "B", "--channel-id", CHAN, "--wait", "--timeout", "20"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("A");
    } finally {
      await m.stop();
    }
  });
});

describe("ask seeds reactions in order (CLI)", { timeout: 60_000 }, () => {
  test("confirmed ask posts once, then adds 1..3 sequentially in that order", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", "#chan", "@bob どれ?", "A", "B", "C", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      // Without --wait, stdout carries the permalink so a caller can pass it on.
      expect(r.stderr).toContain("✓ Asked:");

      const reqs = m.requests.slice(before);
      const post = reqs.findIndex((q) => q.method === "chat.postMessage");
      expect(post).toBeGreaterThanOrEqual(0);
      const seeds = reqs.filter((q) => q.method === "reactions.add").map((q) => JSON.parse(q.body).name);
      // Order is the whole point: Slack renders pills in add order, so a
      // parallel/out-of-order seed would show the choices shuffled.
      // The marker goes LAST: it doubles as the "other" choice the body lists
      // under the numbered ones, so the pill row reads 1 2 3 ❓ like the body.
      expect(seeds).toEqual(["one", "two", "three", "question"]);
      const posted = JSON.parse(reqs[post]!.body).text as string;
      expect(posted).toMatch(/:three: [^\n]*\n:question: その他/);
      // And every seed must come after the message it is attached to.
      expect(reqs.findIndex((q) => q.method === "reactions.add")).toBeGreaterThan(post);
    } finally {
      await m.stop();
    }
  });

  test("no choices means no PILLS — the marker is still seeded, and the body asks for a reply", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", "#chan", "@bob どう思う?", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const reqs = m.requests.slice(before);
      // A free-text question has no ballot, but it is still an `ask` — the
      // marker is what says so, so it is seeded regardless.
      const seeds = reqs.filter((q) => q.method === "reactions.add").map((q) => JSON.parse(q.body).name);
      expect(seeds).toEqual(["question"]);
      const posted = JSON.parse(reqs.find((q) => q.method === "chat.postMessage")!.body).text as string;
      expect(posted).toContain("返信してください");
      // Identity is the marker, not the Japanese copy: the body leads with it.
      expect(posted.startsWith(":question: ")).toBe(true);
    } finally {
      await m.stop();
    }
  });
});

describe("ask --wait (CLI)", { timeout: 90_000 }, () => {
  test("a reaction from someone else answers, and stdout carries only the choice", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...pollFixture(DM, [questionMsg({ reactions: [{ name: "two", users: [SELF, BOB], count: 2 }] })]),
    };
    const m = await startMock({ inline });
    try {
      const base = ["ask", "@bob", "どっち?", "A", "B", "--channel-id", DM, "--wait", "--timeout", "20"];
      const dry = await run(base, m.baseUrl);
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      // stdout is the contract for ANS=$(slack ask --wait ...): the answer alone.
      expect(r.stdout.trim()).toBe("B");

      const reqs = m.requests.slice(before);
      // The question is stamped resolved and our own seeds are cleared, so the
      // pressed pill is the only one left standing.
      const update = reqs.find((q) => q.method === "chat.update");
      expect(update).toBeDefined();
      expect(JSON.parse(update!.body).text).toContain("回答済み");
      expect(JSON.parse(update!.body).text).toContain("> B");
      expect(reqs.filter((q) => q.method === "reactions.remove").map((q) => JSON.parse(q.body).name))
        .toEqual(["one", "two"]);
    } finally {
      await m.stop();
    }
  });

  test("our own seed alone is never mistaken for an answer", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      // Only the asker is on the pill — exactly what seeding leaves behind.
      ...pollFixture(DM, [questionMsg({ reactions: [{ name: "one", users: [SELF], count: 1 }] })]),
    };
    const m = await startMock({ inline });
    try {
      const base = ["ask", "@bob", "どっち?", "A", "B", "--channel-id", DM, "--wait", "--timeout", "2"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim()).toBe("");
    } finally {
      await m.stop();
    }
  });

  test("❓ (other) alone is not an answer — it says a reply is coming, and keeps waiting", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      ...pollFixture(DM, [questionMsg({ reactions: [
        { name: "one", users: [SELF], count: 1 },
        { name: "question", users: [SELF, BOB], count: 2 },
      ] })]),
    };
    const m = await startMock({ inline });
    try {
      const base = ["ask", "@bob", "どっち?", "A", "B", "--channel-id", DM, "--wait", "--timeout", "2"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim()).toBe("");
      // Once, not once per poll tick.
      expect(r.stderr.split("❓ その他 を押しました").length - 1).toBe(1);
    } finally {
      await m.stop();
    }
  });

  test("in a DM a plain reply is the answer", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...pollFixture(DM, [
        questionMsg(),
        { type: "message", user: BOB, ts: "1700000001.000100", text: "やっていいよ" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const base = ["ask", "@bob", "やっていい?", "--channel-id", DM, "--wait", "--timeout", "20"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("やっていいよ");
    } finally {
      await m.stop();
    }
  });

  test("a reply written after a NEWER question belongs to that one, not to us", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      ...pollFixture(DM, [
        questionMsg(),
        // A later question from us, then the reply. The reply answers the newer
        // question; this older waiter must not claim it.
        { type: "message", user: SELF, ts: "1700000002.000100", text: "*別の質問*" },
        { type: "message", user: BOB, ts: "1700000003.000100", text: "こっちの答え" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const base = ["ask", "@bob", "やっていい?", "--channel-id", DM, "--wait", "--timeout", "2"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim()).toBe("");
    } finally {
      await m.stop();
    }
  });

  test("in a channel a plain post is not an answer — only reactions and thread replies are", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      ...pollFixture(CHAN, [
        questionMsg(),
        { type: "message", user: BOB, ts: "1700000001.000100", text: "無関係な雑談" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const base = ["ask", "#chan", "@bob やっていい?", "--channel-id", CHAN, "--wait", "--timeout", "2"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim()).toBe("");
      expect(r.stderr).toContain("以内に回答がありませんでした");
      // The permalink alone would leave the caller where `ask` used to: holding
      // a link with nothing that reads a pressed pill back.
      expect(r.stderr).toContain(`slack ask --waitFor='${CHAN}:${QTS}'`);
    } finally {
      await m.stop();
    }
  });

  test("a thread reply answers a channel question", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...pollFixture(CHAN, [questionMsg({ reply_count: 1 })]),
      [`conversations.replies__channel=${CHAN}&limit=30&ts=${QTS}`]: {
        ok: true,
        messages: [
          questionMsg({ reply_count: 1 }),
          { type: "message", user: BOB, ts: "1700000001.000100", thread_ts: QTS, text: "いいよ" },
        ],
      },
    };
    const m = await startMock({ inline });
    try {
      const base = ["ask", "#chan", "@bob やっていい?", "--channel-id", CHAN, "--wait", "--timeout", "20"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("いいよ");
    } finally {
      await m.stop();
    }
  });

  test("two pressed pills stay unresolved rather than guessing a side", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      ...pollFixture(DM, [questionMsg({
        reactions: [
          { name: "one", users: [SELF, BOB], count: 2 },
          { name: "two", users: [SELF, BOB], count: 2 },
        ],
      })]),
    };
    const m = await startMock({ inline });
    try {
      const base = ["ask", "@bob", "どっち?", "A", "B", "--channel-id", DM, "--wait", "--timeout", "2"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim()).toBe("");
      expect(r.stderr).toContain("同時に選ばれています");
    } finally {
      await m.stop();
    }
  });
});

describe("ask self-DM warning (CLI)", { timeout: 60_000 }, () => {
  test("warns when the question would go to your own DM", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      "conversations.info__channel=D00000001": { ok: true, channel: { id: "D00000001", is_im: true, user: SELF, name: "" } },
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "@me", "やっていい?", "--channel-id", "D00000001"], m.baseUrl);
      expect(r.stderr).toContain("DM to yourself");
    } finally {
      await m.stop();
    }
  });
});

// Collecting an answer to a question posted WITHOUT --wait. Nothing about the
// question is stored locally, so every field the poller needs is recovered by
// parsing the message back out of Slack — including "is this even a question".
describe("ask --waitFor (CLI)", { timeout: 90_000 }, () => {
  const QUESTION = askBuildText(`<@${BOB}> どっち?`, "", ["A", "B"], [], false);

  /** The single-message fetch `--waitFor` opens with (limit=1), plus the poll. */
  function waitForFixture(channel: string, messages: unknown[]): InlineFixtures {
    return {
      [`conversations.history__channel=${channel}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages },
      ...pollFixture(channel, messages),
    };
  }

  test("a question posted without --wait prints the command that collects it", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", "#chan", `@bob deploy してよい?`, "はい", "まって", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      // A bare permalink would leave the caller with no idea how to collect —
      // and nothing else in the CLI can read a pressed reaction back.
      expect(r.stdout.trim()).toBe(`slack ask --waitFor='${CHAN}:${QTS}'`);
    } finally {
      await m.stop();
    }
  });

  test("collects a pill pressed while nobody was waiting", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [{
        type: "message", user: SELF, ts: QTS, text: QUESTION,
        reactions: [{ name: "two", users: [SELF, BOB], count: 2 }],
      }]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "20"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("B");
      // No confirm gate and nothing new posted: --waitFor only reads and stamps.
      expect(m.requests.some((q) => q.method === "chat.postMessage")).toBe(false);
      expect(m.requests.some((q) => q.method === "chat.update")).toBe(true);
    } finally {
      await m.stop();
    }
  });

  test("collecting keeps the background and the chosen option, and drops the rest", async () => {
    const withBody = askBuildText(`<@${BOB}> どっち?`, "背景: リリース前\n推奨: B", ["A", "B"], [], false);
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [{
        type: "message", user: SELF, ts: QTS, text: withBody,
        reactions: [{ name: "two", users: [SELF, BOB], count: 2 }],
      }]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("B");
      const upd = m.requests.find((q) => q.method === "chat.update")!;
      const text = (upd.body.startsWith("{") ? JSON.parse(upd.body).text : new URLSearchParams(upd.body).get("text")) as string;
      expect(text.startsWith(":white_check_mark: ")).toBe(true);
      expect(text).toContain("背景: リリース前\n推奨: B");
      expect(text).toContain(":two: B");
      expect(text).not.toContain(":one: A");
      expect(text).not.toContain("その他");
      // And it reads back as the same answer.
      expect(askParseMessage(text)).toEqual({ kind: "resolved", question: `<@${BOB}> どっち?`, answer: "B" });
    } finally {
      await m.stop();
    }
  });

  test("a question already stamped answered reports that answer without waiting", async () => {
    const resolved = askBuildResolvedText(`<@${BOB}> どっち?`, { answer: "B", how: "リアクション 2️⃣", who: BOB }, "Bob");
    const inline: InlineFixtures = {
      ...AUTH,
      ...waitForFixture(DM, [{ type: "message", user: SELF, ts: QTS, text: resolved }]),
    };
    const m = await startMock({ inline });
    try {
      // A long timeout would hang here if the ✅ state were not recognised —
      // this is the property that makes fire-and-forget usable at all.
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "3600"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("B");
    } finally {
      await m.stop();
    }
  });

  test("a collected question can be re-read: the answer comes back from Slack's &gt;-escaped body", async () => {
    // What `chat.update` stores and `conversations.history` returns: the quote
    // marker arrives as `&gt; `. Re-reading a collected ask used to exit 3.
    const resolved = askBuildResolvedText(`<@${BOB}> どっち?`, { answer: "B & C", how: "リアクション 2️⃣", who: BOB }, "Bob")
      .replace(/^> (.*)$/gm, (_l, a: string) => `&gt; ${a.replace(/&/g, "&amp;")}`);
    const inline: InlineFixtures = {
      ...AUTH,
      ...waitForFixture(DM, [{ type: "message", user: SELF, ts: QTS, text: resolved }]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.stderr).not.toContain("引用された回答本文が見つかりません");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("B & C");
    } finally {
      await m.stop();
    }
  });

  // THE LIVE CASE, 2026-09-04. Three options were offered; the answerer replied
  // 「没懂，能给我讲前因后果吗」— a question BACK — and this exited 0 with that
  // stored as the decision. A lane harvesting rc=0 unparks the work and proceeds
  // with nothing behind it, and the recorded answer reads as though he chose.
  //
  // 2026-09-27: exiting 4 with stdout EMPTY had the opposite failure — the
  // instruction the human typed never reached the agent, which kept waiting.
  // So the reply is now DELIVERED, under its own exit code (5): still never 0,
  // so nothing mistakes it for a decision, but the text is on stdout.
  test("a reply that picks none of the choices is delivered as free text (exit 5), not as a decision", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [
        { type: "message", user: SELF, ts: QTS, text: QUESTION },
        { type: "message", user: BOB, ts: "1700000100.000200", text: "没懂，能给我讲前因后果吗 用中文" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      // A long timeout: the reply must end the wait at once, not at the deadline.
      const started = Date.now();
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "3600"], m.baseUrl);
      expect(Date.now() - started).toBeLessThan(30_000);
      // NOT 0 (a decision nobody took) and NOT 2 (nobody replied).
      expect(r.exitCode).toBe(5);
      // The reply itself IS the output — it is usually an instruction or a question back.
      expect(r.stdout.trim()).toBe("没懂，能给我讲前因后果吗 用中文");
      expect(r.stderr).toContain("選択肢外");
      // Resuming past it is spelled out, so re-waiting does not re-deliver it.
      expect(r.stderr).toContain("--after=1700000100.000200");
      // And the question is left standing: a pill pressed later still decides it.
      expect(m.requests.some((q) => q.method === "chat.update")).toBe(false);
    } finally {
      await m.stop();
    }
  });

  test("--after skips a free-text reply that was already delivered", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [
        { type: "message", user: SELF, ts: QTS, text: QUESTION },
        { type: "message", user: BOB, ts: "1700000100.000200", text: "背景を教えて" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--after=1700000100.000200", "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim()).toBe("");
    } finally {
      await m.stop();
    }
  });

  // cross-vendor review 2026-09-27: an earlier AMBIGUOUS reply used to hide a
  // later free-text one, sending it down the exit-4 path with stdout empty.
  test("a free-text reply after an ambiguous one is still delivered (exit 5)", async () => {
    const dup = askBuildText(`<@${BOB}> どっち?`, "", ["A", "A"], [], false);
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [
        { type: "message", user: SELF, ts: QTS, text: dup },
        { type: "message", user: BOB, ts: "1700000100.000200", text: "A" },
        { type: "message", user: BOB, ts: "1700000200.000300", text: "説明してください" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(5);
      expect(r.stdout.trim()).toBe("説明してください");
    } finally {
      await m.stop();
    }
  });

  test("a resumed --after wait keeps --after in the next resume hint", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [
        { type: "message", user: SELF, ts: QTS, text: QUESTION },
        { type: "message", user: BOB, ts: "1700000100.000200", text: "背景を教えて" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--after=1700000100.000200", "--timeout", "1"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      // Following the hint must not re-deliver the reply already acted on.
      expect(r.stderr).toContain(`--waitFor='${DM}:${QTS}' --after=1700000100.000200`);
    } finally {
      await m.stop();
    }
  });

  test("a reply matching SEVERAL choices is still refused (exit 4, stdout empty)", async () => {
    const dup = askBuildText(`<@${BOB}> どっち?`, "", ["A", "A"], [], false);
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [
        { type: "message", user: SELF, ts: QTS, text: dup },
        { type: "message", user: BOB, ts: "1700000100.000200", text: "A" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(4);
      expect(r.stdout.trim()).toBe("");
    } finally {
      await m.stop();
    }
  });

  test("a reply that names a choice IS an answer, and normalises to the choice", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [
        { type: "message", user: SELF, ts: QTS, text: QUESTION },
        { type: "message", user: BOB, ts: "1700000100.000200", text: "2" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      // "2" reaches the caller as the CHOICE, so a pill press and a typed number
      // are the same decision rather than two spellings of it.
      expect(r.stdout.trim()).toBe("B");
    } finally {
      await m.stop();
    }
  });

  // The direction that keeps this from being an outage: a question asked with NO
  // choices is still answered by whatever comes back. Without this, the fix would
  // make every free-text ask uncollectable.
  test("with no choices offered, any reply is still the answer", async () => {
    const freeText = askBuildText(`<@${BOB}> なぜ落ちた?`, "", [], [], false);
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [
        { type: "message", user: SELF, ts: QTS, text: freeText },
        { type: "message", user: BOB, ts: "1700000100.000200", text: "ディスクが一杯でした" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("ディスクが一杯でした");
    } finally {
      await m.stop();
    }
  });

  // A clarifying question does not poison the well: whoever asked it can still
  // choose afterwards, and the later reply settles it.
  test("a choice made AFTER a non-choice reply still resolves it", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      ...waitForFixture(DM, [
        { type: "message", user: SELF, ts: QTS, text: QUESTION },
        { type: "message", user: BOB, ts: "1700000100.000200", text: "どういう意味?" },
        { type: "message", user: BOB, ts: "1700000200.000300", text: "A" },
      ]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("A");
    } finally {
      await m.stop();
    }
  });

  test("a message that is not a question is refused instead of polled", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      ...waitForFixture(DM, [{ type: "message", user: SELF, ts: QTS, text: "ただの発言です" }]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "20"], m.baseUrl);
      expect(r.exitCode).toBe(3);
      expect(r.stdout.trim()).toBe("");
      expect(r.stderr).toContain("質問として読み取れません");
      // The rejection must name WHICH check failed. A single generic line sent
      // a real user re-checking permalinks that were fine, for ~20 minutes,
      // while pressed answers went uncollected (2026-08-31).
      expect(r.stderr).toContain("理由:");
    } finally {
      await m.stop();
    }
  });

  test("--timeout 0 checks exactly once and exits 2 when still open", async () => {
    const inline: InlineFixtures = {
      ...AUTH,
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      ...waitForFixture(DM, [{
        type: "message", user: SELF, ts: QTS, text: QUESTION,
        // Only the asker's own seeds — the pills as they were left.
        reactions: [{ name: "one", users: [SELF], count: 1 }],
      }]),
    };
    const m = await startMock({ inline });
    try {
      const r = await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim()).toBe("");
      // Exactly one poll: this mode exists so a monitor can check cheaply
      // instead of parking a process on --wait.
      expect(m.requests.filter((q) => q.method === "conversations.history" && q.params.limit === "30").length).toBe(1);
    } finally {
      await m.stop();
    }
  });

  test("mixing --waitFor with a new question is refused", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const r = await run(["ask", "#chan", "@bob q", "--waitFor", `${DM}:${QTS}`], m.baseUrl);
      expect(r.exitCode).toBe(3);
      expect(m.requests.some((q) => q.method === "chat.postMessage")).toBe(false);
    } finally {
      await m.stop();
    }
  });
});

describe("ask URL boundaries", () => {
  for (const field of ["question", "body", "choice"]) {
    test(`guards URLs in the ${field} and supports the warning override`, async () => {
      const m = await startMock({ inline: AUTH });
      try {
        const url = field === "question" ? "https://example.com/path/>" : "https://example.com/path/内容";
        const base = ["ask", "#chan", `@bob ${field === "question" ? url : "Review?"}`,
          ...(field === "choice" ? [url] : []),
          ...(field === "body" ? ["--body", url] : []), "--channel-id", CHAN];
        const rejected = await run(base, m.baseUrl);
        expect(rejected.stderr).toContain("Ambiguous URL boundary");
        expect(m.requests.some((r) => r.method === "chat.postMessage")).toBe(false);
        const dry = await run([...base, "--allow-url-adjacent"], m.baseUrl);
        const confirmed = await run([...base, "--allow-url-adjacent", `--code=${extractCode(dry.stderr)}`], m.baseUrl);
        expect(confirmed.exitCode).toBe(0);
        expect(confirmed.stderr).toContain("Warning: Ambiguous URL boundary");
      } finally { await m.stop(); }
    });
  }
  for (const body of ["https://example.com/path/\n内容", "<https://example.com/path/>", "<https://example.com/path/|説明>"]) {
    test(`accepts and preserves body ${JSON.stringify(body)}`, async () => {
      const m = await startMock({ inline: AUTH });
      try {
        const base = ["ask", "#chan", "@bob Review?", "--body", body, "--channel-id", CHAN];
        const dry = await run(base, m.baseUrl);
        const confirmed = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
        expect(confirmed.exitCode).toBe(0);
        const posted = m.requests.find((r) => r.method === "chat.postMessage");
        expect(JSON.parse(posted!.body).text).toContain(body);
      } finally { await m.stop(); }
    });
  }
});

// THE LIVE CASE, 2026-10-02: a pill was pressed and collected, ✅ was written,
// the watcher exited — and the same person's thread note 40 s later was never
// delivered by anything. A note is a reply from the audience that is NOT the
// answer. It rides along with the answer, never replaces it: plain stdout is
// still the answer alone, and --json carries the notes plus a cursor that, fed
// back as --after, never delivers the same note twice.
describe("ask collects thread notes beside the answer (CLI)", { timeout: 90_000 }, () => {
  const Q = askBuildText(`<@${BOB}> どっち?`, "", ["A", "B"], [], true);
  const T = (n: number) => `1700000000.000${n}`; // all after QTS (…000100)
  const note = (ts: string, text: string, user = BOB, extra: Record<string, unknown> = {}) =>
    ({ type: "message", user, ts, thread_ts: QTS, text, ...extra });

  function fx(question: Record<string, unknown>, thread: unknown[]): InlineFixtures {
    const messages = [question];
    return {
      ...AUTH,
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages },
      ...pollFixture(CHAN, messages),
      [`conversations.replies__channel=${CHAN}&limit=30&ts=${QTS}`]: { ok: true, messages: [question, ...thread] },
      [`conversations.replies__channel=${CHAN}&limit=100&ts=${QTS}`]: { ok: true, messages: [question, ...thread] },
    };
  }
  const json = (stdout: string) => JSON.parse(stdout.trim()) as { status: string; answer: string | null; notes: { ts: string; user: string; text: string }[]; cursor: string };

  test("a pill + a thread note already there: both delivered, the pill is still the answer", async () => {
    const q = { type: "message", user: SELF, ts: QTS, text: Q, reply_count: 1, reactions: [{ name: "one", users: [SELF, BOB], count: 2 }] };
    const m = await startMock({ inline: fx(q, [note(T(200), "cswap ls も見て")]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const o = json(r.stdout);
      expect(o.status).toBe("answered");
      expect(o.answer).toBe("A");
      expect(o.notes.map((n) => [n.ts, n.user, n.text])).toEqual([[T(200), BOB, "cswap ls も見て"]]);
      expect(o.cursor).toBe(T(200));
    } finally {
      await m.stop();
    }
  });

  test("a question missing from the history page still has its thread read", async () => {
    // Busy conversation: the poll's history page does not include the question,
    // so its reply_count is unknown — and unknown must not be read as zero.
    const qd = askBuildText(`<@${BOB}> どっち?`, "", ["A", "B"], [], false);
    const q = { type: "message", user: SELF, ts: QTS, text: qd, reply_count: 1 };
    const page = [{ type: "message", user: BOB, ts: T(200), text: "1" }];
    const m = await startMock({ inline: {
      ...AUTH,
      "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", profile: { display_name: "bob" } } },
      [`conversations.info__channel=${DM}`]: { ok: true, channel: { id: DM, is_im: true, user: BOB, name: "" } },
      [`conversations.history__channel=${DM}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages: [q] },
      ...pollFixture(DM, page),
      [`conversations.replies__channel=${DM}&limit=100&ts=${QTS}`]: { ok: true, messages: [q, { ...note(T(300), "スレッドにも一言") }] },
    } });
    try {
      const o = json((await run(["ask", "--waitFor", `${DM}:${QTS}`, "--timeout", "0", "--json"], m.baseUrl)).stdout);
      expect(o.answer).toBe("A");
      expect(o.notes.map((n) => n.text)).toEqual(["スレッドにも一言"]);
    } finally {
      await m.stop();
    }
  });

  test("plain mode keeps stdout = the answer alone; the note goes to stderr", async () => {
    const q = { type: "message", user: SELF, ts: QTS, text: Q, reply_count: 1, reactions: [{ name: "one", users: [SELF, BOB], count: 2 }] };
    const m = await startMock({ inline: fx(q, [note(T(200), "cswap ls も見て")]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("A\n");
      expect(r.stderr).toContain("cswap ls も見て");
      expect(r.stderr).toContain(`--after=${T(200)}`);
    } finally {
      await m.stop();
    }
  });

  test("a pill + a note written AFTER ✅ is delivered on the next --waitFor (the 2026-10-02 case)", async () => {
    const resolved = askBuildResolvedText(`<@${BOB}> どっち?`, { answer: "A", how: "リアクション 1️⃣", who: BOB }, "bob");
    // ✅ was written at …150 — by a build that collected no notes, so the …120
    // note was never delivered either. No default cursor: both come back.
    const q = { type: "message", user: SELF, ts: QTS, text: resolved, reply_count: 2, edited: { user: SELF, ts: T(150) } };
    const m = await startMock({ inline: fx(q, [note(T(120), "前の追記"), note(T(300), "也看一眼 cswap ls")]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const o = json(r.stdout);
      expect(o.answer).toBe("A");
      expect(o.notes.map((n) => n.text)).toEqual(["前の追記", "也看一眼 cswap ls"]);
      expect(o.cursor).toBe(T(300));
    } finally {
      await m.stop();
    }
  });

  test("a free-text answer + another reply: the answer is not repeated as a note", async () => {
    const q = { type: "message", user: SELF, ts: QTS, text: Q, reply_count: 2 };
    const m = await startMock({ inline: fx(q, [note(T(200), "2"), note(T(300), "あと README も")]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const o = json(r.stdout);
      expect(o.answer).toBe("B");
      expect(o.notes.map((n) => n.ts)).toEqual([T(300)]);
      expect(o.cursor).toBe(T(300));
    } finally {
      await m.stop();
    }
  });

  test("on a ✅ question answered BY A REPLY, that reply is not handed back as a note", async () => {
    // Stamp says "reply (2)": the "2." before the ✅ edit is the answer itself.
    const resolved = askBuildResolvedText(`<@${BOB}> どっち?`, { answer: "B", how: "返信 (2)", who: BOB }, "bob");
    const q = { type: "message", user: SELF, ts: QTS, text: resolved, reply_count: 3, edited: { user: SELF, ts: T(250) } };
    const m = await startMock({ inline: fx(q, [note(T(200), "2."), note(T(300), "2 番目の理由も書いて"), note(T(400), "あと README も")]) });
    try {
      const o = json((await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json"], m.baseUrl)).stdout);
      expect(o.answer).toBe("B");
      // …300 also starts with "2", but it came AFTER ✅ — it cannot be the answer.
      expect(o.notes.map((n) => n.ts)).toEqual([T(300), T(400)]);
    } finally {
      await m.stop();
    }
    // The answer reply since deleted: a later "2 …" must not be taken for it.
    const m2 = await startMock({ inline: fx(q, [note(T(300), "2 番目の理由も書いて")]) });
    try {
      const o = json((await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json"], m2.baseUrl)).stdout);
      expect(o.notes.map((n) => n.ts)).toEqual([T(300)]);
    } finally {
      await m2.stop();
    }
  });

  test("replies from outside the audience — a bystander, the asker, a bot — are not notes", async () => {
    const q = { type: "message", user: SELF, ts: QTS, text: Q, reply_count: 4, reactions: [{ name: "one", users: [SELF, BOB], count: 2 }] };
    const m = await startMock({ inline: fx(q, [
      note(T(200), "横から失礼", ALICE),
      note(T(300), "了解、見ます", SELF),
      note(T(400), "bot echo", BOB, { bot_id: "B00000001" }),
      note(T(500), "joined", BOB, { subtype: "channel_join" }),
    ]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(json(r.stdout).notes).toEqual([]);
    } finally {
      await m.stop();
    }
  });

  test("the cursor never delivers a note twice", async () => {
    const resolved = askBuildResolvedText(`<@${BOB}> どっち?`, { answer: "A", how: "リアクション 1️⃣", who: BOB }, "bob");
    const q = { type: "message", user: SELF, ts: QTS, text: resolved, reply_count: 2, edited: { user: SELF, ts: T(150) } };
    const m = await startMock({ inline: fx(q, [note(T(200), "one"), note(T(300), "two")]) });
    try {
      const first = json((await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json"], m.baseUrl)).stdout);
      expect(first.notes.map((n) => n.text)).toEqual(["one", "two"]);
      // Feed the cursor back: nothing new, nothing repeated — and the cursor holds.
      const again = json((await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json", `--after=${first.cursor}`], m.baseUrl)).stdout);
      expect(again.notes).toEqual([]);
      expect(again.cursor).toBe(first.cursor);
      // A cursor between the two delivers only the newer one.
      const mid = json((await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json", `--after=${T(200)}`], m.baseUrl)).stdout);
      expect(mid.notes.map((n) => n.text)).toEqual(["two"]);
    } finally {
      await m.stop();
    }
  });
});

describe("ask void — 作废 (CLI)", { timeout: 90_000 }, () => {
  const LINK = `${CHAN}:${QTS}`;
  const OPEN = askBuildText(`<@${BOB}> 出してよい?`, "背景: head bcb7fd8e", ["リリースする", "見送る"], [], true);
  const NEW_TS = "1700000000.000900";
  const fx = (msg: Record<string, unknown>): InlineFixtures => ({
    ...AUTH,
    [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages: [msg] },
    // The replacement question --superseded-by points at.
    [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${NEW_TS}`]: { ok: true, messages: [{ type: "message", user: SELF, ts: NEW_TS, text: "new" }] },
    ...pollFixture(CHAN, [msg]),
  });
  const body = (q: { body: string }) => (q.body.startsWith("{") ? JSON.parse(q.body) : Object.fromEntries(new URLSearchParams(q.body)));

  test("voids your own open question behind the code gate: 🚫 text, body kept, seeds off, 🚫 on", async () => {
    const m = await startMock({ inline: fx({ type: "message", user: SELF, ts: QTS, text: OPEN, reactions: [{ name: "one", users: [SELF, BOB], count: 2 }] }) });
    try {
      const base = ["ask", `--void=${LINK}`, "--reason", "head moved", "--superseded-by", `https://acme.slack.com/archives/C00000001/p1700000000000900`];
      const dry = await run(base, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      expect(dry.stdout).toContain("1 question(s)");
      expect(dry.stdout).toContain("already pressed: :one:");
      expect(m.requests.some((q) => q.method === "chat.update")).toBe(false);

      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const text = body(m.requests.find((q) => q.method === "chat.update")!).text as string;
      expect(text.startsWith(":no_entry_sign: ")).toBe(true);
      expect(text).toContain("背景: head bcb7fd8e");
      expect(text).not.toContain(":one: リリースする");
      const p = askParseMessage(text);
      expect(p.kind === "void" && p.supersededBy).toBe("https://acme.slack.com/archives/C00000001/p1700000000000900");
      const removed = m.requests.filter((q) => q.method === "reactions.remove").map((q) => body(q).name);
      expect(removed).toEqual(["one", "two", "question"]);
      expect(m.requests.filter((q) => q.method === "reactions.add").map((q) => body(q).name)).toEqual(["no_entry_sign"]);
    } finally {
      await m.stop();
    }
  });

  test("a --superseded-by that names no message is refused before anything is edited", async () => {
    const m = await startMock({ inline: fx({ type: "message", user: SELF, ts: QTS, text: OPEN }) });
    try {
      for (const bad of ["not-a-link", "https://acme.slack.com/archives/C00000001/p1700000000000777"]) {
        const r = await run(["ask", `--void=${LINK}`, "--superseded-by", bad], m.baseUrl);
        expect(r.exitCode).toBe(3);
      }
      expect(m.requests.some((q) => q.method === "chat.update")).toBe(false);
    } finally {
      await m.stop();
    }
  });

  test("refuses a question someone else posted, and an answered one", async () => {
    for (const msg of [
      { type: "message", user: BOB, ts: QTS, text: OPEN },
      { type: "message", user: SELF, ts: QTS, text: askBuildResolvedText(`<@${BOB}> 出してよい?`, { answer: "見送る", how: "リアクション 2️⃣" }, "bob") },
    ]) {
      const m = await startMock({ inline: fx(msg) });
      try {
        const r = await run(["ask", "void", LINK], m.baseUrl);
        expect(r.exitCode).toBe(3);
        expect(m.requests.some((q) => q.method === "chat.update")).toBe(false);
      } finally {
        await m.stop();
      }
    }
  });

  test("collect / --waitFor on a void question exits 6 — plain stdout empty, --json says void", async () => {
    const voided = askBuildVoidText(`<@${BOB}> 出してよい?`, "head moved", "ja", "背景");
    const m = await startMock({ inline: fx({ type: "message", user: SELF, ts: QTS, text: voided }) });
    try {
      const plain = await run(["ask", "collect", LINK, "--timeout", "0"], m.baseUrl);
      expect(plain.exitCode).toBe(6);
      expect(plain.stdout).toBe("");
      const j = await run(["ask", "--waitFor", LINK, "--timeout", "0", "--json"], m.baseUrl);
      expect(j.exitCode).toBe(6);
      const o = JSON.parse(j.stdout);
      expect(o.status).toBe("void");
      expect(o.reason).toContain("head moved");
    } finally {
      await m.stop();
    }
  });

  test("a wait on a question that gets voided meanwhile stops with 6", async () => {
    // --waitFor opens on the OPEN text; the poll then sees it voided.
    const voided = askBuildVoidText(`<@${BOB}> 出してよい?`, "expired", "ja");
    const m = await startMock({ inline: {
      ...AUTH,
      [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages: [{ type: "message", user: SELF, ts: QTS, text: OPEN }] },
      ...pollFixture(CHAN, [{ type: "message", user: SELF, ts: QTS, text: voided }]),
    } });
    try {
      const r = await run(["ask", "--waitFor", LINK, "--timeout", "5"], m.baseUrl);
      expect(r.exitCode).toBe(6);
      expect(r.stdout).toBe("");
    } finally {
      await m.stop();
    }
  });
});

describe("slack edit refuses an ask / poll message unless --force (CLI)", { timeout: 90_000 }, () => {
  const OPEN = askBuildText(`<@${BOB}> 出してよい?`, "", ["A", "B"], [], true);
  const fx = (text: string): InlineFixtures => ({
    ...AUTH,
    [`conversations.replies__channel=${CHAN}&limit=1&ts=${QTS}`]: { ok: true, messages: [{ type: "message", user: SELF, ts: QTS, text }] },
  });

  test("an ask is refused and points at `slack ask void`; --force reaches the normal gate", async () => {
    const m = await startMock({ inline: fx(OPEN) });
    try {
      const r = await run(["edit", `#chan:${QTS}`, "書き換え", "--channel-id", CHAN], m.baseUrl);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("slack ask --void=");
      expect(r.stdout).not.toContain("Editing as");
      const f = await run(["edit", `#chan:${QTS}`, "書き換え", "--channel-id", CHAN, "--force"], m.baseUrl);
      expect(f.stdout).toContain("Editing as");
      expect(m.requests.some((q) => q.method === "chat.update")).toBe(false);
    } finally {
      await m.stop();
    }
  });

  test("an ordinary message is not affected", async () => {
    const m = await startMock({ inline: fx("ふつうのメッセージ") });
    try {
      const r = await run(["edit", `#chan:${QTS}`, "書き換え", "--channel-id", CHAN], m.baseUrl);
      expect(r.stderr).not.toContain("slack ask --void=");
      expect(r.stdout).toContain("Editing as");
    } finally {
      await m.stop();
    }
  });
});
