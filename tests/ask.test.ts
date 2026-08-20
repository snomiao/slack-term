// CLI integration tests for `slack ask` — the confirm gate, the seeded
// reactions, and the three ways `--wait` can end (reaction answer, text answer,
// timeout). Everything runs against the mock Slack server; per the project's
// QA rule, `ask` is a write command and must never be pointed at real Slack.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";
import { askBuildText, askBuildResolvedText } from "../ts/ask.ts";

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
      expect(seeds).toEqual(["one", "two", "three"]);
      // And every seed must come after the message it is attached to.
      expect(reqs.findIndex((q) => q.method === "reactions.add")).toBeGreaterThan(post);
    } finally {
      await m.stop();
    }
  });

  test("no choices means no seeded reactions, and the body asks for a reply", async () => {
    const m = await startMock({ inline: { ...AUTH } });
    try {
      const base = ["ask", "#chan", "@bob どう思う?", "--channel-id", CHAN];
      const dry = await run(base, m.baseUrl);
      const before = m.requests.length;
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const reqs = m.requests.slice(before);
      expect(reqs.some((q) => q.method === "reactions.add")).toBe(false);
      const posted = JSON.parse(reqs.find((q) => q.method === "chat.postMessage")!.body).text as string;
      expect(posted).toContain("返信してください");
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
      expect(r.stderr).toContain("質問ではありません");
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
