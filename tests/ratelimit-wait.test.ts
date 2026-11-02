import { afterEach, describe, expect, test } from "./harness.ts";
import { ASK_POLL, askNextPollDelay } from "../ts/ask.ts";
import { RateLimitError, setRateLimitWait, withRateLimitWait } from "../ts/slack.ts";

describe("askNextPollDelay", () => {
  test("grows by φ and holds the fast cap during the first window", () => {
    let d: number = ASK_POLL.minMs;
    for (let i = 0; i < 10; i++) d = askNextPollDelay(d, 1000);
    expect(d).toBe(ASK_POLL.fastMaxMs);
  });
  test("a long wait settles at the slow cap", () => {
    let d: number = ASK_POLL.fastMaxMs;
    for (let i = 0; i < 10; i++) d = askNextPollDelay(d, ASK_POLL.fastWindowMs + 1);
    expect(d).toBe(ASK_POLL.slowMaxMs);
  });
});

describe("withRateLimitWait", () => {
  afterEach(() => setRateLimitWait(0));
  const flaky = (n: number, retryAfter = 2) => {
    let calls = 0;
    return { fn: async () => { if (calls++ < n) throw new RateLimitError(retryAfter, "conversations.replies"); return "ok"; }, calls: () => calls };
  };
  test("waits out Retry-After and retries within the budget", async () => {
    setRateLimitWait(10);
    const slept: number[] = [];
    const f = flaky(2);
    expect(await withRateLimitWait(f.fn, async (ms) => { slept.push(ms); })).toBe("ok");
    expect(slept).toEqual([2000, 2000]);
    expect(f.calls()).toBe(3);
  });
  test("throws the RateLimitError once the budget would be exceeded", async () => {
    setRateLimitWait(3);
    const f = flaky(5);
    await expect(withRateLimitWait(f.fn, async () => {})).rejects.toBeInstanceOf(RateLimitError);
    expect(f.calls()).toBe(2);
  });
  test("budget 0 (stream, tests) never waits", async () => {
    const f = flaky(1);
    await expect(withRateLimitWait(f.fn, async () => { throw new Error("slept"); })).rejects.toBeInstanceOf(RateLimitError);
  });
  test("other errors pass straight through", async () => {
    setRateLimitWait(60);
    await expect(withRateLimitWait(async () => { throw new Error("channel_not_found"); })).rejects.toThrow("channel_not_found");
  });
});
