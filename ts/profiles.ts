// Multi-workspace profile management.
// Profiles are stored in ~/.config/slack-cli/profiles.json.
//
// Workspace selection uses lockfiles:
//   Local (cwd):  .slack-cli/workspace   — set with: slack workspace use <name>
//   Global (home): ~/.slack-cli/workspace — set with: slack workspace use -g <name>
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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type Profile = {
  token: string;
  team: string;
  teamId: string;
  url: string;
  user: string;
  cookie?: string; // xoxd session cookie for internal APIs (drafts, etc.)
};

type ProfileStore = {
  profiles: Record<string, Profile>;
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
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
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
  writeFileSync(filePath, lines.join("\n").trimEnd() + "\n");
}

export function listProfiles(): { name: string; profile: Profile; current: boolean }[] {
  const store = load();
  const local = readLockfile(localLockfilePath());
  const global_ = readLockfile(globalLockfilePath());
  const current = local ?? global_;
  return Object.entries(store.profiles).map(([name, profile]) => ({
    name,
    profile,
    current: name === current,
  }));
}

export function addProfile(name: string, profile: Profile): void {
  const store = load();
  store.profiles[name] = profile;
  save(store);
}

export function setCookie(name: string, cookie: string): void {
  const store = load();
  if (!(name in store.profiles)) throw new Error(`Profile not found: ${name}`);
  store.profiles[name]!.cookie = cookie;
  save(store);
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
  if (legacyEnvToken && names.length > 0) {
    // Warn only when the token differs from what's in .env.local (same value = not a real conflict)
    const envFileToken = walkDirEnv(process.cwd(), ["SLACK_BOT_TOKEN", "SLACK_MCP_XOXP_TOKEN"]);
    if (legacyEnvToken !== envFileToken) {
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
      `  Select locally:  slack workspace use <name>          (writes .slack-cli/workspace)\n` +
      `  Select globally: slack workspace use -g <name>       (writes ~/.slack-cli/workspace)`,
    );
  }

  throw new Error(
    "No Slack token found.\n" +
    "  Run one of:\n" +
    "    slack auth token    — paste an existing xoxp-/xoxb- token\n" +
    "    slack auth chrome   — import from Chrome browser (macOS)\n" +
    "    slack auth app      — guided Slack app creation\n" +
    "  Or set SLACK_TOKEN=xoxp-... in .slack-term/.env.local",
  );
}

/** Resolve the xoxd session cookie for the active workspace (best-effort). */
export function resolveCookie(workspaceFlag?: string): string | undefined {
  const store = load();
  const profiles = store.profiles;

  // --workspace flag: skip env-file walk, go straight to profiles.json
  if (workspaceFlag) return profiles[workspaceFlag]?.cookie;

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
  if (selected) return profiles[selected]?.cookie;

  const localName = readLockfile(localLockfilePath());
  if (localName) return profiles[localName]?.cookie;

  const globalName = readLockfile(globalLockfilePath());
  if (globalName) return profiles[globalName]?.cookie;

  return undefined;
}
