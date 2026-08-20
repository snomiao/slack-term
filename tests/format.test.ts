import { describe, test, expect, beforeAll, afterAll } from "./harness.ts";
import { resolveDateMarkup, dayLabel, formatHm, formatYmdHm } from "../ts/format.ts";
import { startMock, type MockHandle } from "./mock.ts";
import { encodeMentions, encodeMentionsDetailed, resolveMentions, findUntaggedMentions } from "../ts/format.ts";

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
    expect(warnings).toEqual(["warn: @nobody matched no one — not tagged, sent as plain text"]);
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
    expect(warnings).toEqual(["warn: @t.yamada19850101 matched no one — not tagged, sent as plain text"]);
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
    expect(captured.join("")).toContain("@ghost matched no one");
  });
});

describe("encodeMentions — Japanese display names", () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        "users.list__limit=200": {
          ok: true,
          members: [
            { id: "U_SUZUKI", name: "h.suzuki", real_name: "鈴木 陽菜", profile: { display_name: "鈴木陽菜" } },
            { id: "U_TARO", name: "tanaka.taro", real_name: "田中 太郎", profile: { display_name: "田中太郎" } },
            // Two members whose full name is exactly 田中 → an @田中 mention is ambiguous.
            { id: "U_TANAKA1", name: "tanaka1", real_name: "田中", profile: { display_name: "田中" } },
            { id: "U_TANAKA2", name: "tanaka2", real_name: "田中", profile: { display_name: "田中" } },
            { id: "U_ALICE", name: "alice", real_name: "Alice Anderson", profile: { display_name: "Alice A" } },
            // Surname-only display name — the over-match footgun: "@山田太郎" must NOT tag this member.
            { id: "U_YAMADA", name: "yamada", real_name: "山田", profile: { display_name: "山田" } },
            // Mixed script (kanji + latin) display name — full-token capture must resolve it whole.
            { id: "U_MIX", name: "mix", real_name: "山田Taro", profile: { display_name: "山田Taro" } },
          ],
        },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("does NOT tag a surname-only member when a longer name follows (@山田太郎)", async () => {
    // "太郎" is more kanji, not a particle/honorific → the "山田" prefix must not match.
    const rep = await encodeMentionsDetailed("xoxp-fake", "@山田太郎 よろしく", undefined);
    expect(rep.text).toBe("@山田太郎 よろしく");
    expect(rep.resolved).toEqual([]);
    expect(rep.unresolved).toEqual([{ surface: "@山田太郎", reason: "no-match" }]);
  });

  test("tags a surname-only member when a honorific follows (@山田さん)", async () => {
    const out = await encodeMentions("xoxp-fake", "@山田さん おはよう", undefined);
    expect(out).toBe("<@U_YAMADA>さん おはよう");
  });

  test.each([
    "@山田たろう よろしく",     // hiragana given name
    "@山田はるか お願い",       // given name starting with the particle は
    "@山田のぞみ です",         // ...の
    "@山田もも さん",           // ...も
    "@山田はな へ",             // ...は
  ])("does NOT partial-match a surname-only member (%s)", async (input) => {
    // A sub-name prefix must never tag: given names are indistinguishable from
    // name+particle on the surface, so under-tag rather than notify the wrong 山田.
    const rep = await encodeMentionsDetailed("xoxp-fake", input, undefined);
    expect(rep.text).toBe(input);
    expect(rep.resolved).toEqual([]);
  });

  test("does NOT tag on a bare particle continuation (@鈴木陽菜は → literal)", async () => {
    // "は" could be a particle OR the start of a given name → not resolvable.
    const rep = await encodeMentionsDetailed("xoxp-fake", "@鈴木陽菜は 確認しました", undefined);
    expect(rep.text).toBe("@鈴木陽菜は 確認しました");
    expect(rep.resolved).toEqual([]);
  });

  test("captures a mixed-script name whole and resolves it (@山田Taro)", async () => {
    const out = await encodeMentions("xoxp-fake", "@山田Taro hi", undefined);
    expect(out).toBe("<@U_MIX> hi");
  });

  test("does NOT partial-capture across a separator into a surname (@山田.dev)", async () => {
    // Token is "山田.dev" (full), which matches no one — must NOT fall back to "山田".
    const rep = await encodeMentionsDetailed("xoxp-fake", "@山田.dev ping", undefined);
    expect(rep.text).toBe("@山田.dev ping");
    expect(rep.resolved).toEqual([]);
  });

  test("does NOT partial-capture a mixed-script name into a surname (@田中Taro)", async () => {
    // "田中Taro" is nobody; must not tag the ambiguous "田中" members.
    const rep = await encodeMentionsDetailed("xoxp-fake", "@田中Taro です", undefined);
    expect(rep.text).toBe("@田中Taro です");
    expect(rep.resolved).toEqual([]);
  });

  test("slices the honorific by RAW length when the name has a hyphen (@山田-Taroさん)", async () => {
    // normHandle drops the "-", so a normalized-length slice would mangle the tail;
    // the raw-length slice must leave exactly "さん".
    const out = await encodeMentions("xoxp-fake", "@山田-Taroさん 確認", undefined);
    expect(out).toBe("<@U_MIX>さん 確認");
  });

  test("resolves a kanji display name written as @名前", async () => {
    const out = await encodeMentions("xoxp-fake", "@鈴木陽菜 資料お願いします", undefined);
    expect(out).toBe("<@U_SUZUKI> 資料お願いします");
  });

  test("leaves a trailing honorific outside the tag (@名前さん)", async () => {
    const out = await encodeMentions("xoxp-fake", "@鈴木陽菜さん 確認お願いします", undefined);
    expect(out).toBe("<@U_SUZUKI>さん 確認お願いします");
  });

  test("longest-match beats a shorter ambiguous prefix (@田中太郎)", async () => {
    const out = await encodeMentions("xoxp-fake", "@田中太郎 よろしく", undefined);
    expect(out).toBe("<@U_TARO> よろしく");
  });

  test("leaves an ambiguous name literal and reports it", async () => {
    const rep = await encodeMentionsDetailed("xoxp-fake", "@田中 です", undefined);
    expect(rep.text).toBe("@田中 です");
    expect(rep.unresolved).toEqual([{ surface: "@田中", reason: "ambiguous" }]);
  });

  test("warns on an ambiguous name via the string wrapper", async () => {
    const warnings: string[] = [];
    await encodeMentions("xoxp-fake", "@田中 です", undefined, { warn: (m) => warnings.push(m) });
    expect(warnings).toEqual(["warn: @田中 matches multiple people — not tagged, sent as plain text (use <@USERID> to tag)"]);
  });

  test("an ambiguous name stays literal even with a channel (never disambiguated by membership)", async () => {
    // Fail-safe: channel membership must not be used to guess which duplicate was
    // meant. No conversations.members mock is defined — proof it is not consulted.
    const rep = await encodeMentionsDetailed("xoxp-fake", "@田中 です", "C_ANY");
    expect(rep.text).toBe("@田中 です");
    expect(rep.unresolved).toEqual([{ surface: "@田中", reason: "ambiguous" }]);
  });

  test("still resolves ASCII handles unchanged alongside kanji", async () => {
    const out = await encodeMentions("xoxp-fake", "@alice and @鈴木陽菜", undefined);
    expect(out).toBe("<@U_ALICE> and <@U_SUZUKI>");
  });

  test("detailed report lists resolved surface, display and id", async () => {
    const rep = await encodeMentionsDetailed("xoxp-fake", "@鈴木陽菜さん", undefined);
    expect(rep.resolved).toEqual([{ surface: "@鈴木陽菜", display: "鈴木陽菜", userId: "U_SUZUKI" }]);
    expect(rep.unresolved).toEqual([]);
  });
});

describe("encodeMentions — directory unavailable (missing users:read)", () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        // Simulate a bot token that lacks users:read — users.list errors out.
        "users.list__limit=200": { ok: false, error: "missing_scope" },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("does not throw; leaves mentions literal and reports them as unavailable (not no-match)", async () => {
    const rep = await encodeMentionsDetailed("xoxb-fake", "@alice @鈴木陽菜", undefined);
    expect(rep.text).toBe("@alice @鈴木陽菜");
    expect(rep.resolved).toEqual([]);
    expect(rep.unresolved).toEqual([
      { surface: "@alice", reason: "unavailable" },
      { surface: "@鈴木陽菜", reason: "unavailable" },
    ]);
  });

  test("wrapper emits a single directory-unavailable warning", async () => {
    const warnings: string[] = [];
    await encodeMentions("xoxb-fake", "@alice @bob", undefined, { warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([
      "warn: could not fetch the user list (users:read missing or an API/connection error) — @mentions not tagged, sent as plain text",
    ]);
  });
});

describe("encodeMentions — channel fallback fails (not a false no-match)", () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        // Workspace list succeeds but does not contain the handle...
        "users.list__limit=200": { ok: true, members: [{ id: "U_X", name: "someoneelse" }] },
        // ...and the channel-member fallback errors (e.g. bot not in channel).
        "conversations.members__channel=C_FAIL&limit=200": { ok: false, error: "channel_not_found" },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("a Connect-guest handle stays 'unavailable', not a definite no-match", async () => {
    // The guest can only live in the channel, whose lookup failed — so we must
    // NOT claim it matched no user; it is indeterminate.
    const rep = await encodeMentionsDetailed("xoxp-fake", "@t.guest99", "C_FAIL");
    expect(rep.text).toBe("@t.guest99");
    expect(rep.unresolved).toEqual([{ surface: "@t.guest99", reason: "unavailable" }]);
  });

  test("with the workspace list read and no channel, a miss is a true no-match", async () => {
    const rep = await encodeMentionsDetailed("xoxp-fake", "@nobody99", undefined);
    expect(rep.unresolved).toEqual([{ surface: "@nobody99", reason: "no-match" }]);
  });
});

describe("encodeMentions — ASCII duplicate names (fail-closed)", () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        "users.list__limit=200": {
          ok: true,
          members: [
            // Two distinct users sharing a real_name and display_name — a loose
            // handle match must fail-close (ambiguous), not first-match win.
            { id: "U_D1", name: "dup1", real_name: "Dup Person", profile: { display_name: "Duppy" } },
            { id: "U_D2", name: "dup2", real_name: "Dup Person", profile: { display_name: "Duppy" } },
          ],
        },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("a handle matching two users by display_name is ambiguous, not first-match", async () => {
    const rep = await encodeMentionsDetailed("xoxp-fake", "@Duppy hi", undefined);
    expect(rep.text).toBe("@Duppy hi");
    expect(rep.unresolved).toEqual([{ surface: "@Duppy", reason: "ambiguous" }]);
  });

  test("a handle matching two users by real_name is ambiguous", async () => {
    const rep = await encodeMentionsDetailed("xoxp-fake", "@DupPerson", undefined);
    expect(rep.unresolved).toEqual([{ surface: "@DupPerson", reason: "ambiguous" }]);
  });

  test("a unique handle still resolves", async () => {
    const out = await encodeMentions("xoxp-fake", "@dup1 hey", undefined);
    expect(out).toBe("<@U_D1> hey");
  });
});

describe("findUntaggedMentions", () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        "users.list__limit=200": {
          ok: true,
          members: [
            { id: "U0YAMADA", name: "yamada", real_name: "山田 太郎", profile: { display_name: "Yamada" } },
            { id: "U0KOBAYASHI", name: "kobayashi", real_name: "小林 花子", profile: { display_name: "小林" } },
            // display_name empty → exercises the real_name fallback in displayNameOf.
            { id: "U0SATO", name: "sato", real_name: "佐藤 次郎", profile: { display_name: "" } },
            // display_name + real_name empty → exercises the name fallback.
            { id: "U0KENJI", name: "kenji", real_name: "", profile: { display_name: "" } },
            { id: "U0DAVE", name: "dave", real_name: "Dave Smith", profile: { display_name: "Dave" } },
            // A bot whose name would match "工藤さん" — must be filtered out.
            { id: "U0BOT", name: "kudo", real_name: "工藤 ボット", is_bot: true, profile: { display_name: "工藤" } },
          ],
        },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  test("returns [] with no person-reference cue (no users.list fetch)", async () => {
    expect(await findUntaggedMentions("xoxp-fake", "just a normal message, nothing to see")).toEqual([]);
  });

  test("flags untagged JP honorific names that match workspace members", async () => {
    const out = await findUntaggedMentions("xoxp-fake", "山田さん 小林さん 資料お願いします");
    expect(out).toEqual([
      { surface: "山田さん", display: "Yamada", userId: "U0YAMADA" },
      { surface: "小林さん", display: "小林", userId: "U0KOBAYASHI" },
    ]);
  });

  test("rebuilds a clean surface from an over-captured run", async () => {
    const out = await findUntaggedMentions("xoxp-fake", "ご確認ください山田さん");
    expect(out).toEqual([{ surface: "山田さん", display: "Yamada", userId: "U0YAMADA" }]);
  });

  test("does not flag a member who is already <@tagged>", async () => {
    expect(await findUntaggedMentions("xoxp-fake", "<@U0YAMADA> 山田さん よろしく")).toEqual([]);
  });

  test("does not flag honorific names that match no member (third-party / external)", async () => {
    // 田中 is not a member (len-2 no-match); 林 is a single char (< 2, skipped).
    expect(await findUntaggedMentions("xoxp-fake", "田中さんに確認します。林さんも")).toEqual([]);
  });

  test("falls back to real_name / name for display", async () => {
    const out = await findUntaggedMentions("xoxp-fake", "佐藤さんと kenjiさん");
    expect(out).toEqual([
      { surface: "佐藤さん", display: "佐藤 次郎", userId: "U0SATO" },
      // Latin refs report the bare name (honorific only anchors detection).
      { surface: "kenji", display: "kenji", userId: "U0KENJI" },
    ]);
  });

  test("flags an English 'Hi <Name>' greeting", async () => {
    expect(await findUntaggedMentions("xoxp-fake", "Hi Dave, can you review this?")).toEqual([
      { surface: "Dave", display: "Dave", userId: "U0DAVE" },
    ]);
  });

  test("flags a leading '<Name>,' salutation", async () => {
    expect(await findUntaggedMentions("xoxp-fake", "Dave,\nplease take a look")).toEqual([
      { surface: "Dave", display: "Dave", userId: "U0DAVE" },
    ]);
  });

  test("dedupes repeated references to the same member", async () => {
    const out = await findUntaggedMentions("xoxp-fake", "山田さん、山田さんに伝えて");
    expect(out).toEqual([{ surface: "山田さん", display: "Yamada", userId: "U0YAMADA" }]);
  });

  test("filters out bots even when the name matches", async () => {
    expect(await findUntaggedMentions("xoxp-fake", "工藤さん おはよう")).toEqual([]);
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
