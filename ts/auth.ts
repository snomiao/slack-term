// Interactive auth setup: slack auth login / slack login
import { createInterface, type Interface } from "node:readline/promises";
import { addProfile } from "./profiles.ts";
import { authTest } from "./slack.ts";
import { extractSessions } from "./slack-app.ts";

const USER_SCOPES = [
  "search:read",
  "channels:history", "groups:history", "im:history", "mpim:history",
  "channels:read", "groups:read", "im:read", "mpim:read",
  "users:read", "chat:write", "files:write",
];

const BOT_SCOPES = [
  "channels:history", "groups:history", "im:history", "mpim:history",
  "channels:read", "groups:read", "im:read", "mpim:read",
  "users:read", "chat:write", "files:write",
];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function userManifest(): string {
  return JSON.stringify(
    {
      display_information: { name: "slack-term" },
      oauth_config: { scopes: { user: USER_SCOPES } },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
    },
    null,
    2,
  );
}

function botManifest(): string {
  return JSON.stringify(
    {
      display_information: { name: "slack-term" },
      features: { bot_user: { display_name: "slack-term", always_online: false } },
      oauth_config: { scopes: { bot: BOT_SCOPES } },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
    },
    null,
    2,
  );
}

async function ask(rl: Interface, q: string): Promise<string> {
  return (await rl.question(q)).trim();
}

/** Shared logic for importing sessions from the Slack desktop app.
 *  Used by both `slack workspace import` and `slack login` option 1. */
export async function importFromDesktop(): Promise<void> {
  console.error("Scanning Slack desktop app...");
  const sessions = await extractSessions();
  if (sessions.length === 0) {
    console.error("No sessions found. Make sure Slack is installed and you have signed in at least once.");
    process.exit(1);
  }
  for (const s of sessions) {
    const teamLabel = s.teamName ?? s.teamId;
    const name = slugify(teamLabel);
    const profile = {
      token: s.token,
      team: teamLabel,
      teamId: s.teamId,
      url: s.url ?? "",
      user: "",
      ...(s.cookie ? { cookie: s.cookie } : {}),
    };
    addProfile(name, profile);
    const cookieNote = s.cookie ? " + xoxd cookie" : "";
    console.log(`Added workspace "${name}": ${teamLabel}${cookieNote}`);
  }
  console.log("");
  if (sessions.length === 1) {
    const name = slugify(sessions[0]!.teamName ?? sessions[0]!.teamId);
    console.log(`Run: slack workspace use -g ${name}`);
  } else {
    console.log("Run: slack workspace ls   then: slack workspace use -g <name>");
  }
  console.log("");
  console.log("Note: desktop app tokens (xoxc-) are internal Slack tokens.");
  console.log("If API calls fail, replace with an xoxp- user token:");
  console.log("  slack workspace set-token <name> <xoxp-token>");
}

async function loginApp(rl: Interface, mode: "user" | "bot"): Promise<void> {
  const manifest = mode === "user" ? userManifest() : botManifest();
  const tokenLabel = mode === "user" ? "User OAuth Token (xoxp-...)" : "Bot User OAuth Token (xoxb-...)";
  const expectedPrefix = mode === "user" ? "xoxp-" : "xoxb-";

  if (mode === "bot") {
    console.log("Note: bot tokens cannot use search:read (user-only scope).");
    console.log("      The news and search commands will not work with a bot token.");
    console.log("");
  }

  console.log("Step 1 — Create your Slack app:");
  console.log("  Open:  https://api.slack.com/apps");
  console.log('  Click "Create New App" → "From a manifest" → select your workspace');
  console.log("  Paste this manifest (JSON tab):");
  console.log("");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(manifest);
  console.log("─────────────────────────────────────────────────────────────");
  console.log("");
  console.log('Step 2 — Install: "Install App" → "Install to Workspace" → Authorize');
  console.log("");
  console.log(`Step 3 — Copy your token:`);
  console.log(`  OAuth & Permissions → ${tokenLabel}`);
  console.log("");

  const token = await ask(rl, "Paste your token: ");
  if (!token) {
    console.error("No token provided.");
    process.exit(1);
  }
  if (!token.startsWith(expectedPrefix)) {
    console.error(`Expected a ${expectedPrefix} token, got: ${token.slice(0, 10)}...`);
    process.exit(1);
  }

  console.error("Verifying token...");
  const info = await authTest(token);
  const defaultName = slugify(info.team);
  const nameInput = await ask(rl, `Workspace name [${defaultName}]: `);
  const name = nameInput || defaultName;

  addProfile(name, { token, ...info });
  console.log(`✓ Saved workspace "${name}": ${info.team} (${info.user})`);
  console.log(`  Run: slack workspace use -g ${name}`);
}

export async function cmdAuthLogin(): Promise<void> {
  console.log("How would you like to authenticate with Slack?");
  console.log("");
  console.log("  1) Slack desktop app — import session token");
  console.log("     Reads the xoxc- token directly from the installed app.");
  console.log("     Token: all platforms  |  xoxd cookie: macOS only");
  console.log("");
  console.log("  2) Create a Slack app — user token (xoxp-)  [recommended]");
  console.log("     Full access including search. Best for personal use.");
  console.log("");
  console.log("  3) Create a Slack app — bot token (xoxb-)");
  console.log("     Bot is invited to channels. Search and news unavailable.");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choice = await ask(rl, "Choice [1/2/3]: ");
    console.log("");

    if (choice === "1") {
      await importFromDesktop();
    } else if (choice === "2") {
      await loginApp(rl, "user");
    } else if (choice === "3") {
      await loginApp(rl, "bot");
    } else {
      console.error(`Invalid choice: "${choice}". Enter 1, 2, or 3.`);
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}
