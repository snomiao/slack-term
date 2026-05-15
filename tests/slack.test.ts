// Unit tests for ts/slack.ts against the mock server using inline fixtures.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startMock, type MockHandle } from "./mock.ts";
import * as slack from "../ts/slack.ts";

let mock: MockHandle;

const fixtures = {
  "auth.test": { ok: true, user_id: "U00000001", user: "alice", team: "Acme", team_id: "T00000001", url: "https://acme.slack.com/" },

  "conversations.history__channel=C00000001&limit=20": {
    ok: true,
    messages: [
      { type: "message", user: "U00000001", text: "hello world", ts: "1700000000.000100" },
      { type: "message", user: "U00000002", text: "reply", ts: "1700000100.000200" },
    ],
  },

  "conversations.replies__channel=C00000001&limit=50&ts=1700000000.000100": {
    ok: true,
    messages: [
      { type: "message", user: "U00000001", text: "hello world", ts: "1700000000.000100" },
      { type: "message", user: "U00000002", text: "reply", ts: "1700000100.000200" },
    ],
  },

  "search.messages__count=10&page=1&query=deploy&sort=timestamp&sort_dir=desc": {
    ok: true,
    messages: {
      matches: [
        { user: "U00000001", text: "deploy ok", ts: "1700000000.000100", channel: { id: "C00000001", name: "channel-01" } },
      ],
      paging: { count: 10, total: 1, page: 1, pages: 1 },
    },
  },

  "search.messages__count=100&page=1&query=deploy&sort=timestamp&sort_dir=desc": {
    ok: true,
    messages: {
      matches: [
        { user: "U00000001", text: "deploy ok", ts: "1700000000.000100", channel: { id: "C00000001", name: "channel-01" } },
      ],
      paging: { count: 100, total: 1, page: 1, pages: 1 },
    },
  },

  "conversations.list__limit=200&types=public_channel_private_channel_im_mpim": {
    ok: true,
    channels: [
      { id: "C00000001", name: "channel-01", is_channel: true },
      { id: "D00000001", user: "U00000002", is_im: true },
    ],
  },

  "conversations.list__exclude_archived=true&limit=200&types=public_channel_private_channel": {
    ok: true,
    channels: [{ id: "C00000001", name: "channel-01", is_channel: true }],
    response_metadata: { next_cursor: "" },
  },

  "conversations.list__exclude_archived=true&limit=200&types=im_mpim": {
    ok: true,
    channels: [{ id: "D00000001", user: "U00000002", is_im: true }],
    response_metadata: { next_cursor: "" },
  },

  "users.info__user=U00000001": {
    ok: true,
    user: { id: "U00000001", name: "alice", real_name: "Alice", profile: { display_name: "Alice A" } },
  },

  "users.info__user=U00000002": {
    ok: true,
    user: { id: "U00000002", name: "bob", real_name: "Bob", profile: { display_name: "" } },
  },

  "users.list__limit=200": {
    ok: true,
    members: [
      { id: "U00000001", name: "alice", real_name: "Alice", profile: { display_name: "Alice A" } },
      { id: "U00000002", name: "bob", real_name: "Bob", profile: { display_name: "" } },
    ],
    response_metadata: { next_cursor: "" },
  },

  "conversations.list__limit=200&types=im": {
    ok: true,
    channels: [{ id: "D00000001", user: "U00000002", is_im: true }],
    response_metadata: { next_cursor: "" },
  },

  "chat.scheduledMessages.list": {
    ok: true,
    scheduled_messages: [{ id: "Q00000001", channel_id: "C00000001", post_at: 1700100000, text: "reminder" }],
  },

  "chat.scheduledMessages.list__channel=C00000001": {
    ok: true,
    scheduled_messages: [{ id: "Q00000001", channel_id: "C00000001", post_at: 1700100000, text: "reminder" }],
  },

  "conversations.info__channel=C00000001": {
    ok: true,
    channel: { id: "C00000001", name: "channel-01" },
  },

  "conversations.info": {
    ok: true,
    channel: { id: "C00000001", name: "channel-01" },
  },

  "drafts.list": { ok: true, drafts: [] },
  "drafts.create": { ok: true, draft: { id: "D00000001" } },
  "drafts.update": { ok: true },
  "drafts.delete": { ok: true },
};

beforeAll(async () => {
  mock = await startMock({ inline: fixtures });
  process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
});

afterAll(async () => {
  await mock.stop();
  delete process.env.SLACK_API_BASE;
});

describe("slack.ts", () => {
  const token = "xoxp-fake";

  test("authTest returns team info", async () => {
    const info = await slack.authTest(token);
    expect(info.teamId).toBe("T00000001");
    expect(info.team).toBe("Acme");
    expect(info.user).toBe("alice");
  });

  test("history returns messages", async () => {
    const resp = (await slack.history(token, "C00000001", 20)) as {
      messages?: Array<{ text: string }>;
    };
    expect(resp.messages).toHaveLength(2);
    expect(resp.messages?.[0]?.text).toBe("hello world");
  });

  test("replies returns thread messages", async () => {
    const resp = (await slack.replies(token, "C00000001", "1700000000.000100", 50)) as {
      messages?: unknown[];
    };
    expect(resp.messages).toHaveLength(2);
  });

  test("search returns matches", async () => {
    const resp = (await slack.search(token, "deploy")) as {
      messages?: { matches?: unknown[] };
    };
    expect(resp.messages?.matches).toHaveLength(1);
  });

  test("searchPage honors count cap", async () => {
    const resp = (await slack.searchPage(token, "deploy", 9999, 1)) as {
      messages?: { matches?: unknown[] };
    };
    // count is capped at 100 — our fixture keyed with count=100 returns the match
    expect(resp.messages?.matches).toHaveLength(1);
  });

  test("searchAll collects pages", async () => {
    const resp = (await slack.searchAll(token, "deploy", 10)) as {
      messages?: { matches?: unknown[] };
    };
    expect(resp.messages?.matches).toHaveLength(1);
  });

  test("listConversations returns channels", async () => {
    const resp = (await slack.listConversations(token)) as {
      channels?: unknown[];
    };
    expect(resp.channels).toHaveLength(2);
  });

  test("userName returns display_name when present", async () => {
    expect(await slack.userName(token, "U00000001")).toBe("Alice A");
  });

  test("userName falls back to real_name", async () => {
    expect(await slack.userName(token, "U00000002")).toBe("Bob");
  });

  test("userName returns uid on API error", async () => {
    expect(await slack.userName(token, "U99999999")).toBe("U99999999");
  });

  test("userInfoPair returns [display, handle]", async () => {
    const [display, handle] = await slack.userInfoPair(token, "U00000001");
    expect(display).toBe("Alice A");
    expect(handle).toBe("alice");
  });

  test("userInfoPair falls back to real_name when display_name empty", async () => {
    const [display, handle] = await slack.userInfoPair(token, "U00000002");
    expect(display).toBe("Bob");
    expect(handle).toBe("bob");
  });

  test("userInfoPair returns [uid, uid] on API error", async () => {
    const [d, h] = await slack.userInfoPair(token, "U99999999");
    expect(d).toBe("U99999999");
    expect(h).toBe("U99999999");
  });

  test("resolveChannel finds public channel by name", async () => {
    const id = await slack.resolveChannel(token, "#channel-01");
    expect(id).toBe("C00000001");
  });

  test("resolveChannel finds DM by @username", async () => {
    const id = await slack.resolveChannel(token, "@bob");
    expect(id).toBe("D00000001");
  });

  test("resolveChannel rejects non-prefixed non-ID refs", async () => {
    await expect(slack.resolveChannel(token, "short")).rejects.toThrow(/must start with/);
  });

  test("resolveChannel accepts raw channel IDs", async () => {
    const id = await slack.resolveChannel(token, "C12345678");
    expect(id).toBe("C12345678");
  });

  test("resolveChannel parses Slack permalink", async () => {
    const id = await slack.resolveChannel(
      token,
      "https://app.slack.com/client/T00000001/C12345678",
    );
    expect(id).toBe("C12345678");
  });

  test("resolveChannel throws for missing channel", async () => {
    await expect(slack.resolveChannel(token, "#nonexistent")).rejects.toThrow(/not found/);
  });

  test("getPath walks nested objects and arrays", () => {
    const obj = { a: { b: [{ c: "hit" }] } };
    expect(slack.getPath(obj, ["a", "b", 0, "c"])).toBe("hit");
  });

  test("getPath returns undefined for missing path", () => {
    expect(slack.getPath({ a: 1 }, ["x", "y"])).toBeUndefined();
    expect(slack.getPath(null, ["x"])).toBeUndefined();
    expect(slack.getPath([1, 2], ["a"])).toBeUndefined();
    expect(slack.getPath({ a: [1] }, ["a", 0])).toBe(1);
    expect(slack.getPath({ a: 1 }, ["a", 0])).toBeUndefined();
  });

  test("send posts chat.postMessage and returns ts", async () => {
    const ts = await slack.send(token, "C00000001", "hi");
    expect(ts).toBe("1700000000.000100");
  });

  test("send accepts threadTs", async () => {
    const ts = await slack.send(token, "C00000001", "hi", "1700000000.000100");
    expect(ts).toBe("1700000000.000100");
  });

  test("editMessage posts chat.update and returns ts", async () => {
    const ts = await slack.editMessage(token, "C00000001", "1700000000.000100", "new text");
    expect(ts).toBe("1700000000.000100");
  });

  test("parseSlackPermalink extracts channel from app.slack.com URL", () => {
    const r = slack.parseSlackPermalink("https://app.slack.com/client/T00000001/C12345678");
    expect(r).toEqual({ channel: "C12345678" });
  });

  test("parseSlackPermalink extracts channel + ts from archives permalink", () => {
    const r = slack.parseSlackPermalink(
      "https://acme.slack.com/archives/C12345678/p1700000000000100",
    );
    expect(r).toEqual({ channel: "C12345678", ts: "1700000000.000100" });
  });

  test("parseSlackPermalink returns undefined for non-Slack URL", () => {
    expect(slack.parseSlackPermalink("https://example.com/foo")).toBeUndefined();
  });

  test("parseSlackPermalink extracts thread_ts from query params", () => {
    const r = slack.parseSlackPermalink(
      "https://acme.slack.com/archives/C12345678/p1700000000000100?thread_ts=1700000000.000100&cid=C12345678",
    );
    expect(r).toEqual({ channel: "C12345678", ts: "1700000000.000100", threadTs: "1700000000.000100" });
  });

  test("parseSlackPermalink uses cid query param as channel when present", () => {
    const r = slack.parseSlackPermalink(
      "https://acme.slack.com/archives/C12345678/p1700000000000200?thread_ts=1699000000.000100&cid=COTHER000",
    );
    expect(r).toEqual({ channel: "COTHER000", ts: "1700000000.000200", threadTs: "1699000000.000100" });
  });

  test("openDm returns channel id", async () => {
    const id = await slack.openDm(token, "U00000002");
    expect(id).toBe("C00000099");
  });

  test("call throws on API error response", async () => {
    // no fixture for this method → mock returns { ok: false, error: "no_fixture:..." }
    await expect(slack.history(token, "UNKNOWN", 1)).rejects.toThrow(/Slack error/);
  });

  test("scheduleMessage returns scheduled_message_id", async () => {
    const id = await slack.scheduleMessage(token, "C00000001", "reminder", 1700100000);
    expect(id).toBe("Q00000001");
  });

  test("scheduleMessage accepts threadTs", async () => {
    const id = await slack.scheduleMessage(token, "C00000001", "reminder", 1700100000, "1700000000.000100");
    expect(id).toBe("Q00000001");
  });

  test("listScheduledMessages returns list", async () => {
    const resp = (await slack.listScheduledMessages(token)) as { scheduled_messages?: unknown[] };
    expect(resp.scheduled_messages).toHaveLength(1);
  });

  test("listScheduledMessages filters by channel", async () => {
    const resp = (await slack.listScheduledMessages(token, "C00000001")) as { scheduled_messages?: unknown[] };
    expect(resp.scheduled_messages).toHaveLength(1);
  });

  test("deleteScheduledMessage resolves without error", async () => {
    await expect(slack.deleteScheduledMessage(token, "C00000001", "Q00000001")).resolves.toBeUndefined();
  });

  test("listUsers returns all members", async () => {
    const resp = (await slack.listUsers(token)) as { members?: unknown[] };
    expect(resp.members).toHaveLength(2);
  });

  test("userInfo returns full user object", async () => {
    const resp = (await slack.userInfo(token, "U00000001")) as { user?: { id?: string } };
    expect(resp.user?.id).toBe("U00000001");
  });

  test("conversationInfo returns channel object", async () => {
    const resp = (await slack.conversationInfo(token, "C00000001")) as { channel?: { id?: string } };
    expect(resp.channel?.id).toBe("C00000001");
  });

  test("authTestSession returns userId and teamId", async () => {
    const result = await slack.authTestSession(token);
    expect(result.teamId).toBe("T00000001");
    expect(result.userId).toBe("U00000001");
  });

  test("listDrafts returns drafts array", async () => {
    const resp = (await slack.listDrafts(token)) as { drafts?: unknown[] };
    expect(resp.drafts).toEqual([]);
  });

  test("createDraft returns draft id", async () => {
    const resp = (await slack.createDraft(token, "C00000001", "hello")) as { draft?: { id?: string } };
    expect(resp.draft?.id).toBe("D00000001");
  });

  test("updateDraft succeeds", async () => {
    const resp = (await slack.updateDraft(token, "D00000001", "C00000001", "updated")) as { ok?: boolean };
    expect(resp.ok).toBe(true);
  });

  test("deleteDraft succeeds", async () => {
    const resp = (await slack.deleteDraft(token, "D00000001")) as { ok?: boolean };
    expect(resp.ok).toBe(true);
  });

  test("conversationInfoSession returns channel via session API", async () => {
    const resp = (await slack.conversationInfoSession(token, "C00000001")) as { channel?: { id?: string } };
    expect(resp.channel?.id).toBe("C00000001");
  });

  test("uploadFile uploads and returns fileId and permalink", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpPath = "/tmp/slack-test-upload-" + Date.now() + ".txt";
    writeFileSync(tmpPath, "hello upload");
    try {
      const result = await slack.uploadFile(token, "C00000001", tmpPath, { title: "test.txt" });
      expect(result.fileId).toBe("F00000001");
      expect(result.permalink).toMatch(/slack\.com/);
    } finally {
      unlinkSync(tmpPath);
    }
  });

  test("uploadFile with threadTs and comment", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpPath = "/tmp/slack-test-upload2-" + Date.now() + ".txt";
    writeFileSync(tmpPath, "data");
    try {
      const result = await slack.uploadFile(token, "C00000001", tmpPath, {
        threadTs: "1700000000.000100",
        initialComment: "see attached",
      });
      expect(result.fileId).toBe("F00000001");
    } finally {
      unlinkSync(tmpPath);
    }
  });

  test("resolveChannel throws when user found but no DM exists", async () => {
    // alice (U00000001) is in users.list but has no DM in conversations.list (types=im)
    await expect(slack.resolveChannel(token, "@alice")).rejects.toThrow(/No existing DM/);
  });

  test("searchAll respects max limit", async () => {
    // max=1 with 1 match; all.length >= max triggers break
    const resp = (await slack.searchAll(token, "deploy", 1)) as { messages?: { matches?: unknown[] } };
    expect(resp.messages?.matches).toHaveLength(1);
  });

  test("call throws xoxc-specific error for desktop token on public API", async () => {
    const errMock = await startMock({ inline: { "auth.test": { ok: false, error: "invalid_auth" } } });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${errMock.baseUrl}/api`;
    try {
      await expect(slack.authTest("xoxc-fake")).rejects.toThrow("Desktop app token");
    } finally {
      await errMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("callSession throws hint for non-xoxc token on session API", async () => {
    const errMock = await startMock({ inline: { "drafts.list": { ok: false, error: "not_authed" } } });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${errMock.baseUrl}/api`;
    try {
      await expect(slack.listDrafts("xoxp-fake")).rejects.toThrow("requires a desktop app session token");
    } finally {
      await errMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("callSession throws cookie hint for xoxc token without cookie", async () => {
    const errMock = await startMock({ inline: { "drafts.list": { ok: false, error: "invalid_auth" } } });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${errMock.baseUrl}/api`;
    try {
      await expect(slack.listDrafts("xoxc-fake")).rejects.toThrow("xoxd session cookie");
    } finally {
      await errMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("callSession throws generic Slack error for non-auth errors", async () => {
    const errMock = await startMock({ inline: { "drafts.list": { ok: false, error: "channel_not_found" } } });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${errMock.baseUrl}/api`;
    try {
      await expect(slack.listDrafts("xoxc-fake", "xoxd-cookie")).rejects.toThrow("Slack error");
    } finally {
      await errMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("searchAll handles response missing messages key", async () => {
    const noMsgMock = await startMock({ inline: { "search.messages": { ok: true } } });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${noMsgMock.baseUrl}/api`;
    try {
      const resp = (await slack.searchAll("xoxp-fake", "anything", 10)) as {
        messages?: { matches?: unknown[] };
      };
      expect(resp.messages?.matches).toEqual([]);
    } finally {
      await noMsgMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("callSession throws RateLimitError on HTTP 429 with Retry-After header", async () => {
    const rlMock = await startMock({
      inline: {
        "drafts.list": { __status: 429, __retryAfter: 5, ok: false, error: "ratelimited" },
      },
    });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${rlMock.baseUrl}/api`;
    try {
      await expect(slack.listDrafts("xoxc-fake", "xoxd-cookie")).rejects.toSatisfy(
        (e: unknown) => e instanceof slack.RateLimitError && (e as slack.RateLimitError).retryAfter === 5,
      );
    } finally {
      await rlMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("searchAll paginates across multiple pages", async () => {
    const page2Mock = await startMock({
      inline: {
        "search.messages__count=100&page=1&query=multi&sort=timestamp&sort_dir=desc": {
          ok: true,
          messages: {
            matches: [
              { user: "U00000001", text: "page1msg", ts: "1700000001.000000", channel: { id: "C00000001", name: "ch" } },
            ],
            paging: { count: 100, total: 2, page: 1, pages: 2 },
          },
        },
        "search.messages__count=100&page=2&query=multi&sort=timestamp&sort_dir=desc": {
          ok: true,
          messages: {
            matches: [
              { user: "U00000001", text: "page2msg", ts: "1700000002.000000", channel: { id: "C00000001", name: "ch" } },
            ],
            paging: { count: 100, total: 2, page: 2, pages: 2 },
          },
        },
      },
    });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${page2Mock.baseUrl}/api`;
    try {
      const resp = (await slack.searchAll("xoxp-fake", "multi", 100)) as {
        messages?: { matches?: Array<{ text: string }> };
      };
      expect(resp.messages?.matches?.map((m) => m.text)).toEqual(["page1msg", "page2msg"]);
    } finally {
      await page2Mock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("resolveChannel paginates users.list to find user on second page", async () => {
    const pagMock = await startMock({
      inline: {
        "users.list__limit=200": {
          ok: true,
          members: [
            { id: "U00000001", name: "alice", real_name: "Alice", profile: { display_name: "" } },
          ],
          response_metadata: { next_cursor: "cursor-page2" },
        },
        "users.list__cursor=cursor-page2&limit=200": {
          ok: true,
          members: [
            { id: "U00000099", name: "carol", real_name: "Carol", profile: { display_name: "" } },
          ],
          response_metadata: { next_cursor: "" },
        },
        "conversations.list__limit=200&types=im": {
          ok: true,
          channels: [{ id: "D00000099", user: "U00000099" }],
          response_metadata: { next_cursor: "" },
        },
      },
    });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${pagMock.baseUrl}/api`;
    try {
      const id = await slack.resolveChannel("xoxp-fake", "@carol");
      expect(id).toBe("D00000099");
    } finally {
      await pagMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("clientBoot returns wsUrl and selfId", async () => {
    const bootMock = await startMock({
      inline: {
        "client.boot": { ok: true, url: "wss://rtm.slack.com/fake", self: { id: "U00000001" } },
      },
    });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${bootMock.baseUrl}/api`;
    try {
      const result = await slack.clientBoot("xoxc-fake", "xoxd-cookie");
      expect(result.wsUrl).toBe("wss://rtm.slack.com/fake");
      expect(result.selfId).toBe("U00000001");
    } finally {
      await bootMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("clientBoot throws when response has no url", async () => {
    const bootMock = await startMock({
      inline: { "client.boot": { ok: true } },
    });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${bootMock.baseUrl}/api`;
    try {
      await expect(slack.clientBoot("xoxc-fake", "xoxd-cookie")).rejects.toThrow("WebSocket URL");
    } finally {
      await bootMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });

  test("clientBoot handles missing self field", async () => {
    const bootMock = await startMock({
      inline: { "client.boot": { ok: true, url: "wss://rtm.slack.com/fake" } },
    });
    const originalBase = process.env.SLACK_API_BASE;
    process.env.SLACK_API_BASE = `${bootMock.baseUrl}/api`;
    try {
      const result = await slack.clientBoot("xoxc-fake", "xoxd-cookie");
      expect(result.wsUrl).toBe("wss://rtm.slack.com/fake");
      expect(result.selfId).toBe("");
    } finally {
      await bootMock.stop();
      process.env.SLACK_API_BASE = originalBase;
    }
  });
});
