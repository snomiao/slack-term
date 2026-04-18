import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { resolveDateMarkup, dayLabel, formatHm, formatYmdHm } from "../ts/format.ts";
import { startMock, type MockHandle } from "./mock.ts";
import { resolveMentions } from "../ts/format.ts";

describe("resolveDateMarkup", () => {
  test("replaces <!date^...> with formatted date", () => {
    const out = resolveDateMarkup("meeting at <!date^1700000000^{date_pretty}|fallback>");
    expect(out).toMatch(/^meeting at \w+, \w{3} \d{2}, \d{4}$/);
  });

  test("leaves unrelated text untouched", () => {
    expect(resolveDateMarkup("hello world")).toBe("hello world");
  });
});

describe("dayLabel", () => {
  const now = new Date("2026-04-18T12:00:00Z");

  test("returns Today for same day", () => {
    const epoch = now.getTime() / 1000;
    expect(dayLabel(epoch, now)).toBe("Today");
  });

  test("returns Yesterday for prior day", () => {
    const epoch = (now.getTime() - 86400_000) / 1000;
    expect(dayLabel(epoch, now)).toBe("Yesterday");
  });

  test("returns weekday+date for older dates", () => {
    const epoch = (now.getTime() - 5 * 86400_000) / 1000;
    expect(dayLabel(epoch, now)).toMatch(/^\w+, \w{3} \d{2}$/);
  });
});

describe("resolveMentions", () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        "users.info__user=U00000001": {
          ok: true,
          user: { id: "U00000001", name: "alice", profile: { display_name: "Alice A" } },
        },
        "users.info__user=U00000002": {
          ok: true,
          user: { id: "U00000002", name: "bob", profile: { display_name: "Bob" } },
        },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("replaces <@UID> with display name", async () => {
    const cache = new Map<string, string>();
    const out = await resolveMentions("xoxp-fake", "hi <@U00000001>", cache);
    expect(out).toBe("hi @Alice A");
    expect(cache.get("U00000001")).toBe("Alice A");
  });

  test("handles multiple mentions and <@UID|label> form", async () => {
    const cache = new Map<string, string>();
    const out = await resolveMentions(
      "xoxp-fake",
      "hey <@U00000001> and <@U00000002|display>",
      cache,
    );
    expect(out).toBe("hey @Alice A and @Bob");
  });

  test("reuses cache for subsequent mentions", async () => {
    const cache = new Map<string, string>([["U00000001", "Cached"]]);
    const out = await resolveMentions("xoxp-fake", "yo <@U00000001>", cache);
    expect(out).toBe("yo @Cached");
  });

  test("leaves text with no mentions untouched", async () => {
    const cache = new Map<string, string>();
    const out = await resolveMentions("xoxp-fake", "plain text", cache);
    expect(out).toBe("plain text");
  });
});

describe("formatHm / formatYmdHm", () => {
  test("formatHm pads hours and minutes", () => {
    const epoch = new Date("2026-04-18T03:07:00").getTime() / 1000;
    expect(formatHm(epoch)).toBe("03:07");
  });

  test("formatYmdHm returns yyyy-mm-dd HH:MM", () => {
    const epoch = new Date("2026-04-18T03:07:00").getTime() / 1000;
    expect(formatYmdHm(epoch)).toBe("2026-04-18 03:07");
  });
});
