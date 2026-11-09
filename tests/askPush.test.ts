import { describe, test, expect } from "./harness.ts";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { askPushMessage, askPushTag, laneAgent, notifyAgent, PUSH_MAX } from "../ts/askPush.ts";

const LINK = "https://acme.slack.com/archives/C00000001/p1700000000000100";

describe("askPushMessage", () => {
  test("link, answer, how and the question on one line", () => {
    const m = askPushMessage({ link: LINK, answer: "no", how: "リアクション 2️⃣", question: "<@U00000001> ok?\n1. yes", freeText: false, collected: true });
    expect(m).toBe(`[ask-answer] ${LINK} → no (リアクション 2️⃣) — collected ✅. Q: <@U00000001> ok? 1. yes`);
  });

  test("stays under ay's limit however long the question", () => {
    const m = askPushMessage({ link: LINK, answer: "a".repeat(2000), how: "reply", question: "q".repeat(5000), freeText: true });
    expect(m.length).toBeLessThanOrEqual(PUSH_MAX);
    expect(m).toContain("not a choice");
  });
});

describe("askPushTag", () => {
  const NOW = Date.parse("2026-11-08T12:00:00Z");
  test("a fresh answer is plain", () => {
    expect(askPushTag(NOW - 10 * 60_000, NOW - 60_000, NOW)).toBe("[ask-answer]");
    expect(askPushTag(NOW - 10 * 60_000, undefined, NOW)).toBe("[ask-answer]");
  });
  test("an old reply says when it was given", () => {
    expect(askPushTag(Date.parse("2026-11-02T04:41:00Z"), Date.parse("2026-11-02T04:43:00Z"), NOW)).toBe("[ask-answer, late: answered 2026-11-02 04:43 UTC]");
  });
  test("an old pill press, which has no time, says when it was asked", () => {
    expect(askPushTag(Date.parse("2026-11-02T04:41:00Z"), undefined, NOW)).toBe("[ask-answer, late: asked 2026-11-02 04:41 UTC, pressed since]");
  });
  test("the tag leads the message", () => {
    expect(askPushMessage({ link: "L", answer: "a", how: "", question: "q", freeText: false, tag: "[ask-answer, late: x]" })).toMatch(/^\[ask-answer, late: x\] L → a/);
  });
});

describe("laneAgent", () => {
  const up = () => true;
  test("the newest live agent in the same directory", () => {
    const a = [{ pid: 1, cwd: "/w/x", started_at: 1 }, { pid: 2, cwd: "/w/x", started_at: 2 }, { pid: 3, cwd: "/w/y", started_at: 3 }];
    expect(laneAgent("/w/x", a, up)).toBe(2);
    expect(laneAgent("/w/x", a, (p) => p === 1)).toBe(1);
    expect(laneAgent("/w/z", a, up)).toBeUndefined();
  });
  test("a shared directory names no lane", () => {
    const sub = join(tmpdir(), "x");
    expect(laneAgent(tmpdir(), [{ pid: 1, cwd: tmpdir() }], up)).toBeUndefined();
    expect(laneAgent(sub, [{ pid: 1, cwd: sub }], up)).toBeUndefined();
    expect(laneAgent(homedir(), [{ pid: 1, cwd: "~" }], up)).toBeUndefined();
  });
});

describe("notifyAgent", () => {
  const parents: Record<number, number> = { 300: 200, 200: 100, 100: 1 };
  test("walks up to the parent ay knows", () => {
    const tried: string[] = [];
    const run = (_c: string, a: string[]) => {
      tried.push(a[1]!);
      return a[1] === "200" ? { status: 0, stdout: "sent to pid 200", stderr: "" } : { status: 1, stdout: "", stderr: "no agent matched" };
    };
    expect(notifyAgent(300, "hi", run, (p) => parents[p] ?? 0)).toBe(200);
    expect(tried).toEqual(["300", "200"]);
  });

  test("QUEUED counts as delivered; no match anywhere is undefined", () => {
    expect(notifyAgent(300, "hi", () => ({ status: 4, stdout: "QUEUED", stderr: "" }), (p) => parents[p] ?? 0)).toBe(300);
    expect(notifyAgent(300, "hi", () => ({ status: 1, stdout: "no agent matched", stderr: "" }), (p) => parents[p] ?? 0)).toBeUndefined();
  });
});
