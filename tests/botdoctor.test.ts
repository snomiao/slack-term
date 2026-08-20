import { describe, test, expect, afterEach } from "./harness.ts";
import { diagnoseBotMessaging, formatDiagnosis, type BotMessagingDiagnosis } from "../ts/botdoctor.ts";
import { startMock, type MockHandle } from "./mock.ts";

// auth.test fixture with a given X-OAuth-Scopes header and optional bot_id.
function authFixture(scopes: string, botId = "B00000001") {
  return {
    "auth.test": {
      ok: true,
      user_id: "U00000BOT",
      bot_id: botId,
      team: "Acme",
      url: "https://acme.slack.com/",
      __headers: { "x-oauth-scopes": scopes },
    },
  };
}

const botsFixture = {
  "bots.info__bot=B00000001": { ok: true, bot: { app_id: "A00000001", user_id: "U00000BOT" } },
};

describe("diagnoseBotMessaging", () => {
  let mock: MockHandle;
  afterEach(async () => {
    if (mock) await mock.stop();
    delete process.env.SLACK_API_BASE;
  });

  async function withMock(inline: Record<string, unknown>): Promise<BotMessagingDiagnosis> {
    mock = await startMock({ inline });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
    return diagnoseBotMessaging("xoxb-fake");
  }

  test("all scopes present → two-way ready, resolves app_id", async () => {
    const d = await withMock({ ...authFixture("chat:write,im:write,im:history,im:read"), ...botsFixture });
    expect(d.ok).toBe(true);
    expect(d.canSend).toBe(true);
    expect(d.canReceiveReplies).toBe(true);
    expect(d.appId).toBe("A00000001");
    expect(d.botUserId).toBe("U00000BOT");
    expect(d.missingSendScopes).toEqual([]);
    expect(d.missingReplyScopes).toEqual([]);
  });

  test("missing reply scopes → can send but not receive", async () => {
    const d = await withMock({ ...authFixture("chat:write,im:write"), ...botsFixture });
    expect(d.canSend).toBe(true);
    expect(d.canReceiveReplies).toBe(false);
    expect(d.ok).toBe(false);
    expect(d.missingReplyScopes).toEqual(["im:history", "im:read"]);
  });

  test("missing send scopes → cannot send", async () => {
    const d = await withMock({ ...authFixture("im:history,im:read"), ...botsFixture });
    expect(d.canSend).toBe(false);
    expect(d.missingSendScopes).toEqual(["chat:write", "im:write"]);
  });

  test("bots.info failure leaves appId empty (best-effort)", async () => {
    // No bots.info fixture → mock returns ok:false → botsInfo throws → caught.
    const d = await withMock(authFixture("chat:write,im:write,im:history,im:read"));
    expect(d.appId).toBe("");
    expect(d.ok).toBe(true); // diagnosis still completes
  });

  test("no bot_id → skips bots.info, appId empty", async () => {
    const d = await withMock(authFixture("chat:write,im:write,im:history,im:read", ""));
    expect(d.appId).toBe("");
    expect(d.botUserId).toBe("U00000BOT");
  });

  test("auth.test error throws", async () => {
    mock = await startMock({ inline: { "auth.test": { ok: false, error: "invalid_auth" } } });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
    await expect(diagnoseBotMessaging("xoxb-bad")).rejects.toThrow("invalid_auth");
  });
});

describe("formatDiagnosis", () => {
  const base: BotMessagingDiagnosis = {
    ok: false, canSend: true, canReceiveReplies: true,
    botUserId: "U00000BOT", appId: "A00000001", team: "Acme",
    grantedScopes: ["chat:write"], missingSendScopes: [], missingReplyScopes: [],
  };

  test("ok: surfaces the non-detectable Messages Tab caveat", () => {
    const out = formatDiagnosis({ ...base, ok: true }).join("\n");
    expect(out).toContain("scopes are complete");
    expect(out).toContain("Messages Tab");
    expect(out).toContain("https://api.slack.com/apps/A00000001");
  });

  test("ok compact: drops the identity dump", () => {
    const out = formatDiagnosis({ ...base, ok: true }, true).join("\n");
    expect(out).not.toContain("Granted scopes:");
    const full = formatDiagnosis({ ...base, ok: true }, false).join("\n");
    expect(full).toContain("Granted scopes:");
    expect(full).toContain("U00000BOT");
  });

  test("missing reply scopes: warns replies unreadable + lists scopes", () => {
    const out = formatDiagnosis({
      ...base, ok: false, canReceiveReplies: false, missingReplyScopes: ["im:history", "im:read"],
    }).join("\n");
    expect(out).toContain("replies will NOT be readable");
    expect(out).toContain("im:history, im:read");
    expect(out).toContain("Reinstall");
  });

  test("cannot send: states the missing send scopes", () => {
    const out = formatDiagnosis({
      ...base, ok: false, canSend: false, missingSendScopes: ["chat:write", "im:write"],
    }).join("\n");
    expect(out).toContain("CANNOT send DMs");
    expect(out).toContain("chat:write, im:write");
  });

  test("empty appId falls back to the generic apps URL", () => {
    const out = formatDiagnosis({ ...base, ok: true, appId: "" }).join("\n");
    expect(out).toContain("https://api.slack.com/apps →");
  });

  test("full report fills in placeholders when identity/scopes are empty", () => {
    const out = formatDiagnosis({ ...base, ok: true, botUserId: "", grantedScopes: [] }, false).join("\n");
    expect(out).toContain("Bot user:       (unknown)");
    expect(out).toContain("Granted scopes: (none reported)");
  });

  test("missing-scope guidance has a compact form (no identity dump)", () => {
    const d = { ...base, ok: false, canReceiveReplies: false, missingReplyScopes: ["im:history", "im:read"] };
    const compact = formatDiagnosis(d, true).join("\n");
    const full = formatDiagnosis(d, false).join("\n");
    expect(compact).toContain("Reinstall");
    expect(compact).not.toContain("Granted scopes:");
    expect(full).toContain("Granted scopes:");
  });
});
