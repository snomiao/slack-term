// Interactive auth setup: slack auth login / slack login
import { createInterface, type Interface } from "node:readline/promises";
import { addProfile, listProfiles, setCookie } from "./profiles.ts";
import { authTest } from "./slack.ts";
import { extractSessions, extractXoxdFromChrome } from "./slack-app.ts";

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

async function saveToken(rl: Interface | null, token: string, nameOverride?: string): Promise<string> {
  console.error("Verifying token...");
  const info = await authTest(token);
  const defaultName = slugify(info.team);
  let name: string;
  if (nameOverride) {
    name = nameOverride;
  } else if (rl) {
    const nameInput = await ask(rl, `Workspace name [${defaultName}]: `);
    name = nameInput || defaultName;
  } else {
    name = defaultName;
  }
  addProfile(name, { token, ...info });
  console.log(`Saved workspace "${name}": ${info.team} (${info.user})`);
  if (process.env.SLACK_MCP_XOXP_TOKEN) {
    console.log("");
    console.log("Warning: SLACK_MCP_XOXP_TOKEN is set in your environment - it conflicts with profiles.");
    console.log("  Unset it so your new profile is used:");
    console.log("    unset SLACK_MCP_XOXP_TOKEN");
    console.log("  Also remove it from your shell config (~/.zshrc, ~/.bashrc, etc.)");
  } else {
    console.log(`  Run: slack auth use -g ${name}`);
  }
  return name;
}

/** Shared logic for importing sessions from the Slack desktop app. */
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
    addProfile(name, {
      token: s.token,
      team: teamLabel,
      teamId: s.teamId,
      url: s.url ?? "",
      user: "",
      ...(s.cookie ? { cookie: s.cookie } : {}),
    });
    console.log(`Added workspace "${name}": ${teamLabel}${s.cookie ? " + xoxd cookie" : ""}`);
  }
  console.log("");
  if (sessions.length === 1) {
    const name = slugify(sessions[0]!.teamName ?? sessions[0]!.teamId);
    console.log(`Run: slack auth use -g ${name}`);
  } else {
    console.log("Run: slack auth ls   then: slack auth use -g <name>");
  }
  console.log("");
  console.log("Note: desktop app tokens (xoxc-) are internal Slack tokens.");
  console.log("If API calls fail, replace with an xoxp- user token by re-running: slack auth login");
}

async function loginExisting(rl: Interface): Promise<void> {
  console.log("Which token type does your app use?");
  console.log("");
  console.log("  1) User token (xoxp-)  -full access including search  [recommended]");
  console.log("  2) Bot token  (xoxb-)  -search and news unavailable");
  console.log("");
  const typeChoice = await ask(rl, "Choice [1/2]: ");
  const mode = typeChoice === "2" ? "bot" : "user";
  const expectedPrefix = mode === "user" ? "xoxp-" : "xoxb-";
  const tokenSection = mode === "user" ? "User OAuth Token" : "Bot User OAuth Token";

  console.log("");
  console.log("Find your token here:");
  console.log("  https://api.slack.com/apps");
  console.log("  -> Select your app -> OAuth & Permissions");
  console.log(`  -> Copy the "${tokenSection}" (starts with ${expectedPrefix})`);
  console.log("");

  const token = await ask(rl, "Paste your token: ");
  if (!token) { console.error("No token provided."); process.exit(1); }
  if (!token.startsWith(expectedPrefix)) {
    console.error(`Expected a ${expectedPrefix} token, got: ${token.slice(0, 10)}...`);
    process.exit(1);
  }
  await saveToken(rl, token);
}

async function loginNewApp(rl: Interface, mode: "user" | "bot"): Promise<void> {
  const manifest = mode === "user" ? userManifest() : botManifest();
  const tokenLabel = mode === "user" ? "User OAuth Token (xoxp-...)" : "Bot User OAuth Token (xoxb-...)";
  const expectedPrefix = mode === "user" ? "xoxp-" : "xoxb-";

  if (mode === "bot") {
    console.log("Note: bot tokens cannot use search:read (user-only scope).");
    console.log("      The news and search commands will not work with a bot token.");
    console.log("");
  }

  console.log("Step 1 -Create your Slack app:");
  console.log("  Open:  https://api.slack.com/apps");
  console.log('  Click "Create New App" -> "From a manifest" -> select your workspace');
  console.log("  Paste this manifest (JSON tab):");
  console.log("");
  console.log("-------------------------------------------------------------");
  console.log(manifest);
  console.log("-------------------------------------------------------------");
  console.log("");
  console.log('Step 2 -Install: "Install App" -> "Install to Workspace" -> Authorize');
  console.log("");
  console.log(`Step 3 -Copy your token:`);
  console.log(`  OAuth & Permissions -> ${tokenLabel}`);
  console.log("");

  const token = await ask(rl, "Paste your token: ");
  if (!token) { console.error("No token provided."); process.exit(1); }
  if (!token.startsWith(expectedPrefix)) {
    console.error(`Expected a ${expectedPrefix} token, got: ${token.slice(0, 10)}...`);
    process.exit(1);
  }
  await saveToken(rl, token);
}

/**
 * Attach the xoxd session cookie from Chrome browser to an existing workspace profile.
 *
 * When run interactively, macOS will show a system dialog asking for the login password
 * to grant access to the "Chrome Safe Storage" keychain item — click Allow.
 */
export async function cmdAuthCookie(opts: { workspace?: string } = {}): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("Chrome cookie extraction is only supported on macOS.");
    process.exit(1);
  }

  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.error("No workspaces configured. Run: slack auth login");
    process.exit(1);
  }

  let profileName: string;
  if (opts.workspace) {
    const found = profiles.find((p) => p.name === opts.workspace);
    if (!found) {
      console.error(`Workspace "${opts.workspace}" not found. Available: ${profiles.map((p) => p.name).join(", ")}`);
      process.exit(1);
    }
    profileName = opts.workspace;
  } else if (profiles.length === 1) {
    profileName = profiles[0]!.name;
  } else {
    // Multiple profiles — ask the user to pick
    const current = profiles.find((p) => p.current);
    if (current) {
      profileName = current.name;
      console.log(`Using active workspace: ${profileName}`);
    } else {
      console.log("Multiple workspaces found. Choose one:");
      profiles.forEach((p, i) => console.log(`  ${i + 1}) ${p.name}  (${p.profile.team})`));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const choice = (await rl.question("Choice: ")).trim();
      rl.close();
      const idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
        console.error("Invalid choice.");
        process.exit(1);
      }
      profileName = profiles[idx]!.name;
    }
  }

  console.log(`Extracting Chrome xoxd cookie for workspace "${profileName}"...`);
  console.log("macOS will show a dialog asking for your login password — click Allow.");

  let cookie: string | undefined;
  try {
    cookie = extractXoxdFromChrome();
  } catch (e: unknown) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (!cookie) {
    console.error("Could not extract cookie. Possible reasons:");
    console.error("  - You denied the keychain dialog (try running again and click Allow)");
    console.error("  - Chrome is not installed or has no Slack session");
    console.error("  - You're not logged in to Slack in Chrome");
    process.exit(1);
  }

  if (!cookie.startsWith("xoxd-")) {
    console.error(`Unexpected cookie value (expected xoxd- prefix): ${cookie.slice(0, 20)}...`);
    process.exit(1);
  }

  setCookie(profileName, cookie);
  console.log(`Saved xoxd cookie to workspace "${profileName}".`);
  console.log(`RTM WebSocket mode is now available: slack tail @you`);
}

export async function cmdAuthLogin(opts: { token?: string; name?: string } = {}): Promise<void> {
  // Show existing profiles if any
  const existing = listProfiles();
  if (existing.length > 0) {
    console.log("Currently logged in:");
    for (const { name, profile, current } of existing)
      console.log(`  ${current ? "*" : " "} ${name}  ${profile.team}  (${profile.user || "unknown"})`);
    console.log("");
    console.log("Adding another workspace:");
    console.log("");
  }

  // Non-interactive: token passed via --token flag or piped via stdin
  if (opts.token) {
    await saveToken(null, opts.token, opts.name);
    return;
  }

  if (!process.stdin.isTTY) {
    // Read token from stdin (piped)
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const token = Buffer.concat(chunks).toString("utf8").trim();
    if (!token) {
      console.error("No token provided on stdin.");
      process.exit(1);
    }
    await saveToken(null, token, opts.name);
    return;
  }

  console.log("How would you like to authenticate with Slack?");
  console.log("");
  console.log("  1) Slack desktop app - import session token");
  console.log("     Reads the xoxc- token directly from the installed app.");
  console.log("     Token: all platforms  |  xoxd cookie: macOS only");
  console.log("");
  console.log("  2) Connect existing Slack app  [recommended if you have one]");
  console.log("     Paste a token from an app you already created.");
  console.log("");
  console.log("  3) Create new Slack app - user token (xoxp-)");
  console.log("     Guided setup with manifest. Full access including search.");
  console.log("");
  console.log("  4) Create new Slack app - bot token (xoxb-)");
  console.log("     Bot is invited to channels. Search and news unavailable.");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choice = await ask(rl, "Choice [1/2/3/4]: ");
    console.log("");

    if (choice === "1") {
      await importFromDesktop();
    } else if (choice === "2") {
      await loginExisting(rl);
    } else if (choice === "3") {
      await loginNewApp(rl, "user");
    } else if (choice === "4") {
      await loginNewApp(rl, "bot");
    } else {
      console.error(`Invalid choice: "${choice}". Enter 1, 2, 3, or 4.`);
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}
