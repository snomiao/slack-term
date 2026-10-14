// The "other" pill is ➕ (`:heavy_plus_sign:`), not ❓ (taku 2026-10-14). ❓
// stays the head marker that identifies an ask; only the pill moved. Pills
// posted before this carry ❓ as the other pill and must keep working:
// collect, void, edit, the ✅ rewrite and the ℹ️ explain note. Everything runs
// against the mock Slack server — `ask` must never be pointed at real Slack.

import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";
import {
  askBuildText, askParseMessage, askResolvedKeep, askSalvageUnreadable, askSeedMarker,
  ASK_COPY, ASK_LANGS, ASK_OTHER_MARKER, ASK_OTHER_MARKERS,
} from "../ts/ask.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ENTRY = join(HERE, "..", "ts", "cli.ts");

const QTS = "1700000000.000100";
const SELF = "U00000001";
const BOB = "U00000BOB";
const CHAN = "C00000001";
const T = (n: number) => `1700000000.000${n}`;

let tmpHome: string;
beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-ask-plus-"));
});
afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };
function run(args: string[], baseUrl: string): Promise<RunResult> {
  const {
    SLACK_MCP_XOXP_TOKEN: _t, SLACK_TOKEN: _s, SLACK_BOT_TOKEN: _b, HOME: _h,
    SLACK_COOKIE: _c, SLACK_MCP_XOXD_COOKIE: _d, SLACK_WORKSPACE: _w, SLACK_TERM_ASK_EXPLAIN: _e,
    ...rest
  } = process.env as Record<string, string>;
  const env = { ...rest, HOME: tmpHome, SLACK_API_BASE: `${baseUrl}/api`, SLACK_MCP_XOXP_TOKEN: "xoxp-fake" };
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
  "users.list__limit=200": { ok: true, members: [{ id: SELF, name: "user1", real_name: "User One" }, { id: BOB, name: "bob", real_name: "Bob" }] },
  "users.info__user=U00000BOB": { ok: true, user: { id: BOB, name: "bob", is_bot: false, profile: { display_name: "bob" } } },
  // The ✅ swap and the edit swap add before they remove, in one try: an add
  // that fails would skip the remove, so both must succeed here.
  "reactions.add": { ok: true },
  "reactions.remove": { ok: true },
};

const body = (q: { body: string }) => (q.body.startsWith("{") ? JSON.parse(q.body) : Object.fromEntries(new URLSearchParams(q.body)));
const named = (m: { requests: { method: string; body: string }[] }, method: string) =>
  m.requests.filter((q) => q.method === method).map((q) => body(q).name as string);
const posts = (m: { requests: { method: string; body: string }[] }) => m.requests.filter((q) => q.method === "chat.postMessage").map((q) => body(q));

/** A pill as `ask` posts it now (➕), and the same pill as it was posted before
 *  ➕ (❓ on the other line) — the only difference between the two. */
const build = (explain = false, lang: "ja" | "en" = "ja", threadOnly = true) =>
  askBuildText(`<@${BOB}> 出してよい?`, "背景: head bcb7fd8e", ["リリースする", "見送る"], [], threadOnly, lang, explain);
const toOld = (text: string) => text.replace(/^:heavy_plus_sign: /m, ":question: ");
const NEW = build();
const OLD = toOld(NEW);

function fx(text: string, reactions: unknown[], thread: unknown[] = []): InlineFixtures {
  const q = { type: "message", user: SELF, ts: QTS, text, reply_count: thread.length, reactions };
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
const seeds = (marker: string, ...extra: { name: string; users: string[]; count: number }[]) =>
  [{ name: "one", users: [SELF], count: 1 }, { name: "two", users: [SELF], count: 1 }, { name: marker, users: [SELF], count: 1 }, ...extra];

describe("➕ is the other pill (format)", () => {
  test("every language and template writes ➕ on the other line; ❓ stays the head marker only", () => {
    for (const lang of ASK_LANGS) {
      for (const threadOnly of [true, false]) {
        for (const explain of [false, true]) {
          const text = build(explain, lang, threadOnly);
          const lines = text.split("\n");
          const other = lines[lines.indexOf(":two: 見送る") + 1]!;
          expect(other).toBe(threadOnly ? ASK_COPY[lang].otherThread : ASK_COPY[lang].otherHere);
          expect(other.startsWith(":heavy_plus_sign: ")).toBe(true);
          // ❓ appears exactly once: the head.
          expect(text.split(":question:").length - 1).toBe(1);
          expect(text.startsWith(":question: *")).toBe(true);
          expect(askSeedMarker(text)).toBe(ASK_OTHER_MARKER);
        }
      }
    }
  });

  test("a free-text question has no other line and keeps the ❓ seed", () => {
    const free = askBuildText(`<@${BOB}> なぜ?`, "", [], [], true);
    expect(free).not.toContain(":heavy_plus_sign:");
    expect(askSeedMarker(free)).toBe("question");
  });

  test("ASK_OTHER_MARKERS accepts both, ➕ first", () => {
    expect([...ASK_OTHER_MARKERS]).toEqual(["heavy_plus_sign", "question"]);
  });
});

describe("❓ pills posted before ➕ still read (format)", () => {
  test("an old ❓ body parses exactly like the ➕ one, and says it was seeded with ❓", () => {
    expect(OLD).not.toBe(NEW);
    expect(OLD).toContain(":question: その他 — スレッドで返信してください");
    expect(askParseMessage(OLD)).toEqual(askParseMessage(NEW));
    expect(askParseMessage(OLD).kind).toBe("open");
    expect(askSeedMarker(OLD)).toBe("question");
    expect(askSeedMarker(NEW)).toBe("heavy_plus_sign");
    // With ℹ️ under it, too.
    expect(askParseMessage(toOld(build(true)))).toEqual(askParseMessage(build(true)));
    expect(askSeedMarker(toOld(build(true)))).toBe("question");
  });

  test("glyph spellings (hand-edited in the Slack UI) and a body with no other line", () => {
    expect(askSeedMarker(NEW.replace(":heavy_plus_sign: ", "➕ "))).toBe("heavy_plus_sign");
    expect(askSeedMarker(NEW.replace(":heavy_plus_sign: ", "❓ "))).toBe("question");
    expect(askParseMessage(NEW.replace(":heavy_plus_sign: ", "➕ ")).kind).toBe("open");
    expect(askParseMessage(NEW.replace(":heavy_plus_sign: ", "❓ ")).kind).toBe("open");
    const none = NEW.split("\n").filter((l) => !l.includes("その他")).join("\n");
    expect(askParseMessage(none).kind).toBe("open");
    expect(askSeedMarker(none)).toBe("question");
    expect(askSeedMarker("not an ask")).toBeNull();
  });

  test("a body line that opens with the last keycap does not move where the other line is read", () => {
    const tricky = askBuildText(`<@${BOB}> どれ?`, ":one: これは本文です", ["A"], [], true);
    expect(askSeedMarker(tricky)).toBe("heavy_plus_sign");
    expect(askSeedMarker(toOld(tricky))).toBe("question");
  });

  test("✅ keep drops the other line in either spelling; void salvage strips the old ❓ copy", () => {
    for (const text of [NEW, OLD]) {
      const keep = askResolvedKeep(text, 1)!;
      expect(keep).toEqual({ body: "背景: head bcb7fd8e", chosenLine: ":one: リリースする" });
      const salvage = askSalvageUnreadable(text.replace(/\n/g, " "))!;
      expect(salvage.body).not.toContain("その他");
    }
    for (const lang of ASK_LANGS) {
      const salvage = askSalvageUnreadable(toOld(build(false, lang, false)).replace(/\n/g, " "))!;
      expect(salvage.body).not.toContain(lang === "ja" ? "その他" : "Other —");
    }
  });
});

describe("➕ and ❓ pills through the CLI", { timeout: 120_000 }, () => {
  for (const [label, text, marker] of [["➕", NEW, "heavy_plus_sign"], ["❓ (old)", OLD, "question"]] as const) {
    test(`${label}: collecting a pressed pill rewrites to ✅ and swaps the ${marker} seed for ✅`, async () => {
      const m = await startMock({ inline: fx(text, [{ name: "one", users: [SELF, BOB], count: 2 }, { name: "two", users: [SELF], count: 1 }, { name: marker, users: [SELF], count: 1 }]) });
      try {
        const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0"], m.baseUrl);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe("リリースする");
        const upd = body(m.requests.find((q) => q.method === "chat.update")!).text as string;
        expect(askParseMessage(upd)).toMatchObject({ kind: "resolved", answer: "リリースする" });
        expect(upd).not.toContain("その他");
        expect(named(m, "reactions.add")).toEqual(["white_check_mark"]);
        expect(named(m, "reactions.remove")).toEqual(["one", "two", marker]);
      } finally {
        await m.stop();
      }
    });

    test(`${label}: --void takes our ${marker} seed off`, async () => {
      const m = await startMock({ inline: fx(text, seeds(marker)) });
      try {
        const base = ["ask", `--void=${CHAN}:${QTS}`, "--reason", "head moved"];
        const dry = await run(base, m.baseUrl);
        expect(dry.exitCode).toBe(1);
        const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
        expect(r.exitCode).toBe(0);
        const upd = body(m.requests.find((q) => q.method === "chat.update")!).text as string;
        expect(upd.startsWith(":no_entry_sign: ")).toBe(true);
        expect(named(m, "reactions.remove")).toEqual(["one", "two", marker]);
      } finally {
        await m.stop();
      }
    });

    test(`${label}: either other pill pressed is reported once and is not an answer`, async () => {
      for (const pressed of ["heavy_plus_sign", "question"]) {
        const reactions = seeds(marker).map((r) => r.name === pressed ? { ...r, users: [SELF, BOB], count: 2 } : r);
        if (pressed !== marker) reactions.push({ name: pressed, users: [BOB], count: 1 });
        const m = await startMock({ inline: fx(text, reactions) });
        try {
          const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0"], m.baseUrl);
          expect(r.exitCode).toBe(2);
          const glyph = pressed === "heavy_plus_sign" ? "➕" : "❓";
          expect(r.stderr.split(`<@${BOB}> が ${glyph} その他 を押しました`).length - 1).toBe(1);
          expect(m.requests.some((q) => q.method === "chat.update")).toBe(false);
        } finally {
          await m.stop();
        }
      }
    });
  }

  test("❓ (old) with ℹ️: an explain press still gets the thread note, then resolves and takes ❓ + ℹ️ off", async () => {
    const oldExplain = toOld(build(true));
    const explainBy = { name: "information_source", users: [SELF, BOB], count: 2 };
    const m1 = await startMock({ inline: fx(oldExplain, seeds("question", explainBy)) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0", "--explain-exit"], m1.baseUrl);
      expect(r.exitCode).toBe(7);
      expect(posts(m1).map((p) => p.text)).toEqual([ASK_COPY.ja.explainNote]);
    } finally {
      await m1.stop();
    }
    const note = { type: "message", user: SELF, ts: T(200), thread_ts: QTS, text: ASK_COPY.ja.explainNote };
    const two = { name: "two", users: [SELF, BOB], count: 2 };
    const m = await startMock({ inline: fx(oldExplain, [{ name: "one", users: [SELF], count: 1 }, two, { name: "question", users: [SELF], count: 1 }, explainBy], [note]) });
    try {
      const r = await run(["ask", "--waitFor", `${CHAN}:${QTS}`, "--timeout", "0"], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("見送る");
      expect(posts(m).length).toBe(0);
      expect(named(m, "reactions.remove")).toEqual(["one", "two", "question", "information_source"]);
    } finally {
      await m.stop();
    }
  });

  test("--edit of an old ❓ pill, choices unchanged: the body now lists ➕, so the seed swaps ❓ → ➕", async () => {
    const m = await startMock({ inline: fx(OLD, seeds("question")) });
    try {
      const base = ["ask", `--edit=${CHAN}:${QTS}`, `<@${BOB}> 本番に出してよい?`, "--body", "背景: head bcb7fd8e"];
      const dry = await run(base, m.baseUrl);
      expect(dry.exitCode).toBe(1);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      const upd = body(m.requests.find((q) => q.method === "chat.update")!).text as string;
      expect(askSeedMarker(upd)).toBe("heavy_plus_sign");
      expect(named(m, "reactions.add")).toEqual(["heavy_plus_sign"]);
      expect(named(m, "reactions.remove")).toEqual(["question"]);
    } finally {
      await m.stop();
    }
  });

  test("--edit of a ➕ pill, choices unchanged: no reaction is touched", async () => {
    const m = await startMock({ inline: fx(NEW, seeds("heavy_plus_sign")) });
    try {
      const base = ["ask", `--edit=${CHAN}:${QTS}`, `<@${BOB}> 本番に出してよい?`, "--body", "背景: head bcb7fd8e"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(m.requests.some((q) => q.method === "reactions.add" || q.method === "reactions.remove")).toBe(false);
    } finally {
      await m.stop();
    }
  });

  test("--edit of an old ❓ pill with new choices: ❓ comes off, the pills re-seed ending in ➕", async () => {
    const m = await startMock({ inline: fx(OLD, seeds("question")) });
    try {
      const base = ["ask", `--edit=${CHAN}:${QTS}`, `<@${BOB}> 出してよい?`, "リリースする", "見送る", "明日にする"];
      const dry = await run(base, m.baseUrl);
      const r = await run([...base, `--code=${extractCode(dry.stderr)}`], m.baseUrl);
      expect(r.exitCode).toBe(0);
      expect(named(m, "reactions.remove")).toEqual(["one", "two", "question"]);
      expect(named(m, "reactions.add")).toEqual(["one", "two", "three", "heavy_plus_sign"]);
    } finally {
      await m.stop();
    }
  });
});
