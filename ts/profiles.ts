// Multi-workspace profile management.
// Profiles are stored in ~/.config/slack-cli/profiles.json.
//
// Workspace selection uses lockfiles:
//   Local (cwd):  .slack-cli/workspace   — set with: slack auth use <name>
//   Global (home): ~/.slack-cli/workspace — set with: slack auth use -g <name>
//
// Token resolution order (no --workspace flag):
//   1. process.env SLACK_TOKEN or SLACK_BOT_TOKEN
//   2. process.env SLACK_MCP_XOXP_TOKEN (legacy, yields to profiles if any exist)
//   3. Dir walk from cwd→$HOME: .slack-term/.env.local, then .env.local (modern env-file names only)
//      Note: cli.ts loadDotenvFiles() has already loaded cwd/.env.local into process.env (#1 catches
//      that case), so the walk's extra value is finding .slack-term/ variants and parent-dir files.
//   4. ~/.slack-term/.env.local (global slack-term config)
//   5. profiles.json via SLACK_WORKSPACE / lockfiles
//   6. throw with auth help
//
//  --workspace flag skips #2-4 and goes straight to profiles.json.
//
// Note: lockfiles and profiles.json use .slack-cli/ (older name); new per-dir token storage
// uses .slack-term/ (current project name). Both coexist intentionally.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type Profile = {
  token: string;
  team: string;
  teamId: string;
  url: string;
  user: string;
  cookie?: string;   // xoxd session cookie for internal APIs (drafts, etc.)
  identity?: string; // owning user identity (e.g. account email) — groups workspaces and shares one cookie
};

/** Per-identity auth shared across all that identity's workspaces. */
export type UserAuth = {
  cookie?: string; // xoxd session cookie (workspace-agnostic — one per browser/user)
  source?: string; // where it came from, e.g. "chrome:Profile 3"
};

type ProfileStore = {
  profiles: Record<string, Profile>;
  users?: Record<string, UserAuth>; // identity -> shared auth; cookie stored here once
};

function home(): string {
  return process.env.HOME || homedir();
}

function profilesPath(): string {
  return join(home(), ".config", "slack-cli", "profiles.json");
}

function localLockfilePath(): string {
  return join(process.cwd(), ".slack-cli", "workspace");
}

function globalLockfilePath(): string {
  return join(home(), ".slack-cli", "workspace");
}

function load(): ProfileStore {
  const path = profilesPath();
  if (!existsSync(path)) return { profiles: {} };
  return JSON.parse(readFileSync(path, "utf8")) as ProfileStore;
}

function save(store: ProfileStore): void {
  const path = profilesPath();
  mkdirSync(dirname(path), { recursive: true });
  if (process.platform !== "win32" && existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function readLockfile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

function writeLockfile(path: string, name: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Protect the directory from accidental git commits.
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
  writeFileSync(path, name + "\n");
}

function parseEnvVars(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    return parseEnvVars(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

/** Walk from startDir up to $HOME checking .slack-term/.env.local then .env.local.
 * Returns first value found for any of the given keys. */
function walkDirEnv(startDir: string, keys: string[]): string | undefined {
  const homeDir = home();
  let dir = startDir;

  while (true) {
    for (const subdir of [join(dir, ".slack-term", ".env.local"), join(dir, ".env.local")]) {
      const vars = readEnvFile(subdir);
      for (const key of keys) {
        if (vars[key]) return vars[key];
      }
    }
    if (dir === homeDir) break;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Global slack-term config — separate from the walk, checked after $HOME
  const globalVars = readEnvFile(join(homeDir, ".slack-term", ".env.local"));
  for (const key of keys) {
    if (globalVars[key]) return globalVars[key];
  }

  return undefined;
}

/** Write or update KEY=VALUE entries in an env file (creates file and parent dirs as needed). */
export function saveToEnvFile(filePath: string, updates: Record<string, string>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = content ? content.split("\n") : [];
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => {
      const t = l.trim();
      return t.startsWith(key + "=") || t.startsWith(key + " =");
    });
    const newLine = `${key}=${value}`;
    if (idx !== -1) {
      lines[idx] = newLine;
    } else {
      lines.push(newLine);
    }
  }
  if (process.platform !== "win32" && existsSync(filePath)) chmodSync(filePath, 0o600);
  writeFileSync(filePath, lines.join("\n").trimEnd() + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(filePath, 0o600);
}

export function listProfiles(): { name: string; profile: Profile; current: boolean }[] {
  const store = load();
  const local = readLockfile(localLockfilePath());
  const global_ = readLockfile(globalLockfilePath());
  const current = local ?? global_;
  return Object.entries(store.profiles).map(([name, profile]) => {
    // Surface the effective cookie (own, else the identity's shared one) so
    // callers reading profile.cookie keep working after cookie hoisting.
    const cookie = cookieFor(store, name);
    return {
      name,
      profile: { ...profile, ...(cookie ? { cookie } : {}) },
      current: name === current,
    };
  });
}

export function addProfile(name: string, profile: Profile): void {
  const store = load();
  // When the profile belongs to an identity, store its cookie once at the
  // identity level (workspace-agnostic) rather than duplicating it per workspace.
  if (profile.identity && profile.cookie) {
    store.users ??= {};
    const prev = store.users[profile.identity] ?? {};
    store.users[profile.identity] = { ...prev, cookie: profile.cookie };
    const { cookie: _drop, ...rest } = profile;
    store.profiles[name] = rest;
  } else {
    store.profiles[name] = profile;
  }
  save(store);
}

export function setCookie(name: string, cookie: string): void {
  const store = load();
  const profile = store.profiles[name];
  if (!profile) throw new Error(`Profile not found: ${name}`);
  // Route through the identity's shared cookie when the workspace has one.
  if (profile.identity) {
    store.users ??= {};
    store.users[profile.identity] = { ...(store.users[profile.identity] ?? {}), cookie };
  } else {
    profile.cookie = cookie;
  }
  save(store);
}

/** Store (or refresh) the shared xoxd cookie for an identity — every workspace under it picks it up. */
export function setUserCookie(identity: string, cookie: string, source?: string): void {
  const store = load();
  store.users ??= {};
  store.users[identity] = { ...(store.users[identity] ?? {}), cookie, ...(source ? { source } : {}) };
  save(store);
}

/** Resolve the effective xoxd cookie for a workspace: its own, else its identity's shared one. */
function cookieFor(store: ProfileStore, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const profile = store.profiles[name];
  if (!profile) return undefined;
  if (profile.cookie) return profile.cookie;
  if (profile.identity) return store.users?.[profile.identity]?.cookie;
  return undefined;
}

export function removeProfile(name: string): void {
  const store = load();
  if (!(name in store.profiles)) throw new Error(`Profile not found: ${name}`);
  delete store.profiles[name];
  save(store);
}

export function useProfile(name: string, global = false): void {
  const store = load();
  if (!(name in store.profiles)) throw new Error(`Profile not found: ${name}`);
  if (global) {
    writeLockfile(globalLockfilePath(), name);
  } else {
    writeLockfile(localLockfilePath(), name);
  }
}

export function resolveToken(workspaceFlag?: string): string {
  const store = load();
  const profiles = store.profiles;
  const names = Object.keys(profiles);

  // --workspace flag: skip env-file walk, go straight to profiles.json
  if (workspaceFlag) {
    const profile = profiles[workspaceFlag];
    if (!profile) {
      throw new Error(`Workspace "${workspaceFlag}" not found. Available: ${names.join(", ") || "(none)"}`);
    }
    return profile.token;
  }

  // SLACK_TOKEN always wins — intended as an explicit per-project override.
  if (process.env.SLACK_TOKEN) return process.env.SLACK_TOKEN;

  // SLACK_BOT_TOKEN and SLACK_MCP_XOXP_TOKEN: only used when no profiles exist.
  // Bot tokens in shell env or .env files must not shadow workspace profiles.
  const legacyEnvToken = process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_MCP_XOXP_TOKEN;
  if (legacyEnvToken && names.length === 0) return legacyEnvToken;
  // A bot token (xoxb-) belongs in SLACK_BOT_TOKEN: it is how `slack ask` / --as-bot send, and
  // ~/.config/slack-cli/.env is its documented home. It never stands in for the user token, so it is
  // no conflict; warn only about a *user* token parked in the legacy variables.
  const legacyUserToken = [process.env.SLACK_BOT_TOKEN, process.env.SLACK_MCP_XOXP_TOKEN].find(
    (t) => t && !t.startsWith("xoxb-"),
  );
  if (legacyUserToken && names.length > 0) {
    // Warn only when the token differs from what's in .env.local (same value = not a real conflict)
    const envFileToken = walkDirEnv(process.cwd(), ["SLACK_BOT_TOKEN", "SLACK_MCP_XOXP_TOKEN"]);
    if (legacyUserToken !== envFileToken) {
      if (!(globalThis as Record<string, unknown>).__slackEnvWarnShown) {
        (globalThis as Record<string, unknown>).__slackEnvWarnShown = true;
        console.error(
          "Warning: SLACK_MCP_XOXP_TOKEN / SLACK_BOT_TOKEN is set but workspace profiles exist — using profiles.\n" +
          "  Migrate to SLACK_TOKEN=... or remove from your shell config.",
        );
      }
    }
  }

  // Dir walk: only SLACK_TOKEN from env files can override profiles.
  // SLACK_BOT_TOKEN in .env files yields to profiles (same as shell env).
  const walked = walkDirEnv(process.cwd(), ["SLACK_TOKEN"]);
  if (walked) return walked;

  // profiles.json via SLACK_WORKSPACE env var or lockfiles
  const selected = process.env.SLACK_WORKSPACE;
  if (selected) {
    const profile = profiles[selected];
    if (!profile) {
      throw new Error(`Workspace "${selected}" not found. Available: ${names.join(", ") || "(none)"}`);
    }
    return profile.token;
  }

  const localName = readLockfile(localLockfilePath());
  if (localName) {
    const profile = profiles[localName];
    if (!profile) throw new Error(`Workspace "${localName}" (from .slack-cli/workspace) not found in profiles.`);
    return profile.token;
  }

  const globalName = readLockfile(globalLockfilePath());
  if (globalName) {
    const profile = profiles[globalName];
    if (!profile) throw new Error(`Workspace "${globalName}" (from ~/.slack-cli/workspace) not found in profiles.`);
    return profile.token;
  }

  if (names.length > 0) {
    throw new Error(
      `Workspace not selected (${names.join(", ")} available).\n` +
      `  Select locally:  slack auth use <name>          (writes .slack-cli/workspace)\n` +
      `  Select globally: slack auth use -g <name>       (writes ~/.slack-cli/workspace)`,
    );
  }

  throw new Error(
    "No Slack token found.\n" +
    "  Run one of:\n" +
    "    slack auth login          — interactive wizard (desktop / browser / token / new app)\n" +
    "    slack auth login chrome   — import workspaces from Chrome (all platforms)\n" +
    "    slack auth cookie         — attach the xoxd cookie from Chrome (macOS/Windows)\n" +
    "    slack auth firefox        — attach the xoxd cookie from Firefox (all platforms)\n" +
    "    slack auth token --token xoxp-...   — paste an existing token\n" +
    "  Or set SLACK_TOKEN=xoxp-... in .slack-term/.env.local",
  );
}

/**
 * Resolve a bot user token (xoxb-) for sending as the app rather than as the
 * user. Reads SLACK_BOT_TOKEN from the environment — cli.ts loadDotenvFiles()
 * has already sourced ~/.config/slack-cli/.env, so a bot token configured there
 * is available here. Returns undefined when no xoxb- token is set.
 */
export function resolveBotToken(): string | undefined {
  const t = process.env.SLACK_BOT_TOKEN;
  return t && t.startsWith("xoxb-") ? t : undefined;
}

/** Resolve the xoxd session cookie for the active workspace (best-effort). */
export function resolveCookie(workspaceFlag?: string): string | undefined {
  const store = load();
  const profiles = store.profiles;

  // --workspace flag: skip env-file walk, go straight to profiles.json
  if (workspaceFlag) return cookieFor(store, workspaceFlag);

  // process.env: SLACK_COOKIE (official extension), legacy SLACK_MCP_XOXD_COOKIE
  if (process.env.SLACK_COOKIE) return process.env.SLACK_COOKIE;
  if (process.env.SLACK_MCP_XOXD_COOKIE) return process.env.SLACK_MCP_XOXD_COOKIE;

  // Legacy env-only mode (SLACK_MCP_XOXP_TOKEN set, no profiles)
  const legacyToken = process.env.SLACK_MCP_XOXP_TOKEN;
  if (legacyToken && Object.keys(profiles).length === 0) {
    return process.env.SLACK_MCP_XOXD_COOKIE;
  }

  // Dir walk for SLACK_COOKIE
  const walked = walkDirEnv(process.cwd(), ["SLACK_COOKIE"]);
  if (walked) return walked;

  // profiles.json via SLACK_WORKSPACE env var or lockfiles
  const selected = process.env.SLACK_WORKSPACE;
  if (selected) return cookieFor(store, selected);

  const localName = readLockfile(localLockfilePath());
  if (localName) return cookieFor(store, localName);

  const globalName = readLockfile(globalLockfilePath());
  if (globalName) return cookieFor(store, globalName);

  return undefined;
}
