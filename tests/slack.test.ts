// Unit tests for ts/slack.ts against the mock server using inline fixtures.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startMock, type MockHandle } from "./mock.ts";
import * as slack from "../ts/slack.ts";

let mock: MockHandle;

const fixtures = {
  "auth.test": { ok: true, user_id: "U00000001", team_id: "T00000001" },

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

  test("resolveChannel finds public channel by name", async () => {
    const id = await slack.resolveChannel(token, "#channel-01");
    expect(id).toBe("C00000001");
  });

  test("resolveChannel finds DM by @username", async () => {
    const id = await slack.resolveChannel(token, "@bob");
    expect(id).toBe("D00000001");
  });

  test("resolveChannel rejects non-prefixed refs", async () => {
    await expect(slack.resolveChannel(token, "channel-01")).rejects.toThrow(/must start with/);
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

  test("openDm returns channel id", async () => {
    const id = await slack.openDm(token, "U00000002");
    expect(id).toBe("C00000099");
  });

  test("call throws on API error response", async () => {
    // no fixture for this method → mock returns { ok: false, error: "no_fixture:..." }
    await expect(slack.history(token, "UNKNOWN", 1)).rejects.toThrow(/Slack error/);
  });
});
