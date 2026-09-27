// Interactive auth setup: slack auth login / slack login
import { createInterface, type Interface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { addProfile, listProfiles, setCookie, saveToEnvFile, resolveToken, resolveCookie, resolveBotToken } from "./profiles.ts";
import { authTest } from "./slack.ts";
import { extractSessions, extractChromeSessions, discoverChromeCookies, discoverFirefoxCookies } from "./slack-app.ts";

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


async function allowBrowserProfileRead(rl: Interface | undefined, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!rl) return false;
  const answer = await ask(rl, "Read local browser profiles and Slack session cookies? [y/N]: ");
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function saveToken(rl: Interface | null, token: string, nameOverride?: string, cookie?: string): Promise<string> {
  console.error("Verifying token...");
  const info = await authTest(token, cookie);
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

  // Non-interactive: always save to profiles.json (predictable, backward-compatible for scripting).
  // Interactive: ask where to save.
  let filePath: string | null = null; // null = profiles.json
  if (rl) {
    console.log("");
    console.log("Where to save the token?");
    console.log("  1) ./.env.local                  (current directory)  [default]");
    console.log("  2) ./.slack-term/.env.local       (current directory, slack-specific)");
    console.log("  3) ~/.slack-term/.env.local       (global, available everywhere)");
    console.log("  4) profiles.json                  (multi-workspace: slack auth use)");
    console.log("");
    const choice = await ask(rl, "Choice [1/2/3/4, Enter=1]: ");
    if (choice === "2") filePath = join(process.cwd(), ".slack-term", ".env.local");
    else if (choice === "3") filePath = join(homedir(), ".slack-term", ".env.local");
    else if (choice === "4") filePath = null;
    else filePath = join(process.cwd(), ".env.local"); // 1 or Enter
  }

  if (filePath === null) {
    addProfile(name, { token, ...info, ...(cookie ? { cookie } : {}) });
    console.log(`Saved workspace "${name}" to profiles.json: ${info.team} (${info.user})`);
    if (process.env.SLACK_MCP_XOXP_TOKEN) {
      console.log("");
      console.log("Warning: SLACK_MCP_XOXP_TOKEN is set — it conflicts with profiles.");
      console.log("  Unset it: unset SLACK_MCP_XOXP_TOKEN  (and remove from ~/.zshrc / ~/.bashrc)");
    } else {
      console.log(`  Run: slack auth use -g ${name}`);
    }
  } else {
    const updates: Record<string, string> = { SLACK_TOKEN: token };
    if (cookie) updates.SLACK_COOKIE = cookie;
    saveToEnvFile(filePath, updates);
    console.log(`Saved token to ${filePath}`);
    console.log(`  SLACK_TOKEN will be picked up automatically in this directory tree.`);
  }
  return name;
}

/** Shared logic for importing sessions from the Slack desktop app. */
export async function importFromDesktop(
  rl?: Interface, yes = false, browser: "auto" | "all" | "chrome" | "firefox" | "none" = "auto",
  saveProfileOnly = false,
): Promise<void> {
  console.error("Scanning Slack desktop app...");
  const sessions = await extractSessions();
  if (sessions.length === 0) {
    console.error("No sessions found. Make sure Slack is installed and you have signed in at least once.");
    process.exit(1);
  }
  if (process.platform === "linux" && browser !== "none" && sessions.some((s) => !s.cookie) && await allowBrowserProfileRead(rl, yes)) {
    const found: { source: string; profileName: string; cookie: string }[] = [];
    if (browser !== "chrome") {
      for (const candidate of discoverFirefoxCookies()) {
        found.push({ source: "Firefox", profileName: candidate.profileName, cookie: candidate.cookie });
      }
    }
    if (browser === "chrome" || browser === "all" || (browser === "auto" && found.length === 0)) {
      try {
        for (const candidate of discoverChromeCookies().candidates) {
          found.push({ source: "Chrome", profileName: candidate.profileName, cookie: candidate.cookie });
        }
      } catch (e: unknown) {
        console.error(e instanceof Error ? e.message : String(e));
      }
    }
    if (found.length === 1) {
      for (const session of sessions) session.cookie ??= found[0]!.cookie;
      console.log(`Found Slack session cookie in ${found[0]!.source} profile: ${found[0]!.profileName}`);
    } else if (found.length > 1) {
      console.log("Multiple browser sessions found. Choose one later with slack auth chrome or slack auth firefox.");
    }
    if (sessions.some((s) => !s.cookie)) {
      console.log("Desktop session needs an xoxd cookie on Linux. Run: slack auth chrome or slack auth firefox");
    }
  }

  await saveImportedSessions(sessions, rl, saveProfileOnly);
}

async function saveImportedSessions(
  sessions: import("./slack-app.ts").SlackAppSession[], rl?: Interface, saveProfileOnly = false,
): Promise<void> {
  // A session token without a cookie cannot pass auth.test yet. Save its
  // LevelDB metadata as a profile so auth firefox can attach the cookie later.
  // Single workspace + interactive + cookie: offer save-destination choice
  if (sessions.length === 1 && rl && sessions[0]?.cookie && !saveProfileOnly) {
    const s = sessions[0]!;
    const teamLabel = s.teamName ?? s.teamId;
    console.log(`Found workspace: ${teamLabel}${s.cookie ? " (+ xoxd cookie)" : ""}`);
    await saveToken(rl, s.token, slugify(teamLabel), s.cookie);
    console.log("");
    console.log("Note: desktop app tokens (xoxc-) are internal Slack tokens.");
    console.log("If API calls fail, replace with an xoxp- token: slack auth login");
    return;
  }

  // Multiple workspaces or non-interactive: save all to profiles.json
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
export async function cmdAuthChrome(opts: { workspace?: string; yes?: boolean } = {}): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.error("Chrome cookie extraction is supported on macOS and Linux.");
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

  // A Chrome xoxd session cookie only augments a desktop *user* session token (xoxc-); it has
  // no effect on a bot token (xoxb-). Attaching it to a bot profile silently does nothing and
  // user-level actions (tail @user, DMs, users.list) still fail with missing_scope /
  // cannot_dm_bot. Stop early with a pointer to a user-token workspace instead.
  const selected = profiles.find((p) => p.name === profileName)!;
  if (selected.profile.token.startsWith("xoxb-")) {
    console.error(
      `\nWorkspace "${profileName}" uses a bot token (xoxb-). A Chrome session cookie only\n` +
      `augments a user session token (xoxc-) — it has no effect on a bot token, so user-level\n` +
      `actions (tail @user, DMs, listing users) would still fail.`,
    );
    const userProfiles = profiles.filter(
      (p) => p.profile.token.startsWith("xoxc-") || p.profile.token.startsWith("xoxp-"),
    );
    if (userProfiles.length > 0) {
      console.error(`  Target a user-token workspace instead: ${userProfiles.map((p) => p.name).join(", ")}`);
      console.error(`    slack auth chrome -w ${userProfiles[0]!.name}`);
    } else {
      console.error(`  Import your Slack desktop user session instead:  slack auth login`);
    }
    process.exit(1);
  }

  if (!opts.yes && !process.stdin.isTTY) {
    console.error("Reading browser profiles requires confirmation. Re-run interactively or pass --yes.");
    process.exit(1);
  }
  const confirmRl = opts.yes ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!await allowBrowserProfileRead(confirmRl, opts.yes ?? false)) {
      console.log("Browser profile scan cancelled.");
      return;
    }
  } finally {
    confirmRl?.close();
  }
  console.log("Scanning Chrome profiles for Slack session...");
  if (process.platform === "darwin") console.log("macOS may show a dialog asking for your login password — click Allow.");

  let candidates: import("./slack-app.ts").ChromeCookieCandidate[];
  let totalProfiles: number;
  try {
    ({ candidates, totalProfiles } = discoverChromeCookies());
  } catch (e: unknown) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (candidates.length === 0) {
    console.error(`No Slack session found in Chrome (scanned ${totalProfiles} profile${totalProfiles !== 1 ? "s" : ""}). Possible reasons:`);
    if (process.platform === "darwin") console.error("  - You denied the keychain dialog (try running again and click Allow)");
    console.error("  - Chrome is not installed or has no Slack session");
    console.error("  - You're not logged in to Slack in Chrome");
    process.exit(1);
  }

  let cookie: string;
  // Always prompt when multiple Chrome profiles exist, so users can confirm the right one.
  if (candidates.length === 1 && totalProfiles <= 1) {
    cookie = candidates[0]!.cookie;
    console.log(`Found session in Chrome profile: ${candidates[0]!.profileName}`);
  } else {
    const label = candidates.length === 1
      ? `Found 1 Slack session across ${totalProfiles} Chrome profiles:`
      : `Found ${candidates.length} Slack sessions across ${totalProfiles} Chrome profiles:`;
    console.log(label);
    candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c.profileName}  [${c.profileDir}]`));
    console.log("");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const defaultChoice = candidates.length === 1 ? " [Enter=1]" : "";
    const choice = (await rl.question(`Choice [1-${candidates.length}]${defaultChoice}: `)).trim();
    rl.close();
    const idx = choice === "" && candidates.length === 1 ? 0 : parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= candidates.length) {
      console.error("Invalid choice.");
      process.exit(1);
    }
    cookie = candidates[idx]!.cookie;
  }

  setCookie(profileName, cookie);
  console.log(`Saved xoxd cookie to workspace "${profileName}".`);
  console.log(`RTM WebSocket mode is now available: slack tail @you`);
}

/**
 * Attach the xoxd session cookie from Firefox browser to an existing workspace profile.
 * Firefox stores cookies in plaintext — no keychain access needed.
 */
export async function cmdAuthFirefox(opts: { workspace?: string; yes?: boolean } = {}): Promise<void> {
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

  if (!opts.yes && !process.stdin.isTTY) {
    console.error("Reading browser profiles requires confirmation. Re-run interactively or pass --yes.");
    process.exit(1);
  }
  const confirmRl = opts.yes ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!await allowBrowserProfileRead(confirmRl, opts.yes ?? false)) {
      console.log("Browser profile scan cancelled.");
      return;
    }
  } finally {
    confirmRl?.close();
  }
  console.log("Scanning Firefox profiles for Slack session...");
  const candidates = discoverFirefoxCookies();

  if (candidates.length === 0) {
    console.error("No Slack session found in Firefox. Possible reasons:");
    console.error("  - Firefox is not installed");
    console.error("  - You are not logged in to Slack in Firefox");
    process.exit(1);
  }

  let cookie: string;
  if (candidates.length === 1) {
    cookie = candidates[0]!.cookie;
    console.log(`Found session in Firefox profile: ${candidates[0]!.profileName}`);
  } else {
    console.log("Multiple Firefox profiles have a Slack session. Choose one:");
    candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c.profileName}  [${c.profileDir}]`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const choice = (await rl.question("Choice: ")).trim();
    rl.close();
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= candidates.length) {
      console.error("Invalid choice.");
      process.exit(1);
    }
    cookie = candidates[idx]!.cookie;
  }

  setCookie(profileName, cookie);
  console.log(`Saved xoxd cookie to workspace "${profileName}".`);
  console.log(`RTM WebSocket mode is now available: slack tail @you`);
}

/** Paste an existing xoxp-/xoxb- token (non-interactive or TTY). */
export async function cmdAuthToken(opts: { token?: string; name?: string } = {}): Promise<void> {
  if (opts.token) {
    await saveToken(null, opts.token, opts.name);
    return;
  }
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const token = Buffer.concat(chunks).toString("utf8").trim();
    if (!token) { console.error("No token provided on stdin."); process.exit(1); }
    await saveToken(null, token, opts.name);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await loginExisting(rl);
  } finally {
    rl.close();
  }
}

/** Guided Slack app creation wizard (user or bot token). */
export async function cmdAuthApp(opts: { bot?: boolean } = {}): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (opts.bot !== undefined) {
      await loginNewApp(rl, opts.bot ? "bot" : "user");
      return;
    }
    console.log("Which token type?");
    console.log("  1) User token (xoxp-)  -full access including search  [default]");
    console.log("  2) Bot token  (xoxb-)  -search and news unavailable");
    console.log("");
    const choice = await ask(rl, "Choice [1/2, Enter=1]: ");
    await loginNewApp(rl, choice === "2" ? "bot" : "user");
  } finally {
    rl.close();
  }
}

/** Print the currently resolved credentials as dotenv assignments. */
export function cmdAuthTokens(opts: { workspace?: string } = {}): void {
  const format = (name: string, value: string): string => {
    if (/[\r\n]/.test(value)) throw new Error(`Invalid newline in ${name}.`);
    return `${name}=${/^[A-Za-z0-9._=-]+$/.test(value) ? value : JSON.stringify(value)}`;
  };
  const lines = [format("SLACK_TOKEN", resolveToken(opts.workspace))];
  const cookie = resolveCookie(opts.workspace);
  if (cookie) lines.push(format("SLACK_COOKIE", cookie));
  if (!opts.workspace) {
    const bot = resolveBotToken();
    if (bot) lines.push(format("SLACK_BOT_TOKEN", bot));
  }
  console.log(lines.join("\n"));
}

/** Export a selected profile for env-file based CLI use. */
export function cmdAuthSave(opts: { envfile: string; workspace?: string }): void {
  const profiles = listProfiles();
  const selected = opts.workspace
    ? profiles.find((entry) => entry.name === opts.workspace)
    : profiles.find((entry) => entry.current) ?? (profiles.length === 1 ? profiles[0] : undefined);
  if (!selected) {
    throw new Error(opts.workspace
      ? `Workspace "${opts.workspace}" not found. Run: slack auth ls`
      : "Select a workspace with slack auth use <name>, or pass --workspace <name>.");
  }
  if (!selected.profile.cookie) {
    throw new Error(`Workspace "${selected.name}" has no session cookie. Run: slack auth chrome -w ${selected.name} or slack auth firefox -w ${selected.name}`);
  }
  const filePath = resolve(opts.envfile);
  saveToEnvFile(filePath, { SLACK_TOKEN: selected.profile.token, SLACK_COOKIE: selected.profile.cookie });
  console.log(`Saved token and cookie for workspace "${selected.name}" to ${filePath}`);
}

export async function cmdAuthLogin(opts: {
  token?: string; name?: string; yes?: boolean; fromDesktop?: boolean; fromChrome?: boolean; fromFirefox?: boolean; fromAll?: boolean;
} = {}): Promise<void> {
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

  if ([opts.fromChrome, opts.fromFirefox, opts.fromAll].filter(Boolean).length > 1) {
    throw new Error("Choose only one browser source: --from-chrome, --from-firefox, or --from-all.");
  }
  if (opts.fromChrome && !opts.fromDesktop) {
    if (!opts.yes && !process.stdin.isTTY) {
      throw new Error("Reading browser profiles requires confirmation. Re-run interactively or pass --yes.");
    }
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    try {
      if (!await allowBrowserProfileRead(rl, opts.yes ?? false)) {
        console.log("Browser profile scan cancelled.");
        return;
      }
      const sessions = await extractChromeSessions();
      if (sessions.length === 0) throw new Error("No Slack session token found in Chrome profiles.");
      await saveImportedSessions(sessions, rl, true);
    } finally {
      rl?.close();
    }
    return;
  }
  if (opts.fromAll && !opts.fromDesktop) {
    if (!opts.yes && !process.stdin.isTTY) {
      throw new Error("Reading browser profiles requires confirmation. Re-run interactively or pass --yes.");
    }
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    try {
      try {
        await importFromDesktop(rl, opts.yes ?? false, "all", true);
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.startsWith("Slack desktop app LevelDB not found")) throw e;
        if (!await allowBrowserProfileRead(rl, opts.yes ?? false)) {
          console.log("Browser profile scan cancelled.");
          return;
        }
        const sessions = await extractChromeSessions();
        if (sessions.length === 0) throw new Error("No Slack session token found in Chrome profiles.");
        if (sessions.every((s) => !s.cookie)) {
          const firefox = discoverFirefoxCookies();
          if (firefox.length === 1) for (const session of sessions) session.cookie = firefox[0]!.cookie;
        }
        await saveImportedSessions(sessions, rl, true);
      }
    } finally {
      rl?.close();
    }
    return;
  }
  if (opts.fromDesktop || opts.fromChrome || opts.fromFirefox || opts.fromAll) {
    const browser = opts.fromChrome ? "chrome" : opts.fromFirefox ? "firefox" : opts.fromAll ? "all" : "none";
    if (browser !== "none" && !opts.yes && !process.stdin.isTTY) {
      throw new Error("Reading browser profiles requires confirmation. Re-run interactively or pass --yes.");
    }
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    try {
      await importFromDesktop(rl, opts.yes ?? false, browser, true);
    } finally {
      rl?.close();
    }
    return;
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
  console.log("     Token: all platforms  |  xoxd cookie: macOS, or Chrome/Firefox on Linux");
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
      await importFromDesktop(rl, opts.yes ?? false);
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
