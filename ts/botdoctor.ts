// Bot messaging diagnostics.
//
// A bot can *send* a DM with chat:write + im:write, but for an escalation DM to
// be useful the user must also be able to *reply* and the bot must be able to
// *read* that reply (im:history / im:read), and the app's Messages Tab must
// allow user messages. Slack exposes granted scopes via the X-OAuth-Scopes
// header (see slack.ts authScopes); the Messages-Tab toggle is not readable via
// the API, so we surface it as a manual step whenever messaging looks incomplete.

import { authScopes, botsInfo } from "./slack.ts";

// Scopes required to DM a user as the bot.
export const DM_SEND_SCOPES = ["chat:write", "im:write"];
// Scopes required to read the user's reply to that DM.
export const DM_REPLY_SCOPES = ["im:history", "im:read"];

export type BotMessagingDiagnosis = {
  ok: boolean; // can both send and receive replies
  canSend: boolean;
  canReceiveReplies: boolean;
  botUserId: string;
  appId: string;
  team: string;
  grantedScopes: string[];
  missingSendScopes: string[];
  missingReplyScopes: string[];
};

export async function diagnoseBotMessaging(token: string): Promise<BotMessagingDiagnosis> {
  const { userId, botId, team, scopes } = await authScopes(token);
  let appId = "";
  if (botId) {
    // app_id is best-effort: bots.info needs no extra scope, but never let a
    // lookup failure block the diagnosis itself.
    try {
      appId = (await botsInfo(token, botId)).appId;
    } catch {
      appId = "";
    }
  }
  const has = (s: string): boolean => scopes.includes(s);
  const missingSendScopes = DM_SEND_SCOPES.filter((s) => !has(s));
  const missingReplyScopes = DM_REPLY_SCOPES.filter((s) => !has(s));
  return {
    canSend: missingSendScopes.length === 0,
    canReceiveReplies: missingReplyScopes.length === 0,
    ok: missingSendScopes.length === 0 && missingReplyScopes.length === 0,
    botUserId: userId,
    appId,
    team,
    grantedScopes: scopes,
    missingSendScopes,
    missingReplyScopes,
  };
}

function detailLines(d: BotMessagingDiagnosis): string[] {
  return [
    ``,
    `  Bot user:       ${d.botUserId || "(unknown)"}`,
    `  App ID:         ${d.appId || "(unknown — bots.info unavailable)"}`,
    `  Granted scopes: ${d.grantedScopes.join(", ") || "(none reported)"}`,
  ];
}

// Human-facing guidance. `compact` drops the trailing identity/scope dump used
// by `slack doctor`. Note `ok` only means scopes are complete — the Messages Tab
// toggle ("Allow users to send messages") is NOT readable via the API, so we
// always surface it as a manual check rather than over-claiming readiness.
export function formatDiagnosis(d: BotMessagingDiagnosis, compact = false): string[] {
  const appUrl = d.appId ? `https://api.slack.com/apps/${d.appId}` : "https://api.slack.com/apps";

  if (d.ok) {
    const lines = [
      `✓ Bot DM scopes are complete (send + read replies).`,
      `  Two-way replies also require the Messages Tab, which is not API-detectable.`,
      `  If recipients see "Sending messages to this app is turned off", enable it:`,
      `  ${appUrl} → App Home → "Messages Tab" ON + "Allow users to send messages".`,
    ];
    return compact ? lines : [...lines, ...detailLines(d)];
  }

  const lines: string[] = [];
  if (!d.canSend) {
    lines.push(`⚠ This bot CANNOT send DMs — missing scope(s): ${d.missingSendScopes.join(", ")}.`);
  } else {
    lines.push(`⚠ This bot can send DMs, but the user's replies will NOT be readable.`);
  }
  lines.push(`  Make escalation DMs two-way:`);
  lines.push(`  1. ${appUrl} → App Home → enable "Messages Tab" and check`);
  lines.push(`     "Allow users to send Slash commands and messages".`);
  lines.push(`  2. OAuth & Permissions → add Bot Token Scopes: ${[...d.missingSendScopes, ...d.missingReplyScopes].join(", ")}`);
  lines.push(`  3. Reinstall the app to apply the new scopes.`);

  return compact ? lines : [...lines, ...detailLines(d)];
}
