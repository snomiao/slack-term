// Multi-workspace profile management.
// Profiles are stored in ~/.config/slack-cli/profiles.json.
//
// Workspace selection uses lockfiles:
//   Local (cwd):  .slack-cli/workspace   — set with: slack workspace use <name>
//   Global (home): ~/.slack-cli/workspace — set with: slack workspace use -g <name>
//
// Resolution order:
//   1. --workspace=<name> flag or SLACK_WORKSPACE env var
//   2. Local lockfile  (.slack-cli/workspace in cwd)
//   3. Global lockfile (~/.slack-cli/workspace)
//   4. No profiles → fall back to SLACK_MCP_XOXP_TOKEN
//   5. Otherwise → throw (no silent defaults)

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

function profilesPath(): string {
  return join(homedir(), ".config", "slack-cli", "profiles.json");
}

function localLockfilePath(): string {
  return join(process.cwd(), ".slack-cli", "workspace");
}

function globalLockfilePath(): string {
  return join(homedir(), ".slack-cli", "workspace");
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
  const envToken = process.env.SLACK_MCP_XOXP_TOKEN;

  // Conflict: env token and profiles are mutually exclusive
  if (envToken && names.length > 0) {
    throw new Error(
      "Both SLACK_MCP_XOXP_TOKEN and workspace profiles are configured — keep only one.\n" +
      "  • Unset SLACK_MCP_XOXP_TOKEN to use profiles\n" +
      "  • Or remove all profiles: slack workspace remove <name>",
    );
  }

  // Env token only (no profiles) — highest priority when unambiguous
  if (envToken) return envToken;

  // Explicit per-command selection
  const selected = workspaceFlag ?? process.env.SLACK_WORKSPACE;
  if (selected) {
    const profile = profiles[selected];
    if (!profile) {
      throw new Error(
        `Workspace "${selected}" not found. Available: ${names.join(", ") || "(none)"}`,
      );
    }
    return profile.token;
  }

  // Local lockfile (cwd)
  const localName = readLockfile(localLockfilePath());
  if (localName) {
    const profile = profiles[localName];
    if (!profile) throw new Error(`Workspace "${localName}" (from .slack-cli/workspace) not found in profiles.`);
    return profile.token;
  }

  // Global lockfile (~/.slack-cli/workspace)
  const globalName = readLockfile(globalLockfilePath());
  if (globalName) {
    const profile = profiles[globalName];
    if (!profile) throw new Error(`Workspace "${globalName}" (from ~/.slack-cli/workspace) not found in profiles.`);
    return profile.token;
  }

  // No profiles and no env token
  if (names.length === 0) {
    throw new Error("No profiles configured. Run: slack workspace add <name> <token>  — or set SLACK_MCP_XOXP_TOKEN");
  }

  // Profiles exist but none selected — never silently pick one
  throw new Error(
    `Workspace not selected (${names.join(", ")} available).\n` +
    `  Select locally:  slack workspace use <name>          (writes .slack-cli/workspace)\n` +
    `  Select globally: slack workspace use -g <name>       (writes ~/.slack-cli/workspace)`,
  );
}

/** Resolve the xoxd session cookie for the active workspace (best-effort). */
export function resolveCookie(workspaceFlag?: string): string | undefined {
  const store = load();
  const profiles = store.profiles;
  const envToken = process.env.SLACK_MCP_XOXP_TOKEN;

  // Env-only mode has no stored cookie
  if (envToken) return process.env.SLACK_MCP_XOXD_COOKIE;

  const selected = workspaceFlag ?? process.env.SLACK_WORKSPACE;
  if (selected) return profiles[selected]?.cookie;

  const localName = readLockfile(localLockfilePath());
  if (localName) return profiles[localName]?.cookie;

  const globalName = readLockfile(globalLockfilePath());
  if (globalName) return profiles[globalName]?.cookie;

  return undefined;
}
