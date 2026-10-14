// `slack ask --explain`: the ℹ️ pill asks the asker to explain, and is NEVER an
// answer (2026-10-14: an "explain" offered as a numbered choice was collected as
// the decision). Everything runs against the mock Slack server — `ask` is a
// write command and must never be pointed at real Slack.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";
import { askBuildText, askParseMessage, askResolvedKeep, askSalvageUnreadable, ASK_COPY } from "../ts/ask.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ENTRY = join(HERE, "..", "ts", "cli.ts");

const QTS = "1700000000.000100"; // ts the mock's chat.postMessage always returns
const SELF = "U00000001";
const BOB = "U00000BOB";
const ALICE = "U0000ALIC";
const BOT = "U0000B0T1";
const CHAN = "C00000001";
const T = (n: number) => `1700000000.000${n}`; // all after QTS (…000100)

let tmpHome: string;
beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-ask-explain-"));
});
afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };
function run(args: string[], baseUrl: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w, SLACK_TERM_ASK_EXPLAIN: _e,
    ...rest
  } = process.env as Record<string, string>;
  const env = { ...rest, HOME: tmpHome, SLACK_API_BASE: `${baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake", ...extraEnv };
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
  "users.list__limit=200": {
    ok: true,
    members: [
      { id: SELF, name: "user1", real_name: "User One" },
      { id: BOB, name: "bob", real_name: "Bob" },
      { id: ALICE, name: "alice", real_name: "Alice" },
    ],
  },
  "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", is_bot: false, profile: { display_name: "bob" } } },
  "users.info__user=U0000B0T1": { ok: true, user: { id: BOT, name: "somebot", is_bot: true, profile: { display_name: "somebot" } } },
};

const body = (q: { body: string }) => (q.body.startsWith("{") ? JSON.parse(q.body) : Object.fromEntries(new URLSearchParams(q.body)));
const posts = (m: { requests: { method: string; body: string }[] }) => m.requests.filter((q) => q.method === "chat.postMessage").map((q) => body(q));

/** An open channel question offering ℹ️, addressed to bob, as the poll reads it. */
const Q = askBuildText(`<@${BOB}> 出してよい?`, "背景: head bcb7fd8e", ["リリースする", "見送る"], [], true, "ja", true);

function fx(reactions: unknown[], thread: unknown[] = []): InlineFixtures {
  const q = { type: "message", user: SELF, ts: QTS, text: Q, reply_count: thread.length, reactions };
  const messages = [q];
  return {
    ...AUTH,
    [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages },
    [`conversations.history__channel=${CHAN}&inclusive=true&limit=30&oldest=${QTS}`]: { ok: true, messages },
    [`conversations.history__channel=${CHAN}&limit=1`]: { ok: true, messages: [] },
    [`conversations.replies__channel=${CHAN}&limit=30&ts=${QTS}`]: { ok: true, messages: [q, ...thread] },
    [`conversations.replies__channel=${CHAN}&limit=100&ts=${QTS}`]: { ok: true, messages: [q, ...thread] },
    [`conversations.replies__channel=${CHAN}&limit=200&oldest=${QTS}&ts=${QTS}`]: { ok: true, messages: [q, ...thread] },
  };
}
const SEEDS = [{ name: "one", users: [SELF], count: 1 }, { name: "two", users: [SELF], count: 1 }, { name: "heavy_plus_sign", users: [SELF], count: 1 }];
const explainBy = (...users: string[]) => ({ name: "information_source", users: [SELF, ...users], count: users.length + 1 });
const ourNote = (ts: string) => ({ type: "message", user: SELF, ts, thread_ts: QTS, text: ASK_COPY.ja.explainNote });

describe("ask --explain format", () => {
  test("the ℹ️ line sits under ❓ and round-trips; without it nothing changes", () => {
    const lines = Q.split("\n");
    expect(lines[lines.indexOf(ASK_COPY.ja.otherThread) + 1]).toBe(ASK_COPY.ja.explainLine);
    const p = askParseMessage(Q);
    expect(p).toEqual({ kind: "open", question: `<@${BOB}> 出してよい?`, body: "背景: head bcb7fd8e", reactable: ["リリースする", "見送る"], overflow: [], threadOnly: true, lang: "ja", explain: true });
    const plain = askBuildText(`<@${BOB}> 出してよい?`, "背景: head bcb7fd8e", ["リリースする", "見送る"], [], true);
    expect(plain).not.toContain(ASK_COPY.ja.explainLine);
    expect(askParseMessage(plain)).toMatchObject({ kind: "open", explain: false });
  });

  test("free-text and overflow questions carry it too, and the body never swallows it", () => {
    const free = askBuildText(`<@${BOB}> なぜ落ちた?`, "ログ: none", [], [], false, "en", true);
    expect(askParseMessage(free)).toEqual({ kind: "open", question: `<@${BOB}> なぜ落ちた?`, body: "ログ: none", reactable: [], overflow: [], threadOnly: false, lang: "en", explain: true });
    const many = Array.from({ length: 12 }, (_, i) => `c${i + 1}`);
    const lp = askBuildText(`<@${BOB}> どれ?`, "", many.slice(0, 10), many.slice(10), true, "ja", true);
    expect(askParseMessage(lp)).toMatchObject({ kind: "open", reactable: many.slice(0, 10), overflow: ["c11", "c12"], explain: true, body: "" });
  });

  test("a free-text body whose last line starts with ℹ️ is body, not the explain line, unless built with --explain", () => {
    for (const lang of ["ja", "en"] as const) {
      for (const tail of ["ℹ️ メモ: 先に CI を見てください", ":information_source: note: check CI first"]) {
        for (const b of [tail, `背景\n${tail}`, `背景\n\n${tail}`]) {
          const plain = askBuildText(`<@${BOB}> なぜ落ちた?`, b, [], [], true, lang);
          expect(askParseMessage(plain)).toMatchObject({ kind: "open", body: b, explain: false });
          const withExplain = askBuildText(`<@${BOB}> なぜ落ちた?`, b, [], [], true, lang, true);
          expect(askParseMessage(withExplain)).toMatchObject({ kind: "open", body: b, explain: true });
        }
      }
      // The glyph spelling of OUR line (a body hand-edited in Slack) still reads as the pill.
      const glyph = askBuildText(`<@${BOB}> なぜ?`, "", [], [], true, lang, true).replace(":information_source: ", "ℹ️ ");
      expect(askParseMessage(glyph)).toMatchObject({ kind: "open", body: "", explain: true });
    }
  });

  test("✅ keeps the body and the chosen line, not the ℹ️ line; void salvage drops it", () => {
    const keep = askResolvedKeep(Q, 2)!;
    expect(keep.body).toBe("背景: head bcb7fd8e");
    expect(JSON.stringify(keep)).not.toContain("説明して");
    const flat = Q.replace(/\n/g, " ");
    expect(askSalvageUnreadable(flat)!.body).not.toContain("説明して");
  });
});

describe("ask --explain seeds (CLI)", { timeout: 60_000 }, () => {
  test("--explain seeds ℹ️ after ❓ and the gate says so; SLACK_TERM_ASK_EXPLAIN=1 does the same; --no-explain wins", async () => {
    for (const [flags, env, want] of [
      [["--explain"], {}, true],
      [[], { SLACK_TERM_ASK_EXPLAIN: "1" }, true],
      [["--no-explain"], { SLACK_TERM_ASK_EXPLAIN: "1" }, false],
    ] as [string[], Record<string, string>, boolean][]) {
      const m = await startMock({ inline: { ...AUTH } });
      try {
        const base = ["ask", "#chan", "@bob deploy してよい?", "はい", "まって", "--channel-id", CHAN, ...flags];
        const dry = await run(base, m.baseUrl, env);
        expect(dry.stdout.includes("Explain:  ℹ️")).toBe(want);
        const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl, env);
        expect(r.exitCode).toBe(0);
        const seeds = m.requests.filter((q) => q.method === "reactions.add").map((q) => body(q).name);
        expect(seeds).toEqual(want ? ["one", "two", "heavy_plus_sign", "information_source"] : ["one", "two", "heavy_plus_sign"]);
        expect((posts(m)[0]!.text as string).includes(ASK_COPY.ja.explainLine)).toBe(want);
      } finally {
        await m.stop();
      }
    }
  });
});

describe("ask --waitFor with ℹ️ pressed (CLI)", { timeout: 90_000 }, () => {
  test("an explain press keeps the pill open: no ✅, no seeds removed, one thread note, stderr says so", async () => {
    const m = await startMock({ inline: fx([...SEEDS, explainBy(BOB)]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--json"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      const o = JSON.parse(r.stdout.trim());
      expect(o.status).toBe("timeout");
      expect(o.answer).toBe(null);
      expect(o.explain).toEqual([BOB]);
      expect(r.stderr).toContain(`<@${BOB}> が ℹ️ 説明して を押しました`);
      expect(m.requests.some((q) => q.method === "chat.update")).toBe(false);
      expect(m.requests.some((q) => q.method === "reactions.remove")).toBe(false);
      const p = posts(m);
      expect(p.length).toBe(1);
      expect(p[0]!.thread_ts).toBe(QTS);
      expect(p[0]!.text).toBe(ASK_COPY.ja.explainNote);
    } finally {
      await m.stop();
    }
  });

  test("repeated looks do not spam: a note already in the thread is not posted again", async () => {
    const m = await startMock({ inline: fx([...SEEDS, explainBy(BOB)], [ourNote(T(200))]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m.baseUrl);
      // Note already there → not this run's news: plain timeout, not 7.
      expect(r.exitCode).toBe(2);
      expect(posts(m).length).toBe(0);
    } finally {
      await m.stop();
    }
  });

  test("the note is recognised by its copy, whoever posted it — @here, collected by someone in the audience", async () => {
    const here = askBuildText(`<!here> 出してよい?`, "", ["A", "B"], [], true, "en", true);
    const msg = { type: "message", user: SELF, ts: QTS, text: here, reply_count: 1, reactions: [...SEEDS, explainBy(BOB)] };
    // An earlier run as another identity (ALICE — in the @here audience) posted the en note.
    const prior = { type: "message", user: ALICE, ts: T(200), thread_ts: QTS, text: ASK_COPY.en.explainNote };
    const m = await startMock({ inline: {
      ...fx([]),
      [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages: [msg] },
      [`conversations.history__channel=${CHAN}&inclusive=true&limit=30&oldest=${QTS}`]: { ok: true, messages: [msg] },
      [`conversations.replies__channel=${CHAN}&limit=100&ts=${QTS}`]: { ok: true, messages: [msg, prior] },
      [`conversations.replies__channel=${CHAN}&limit=200&oldest=${QTS}&ts=${QTS}`]: { ok: true, messages: [msg, prior] },
      [`conversations.replies__channel=${CHAN}&limit=30&ts=${QTS}`]: { ok: true, messages: [msg, prior] },
    } });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(posts(m).length).toBe(0);
    } finally {
      await m.stop();
    }
  });

  test("the note is found past the first page of a long thread — no duplicate", async () => {
    const page1 = { ok: true, messages: [{ type: "message", user: BOB, ts: T(150), thread_ts: QTS, text: "chatter" }], response_metadata: { next_cursor: "c2" } };
    const page2 = { ok: true, messages: [ourNote(T(900))] };
    const m = await startMock({ inline: {
      ...fx([...SEEDS, explainBy(BOB)]),
      [`conversations.replies__channel=${CHAN}&limit=200&oldest=${QTS}&ts=${QTS}`]: page1,
      [`conversations.replies__channel=${CHAN}&cursor=c2&limit=200&oldest=${QTS}&ts=${QTS}`]: page2,
    } });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(posts(m).length).toBe(0);
    } finally {
      await m.stop();
    }
  });

  test("a presser who cannot be checked for bot-ness does not count yet (no note, no exit 7)", async () => {
    // A failed lookup, and a reply that does not say.
    for (const info of [{ ok: false, error: "ratelimited" }, { ok: true, user: { id: BOB } }]) {
      const m = await startMock({ inline: { ...fx([...SEEDS, explainBy(BOB)]), "users.info__user=U00000BOB": info } });
      try {
        const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m.baseUrl);
        expect(r.exitCode).toBe(2);
        expect(posts(m).length).toBe(0);
      } finally {
        await m.stop();
      }
    }
  });

  test("a note that failed to post is no reason for exit 7 — stderr says so, the wait goes on", async () => {
    const m = await startMock({ inline: { ...fx([...SEEDS, explainBy(BOB)]), "chat.postMessage": { ok: false, error: "not_in_channel" } } });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "3", "--explain-exit"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("説明リクエストの案内をスレッドに出せませんでした");
      // Tried once this run, not on every tick.
      expect(m.requests.filter((q) => q.method === "chat.postMessage").length).toBe(1);
    } finally {
      await m.stop();
    }
  });

  test("--explain-exit: exit 7 on the run that posts the note; stdout empty; question stays open", async () => {
    const m = await startMock({ inline: fx([...SEEDS, explainBy(BOB)]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m.baseUrl);
      expect(r.exitCode).toBe(7);
      expect(r.stdout).toBe("");
      expect(posts(m).length).toBe(1);
      expect(m.requests.some((q) => q.method === "chat.update")).toBe(false);
      const j = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit", "--json"], m.baseUrl);
      // The static mock still shows no note, so this run posts (and exits) again —
      // the --json shape is what is checked here.
      expect(j.exitCode).toBe(7);
      expect(JSON.parse(j.stdout.trim())).toMatchObject({ status: "explain", answer: null, explain: [BOB] });
    } finally {
      await m.stop();
    }
  });

  test("explain, then a real answer: resolves normally, ℹ️ seed comes off, no second note", async () => {
    const m1 = await startMock({ inline: fx([...SEEDS, explainBy(BOB)]) });
    try {
      expect((await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0"], m1.baseUrl)).exitCode).toBe(2);
    } finally {
      await m1.stop();
    }
    const two = { name: "two", users: [SELF, BOB], count: 2 };
    const m = await startMock({ inline: fx([SEEDS[0], two, SEEDS[2], explainBy(BOB)], [ourNote(T(200))]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("見送る");
      expect(posts(m).length).toBe(0);
      const text = body(m.requests.find((q) => q.method === "chat.update")!).text as string;
      expect(askParseMessage(text)).toMatchObject({ kind: "resolved", answer: "見送る" });
      expect(text).not.toContain("説明して");
      expect(m.requests.filter((q) => q.method === "reactions.remove").map((q) => body(q).name)).toContain("information_source");
    } finally {
      await m.stop();
    }
  });

  test("a press from outside the audience, from a bot, or from the asker is ignored", async () => {
    const m = await startMock({ inline: fx([...SEEDS, { name: "information_source", users: [SELF, ALICE, BOT], count: 3 }]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit", "--json"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(JSON.parse(r.stdout.trim()).explain).toBeUndefined();
      expect(r.stderr).not.toContain("説明して を押しました");
      expect(posts(m).length).toBe(0);
    } finally {
      await m.stop();
    }
    // @here opens it to everyone — but a bot is still not a person asking.
    const here = askBuildText(`<!here> 出してよい?`, "", ["A", "B"], [], true, "ja", true);
    const msg = { type: "message", user: SELF, ts: QTS, text: here, reactions: [...SEEDS, { name: "information_source", users: [SELF, BOT], count: 2 }] };
    const m2 = await startMock({ inline: { ...fx([]), [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages: [msg] }, [`conversations.history__channel=${CHAN}&inclusive=true&limit=30&oldest=${QTS}`]: { ok: true, messages: [msg] } } });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m2.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(posts(m2).length).toBe(0);
    } finally {
      await m2.stop();
    }
  });

  test("on a question that never offered ℹ️, a ℹ️ reaction is just an emoji", async () => {
    const plain = askBuildText(`<@${BOB}> 出してよい?`, "", ["A", "B"], [], true);
    const msg = { type: "message", user: SELF, ts: QTS, text: plain, reactions: [...SEEDS, explainBy(BOB)] };
    const m = await startMock({ inline: { ...fx([]), [`conversations.history__channel=${CHAN}&inclusive=true&limit=1&oldest=${QTS}`]: { ok: true, messages: [msg] }, [`conversations.history__channel=${CHAN}&inclusive=true&limit=30&oldest=${QTS}`]: { ok: true, messages: [msg] } } });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m.baseUrl);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).not.toContain("説明して を押しました");
      expect(posts(m).length).toBe(0);
    } finally {
      await m.stop();
    }
  });

  test("--void on an explain-pressed question still works, and takes our ℹ️ seed off", async () => {
    const m = await startMock({ inline: fx([...SEEDS, explainBy(BOB)], [ourNote(T(200))]) });
    try {
      const base = ["ask", `--void=${CHAN}:${QTS}`, "--reason", "head moved"];
      const dry = await run(base, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const text = body(m.requests.find((q) => q.method === "chat.update")!).text as string;
      expect(text.startsWith(":no_entry_sign: ")).toBe(true);
      expect(text).not.toContain("説明して");
      expect(m.requests.filter((q) => q.method === "reactions.remove").map((q) => body(q).name)).toEqual(["one", "two", "heavy_plus_sign", "information_source"]);
    } finally {
      await m.stop();
    }
  });
});
