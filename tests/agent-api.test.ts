import { test, expect } from "./harness.ts";
import { startMock } from "./mock.ts";
import { setAgentStatus, renameAgentSession } from "../ts/slack.ts";

test("session API helpers enforce bot identity and explain bot scopes without suggesting user auth", async () => {
  const mock = await startMock({ inline: {
    "agents.sessions.setStatus": { ok: true },
    "agents.sessions.rename": { ok: false, error: "missing_scope" },
  } });
  const original = process.env.SLACK_API_BASE;
  process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  const thread = { channel_id: "C00000001", thread_ts: "1700000000.000100" };
  try {
    await expect(setAgentStatus("xoxp-fake", thread, "processing")).rejects.toThrow("user tokens are refused");
    expect(mock.requests).toHaveLength(0);
    await setAgentStatus("xoxb-fake", thread, "active");
    expect(JSON.parse(mock.requests[0]!.body)).toEqual({ ...thread, status: "active" });
    await expect(renameAgentSession("xoxb-fake", thread, "Review")).rejects.toThrow("granular bot token with chat:write");
    expect(JSON.parse(mock.requests[1]!.body)).toEqual({ ...thread, title: "Review" });
  } finally {
    if (original === undefined) delete process.env.SLACK_API_BASE;
    else process.env.SLACK_API_BASE = original;
    await mock.stop();
  }
});
