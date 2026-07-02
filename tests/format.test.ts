import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { resolveDateMarkup, dayLabel, formatHm, formatYmdHm } from "../ts/format.ts";
import { startMock, type MockHandle } from "./mock.ts";
import { encodeMentions, resolveMentions } from "../ts/format.ts";

describe("resolveDateMarkup", () => {
  test("replaces <!date^...> with formatted date", () => {
    const out = resolveDateMarkup("meeting at <!date^1700000000^{date_pretty}|fallback>");
    expect(out).toMatch(/^meeting at \w+, \w{3} \d{2}, \d{4}$/);
  });

  test("leaves unrelated text untouched", () => {
    expect(resolveDateMarkup("hello world")).toBe("hello world");
  });

  test("returns fallback for non-finite epoch", () => {
    const out = resolveDateMarkup(`<!date^${"9".repeat(400)}^{date_pretty}|overflow-fallback>`);
    expect(out).toBe("overflow-fallback");
  });

  test("returns 'date' when epoch is non-finite and no fallback provided", () => {
    const out = resolveDateMarkup(`<!date^${"9".repeat(400)}^{date_pretty}>`);
    expect(out).toBe("date");
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

  test("ignores UID-like tag shorter than 9 chars (not a real Slack UID)", async () => {
    const cache = new Map<string, string>();
    // "<@U1234>" — uid = "U1234" (5 chars < 9) → skipped, not replaced
    const out = await resolveMentions("xoxp-fake", "hi <@U1234>", cache);
    expect(out).toBe("hi <@U1234>");
  });

  test("handles unclosed mention tag (no closing >)", async () => {
    const cache = new Map<string, string>();
    // "hi <@U00000001" — no closing > or |, endIdx === -1 → uid = rest = "U00000001"
    const out = await resolveMentions("xoxp-fake", "hi <@U00000001", cache);
    expect(typeof out).toBe("string");
  });
});

describe("encodeMentions", () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        // Workspace users.list (step 1): alice (by name/display), and a user
        // whose only match is the profile email (exercises the email branch).
        "users.list__limit=200": {
          ok: true,
          members: [
            { id: "U_ALICE", name: "alice", real_name: "Alice Anderson", profile: { display_name: "Alice A" } },
            { id: "U_MAIL", name: "obscure", real_name: "", profile: { display_name: "", email: "specialhandle" } },
          ],
        },
        // Channel members (step 2) — a Slack Connect guest NOT in users.list.
        "conversations.members__channel=C_TEST&limit=200": {
          ok: true,
          members: ["U_GUEST"],
        },
        "users.info__user=U_GUEST": {
          ok: true,
          user: { id: "U_GUEST", name: "t.yamada19850101", profile: { display_name: "Yamada" } },
        },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("replaces a workspace handle (by name) with <@USERID>", async () => {
    const warnings: string[] = [];
    const out = await encodeMentions("xoxp-fake", "hi @alice!", "C_TEST", { warn: (m) => warnings.push(m) });
    expect(out).toBe("hi <@U_ALICE>!");
    expect(warnings).toEqual([]);
  });

  test("matches by display name (normalized)", async () => {
    // "@Alice-A" normalizes to "alicea" == display_name "Alice A"
    const out = await encodeMentions("xoxp-fake", "yo @Alice-A", "C_TEST");
    expect(out).toBe("yo <@U_ALICE>");
  });

  test("matches by profile email when name/display do not", async () => {
    const out = await encodeMentions("xoxp-fake", "ping @specialhandle here", "C_TEST");
    expect(out).toBe("ping <@U_MAIL> here");
  });

  test("resolves a Slack Connect guest via channel members", async () => {
    // Not in users.list — only reachable through conversations.members.
    const out = await encodeMentions("xoxp-fake", "cc @t.yamada19850101", "C_TEST");
    expect(out).toBe("cc <@U_GUEST>");
  });

  test("leaves unresolved handles as text and warns", async () => {
    const warnings: string[] = [];
    const out = await encodeMentions("xoxp-fake", "hey @nobody there", "C_TEST", { warn: (m) => warnings.push(m) });
    expect(out).toBe("hey @nobody there");
    expect(warnings).toEqual(["warn: unresolved mention @nobody (left as text)"]);
  });

  test("handles multiple mentions in one message", async () => {
    const out = await encodeMentions("xoxp-fake", "@alice and @t.yamada19850101 and @nobody", "C_TEST");
    expect(out).toBe("<@U_ALICE> and <@U_GUEST> and @nobody");
  });

  test("leaves an already-encoded <@USERID> mention untouched without warning", async () => {
    const warnings: string[] = [];
    const out = await encodeMentions("xoxp-fake", "<@U0EXAMPLE1> hi", "C_TEST", { warn: (m) => warnings.push(m) });
    expect(out).toBe("<@U0EXAMPLE1> hi");
    expect(warnings).toEqual([]);
  });

  test("mixes an encoded mention with a plain @handle", async () => {
    const warnings: string[] = [];
    const out = await encodeMentions("xoxp-fake", "<@U0EXAMPLE1> and @alice", "C_TEST", { warn: (m) => warnings.push(m) });
    expect(out).toBe("<@U0EXAMPLE1> and <@U_ALICE>");
    expect(warnings).toEqual([]);
  });

  test("returns text unchanged when there are no @ mentions", async () => {
    const out = await encodeMentions("xoxp-fake", "plain text, no mentions", "C_TEST");
    expect(out).toBe("plain text, no mentions");
  });

  test("does not treat the @ inside an email address as a mention", async () => {
    const out = await encodeMentions("xoxp-fake", "mail me at alice@example.com", "C_TEST");
    expect(out).toBe("mail me at alice@example.com");
  });

  test("skips channel-member lookup when no channelId is given", async () => {
    const warnings: string[] = [];
    // Guest is only resolvable via channel members; without a channel it stays text.
    const out = await encodeMentions("xoxp-fake", "@t.yamada19850101 @alice", undefined, { warn: (m) => warnings.push(m) });
    expect(out).toBe("@t.yamada19850101 <@U_ALICE>");
    expect(warnings).toEqual(["warn: unresolved mention @t.yamada19850101 (left as text)"]);
  });

  test("default warn writes to stderr without throwing", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const out = await encodeMentions("xoxp-fake", "@ghost", "C_TEST");
      expect(out).toBe("@ghost");
    } finally {
      process.stderr.write = orig;
    }
    expect(captured.join("")).toContain("unresolved mention @ghost");
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
