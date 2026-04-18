// Multi-workspace profile management.
// Profiles are stored in ~/.config/slack-cli/profiles.json.
// Resolution order:
//   1. --workspace=<name> flag or SLACK_WORKSPACE env var
//   2. profiles.current (set by `slack workspace use <name>`)
//   3. Single profile → use it automatically
//   4. Multiple profiles + no selection → throw
//   5. No profiles → fall back to SLACK_MCP_XOXP_TOKEN

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type Profile = {
  token: string;
  team: string;
  teamId: string;
  url: string;
  user: string;
};

type ProfileStore = {
  current?: string;
  profiles: Record<string, Profile>;
};

function profilesPath(): string {
  return join(homedir(), ".config", "slack-cli", "profiles.json");
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

export function listProfiles(): { name: string; profile: Profile; current: boolean }[] {
  const store = load();
  return Object.entries(store.profiles).map(([name, profile]) => ({
    name,
    profile,
    current: name === store.current,
  }));
}

export function addProfile(name: string, profile: Profile): void {
  const store = load();
  store.profiles[name] = profile;
  if (Object.keys(store.profiles).length === 1) store.current = name;
  save(store);
}

export function removeProfile(name: string): void {
  const store = load();
  if (!(name in store.profiles)) throw new Error(`Profile not found: ${name}`);
  delete store.profiles[name];
  if (store.current === name) delete store.current;
  save(store);
}

export function useProfile(name: string): void {
  const store = load();
  if (!(name in store.profiles)) throw new Error(`Profile not found: ${name}`);
  store.current = name;
  save(store);
}

export function resolveToken(workspaceFlag?: string): string {
  const store = load();
  const profiles = store.profiles;
  const names = Object.keys(profiles);

  // Explicit selection via flag or env var
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

  // No profiles → fall back to env var
  if (names.length === 0) {
    const token = process.env.SLACK_MCP_XOXP_TOKEN;
    if (!token) throw new Error("No profiles configured and SLACK_MCP_XOXP_TOKEN not set. Run: slack workspace add <name> <token>");
    return token;
  }

  // Single profile → use automatically
  if (names.length === 1) return profiles[names[0]!]!.token;

  // Multiple profiles → require explicit selection
  const current = store.current;
  if (current && profiles[current]) return profiles[current]!.token;

  throw new Error(
    `Multiple workspaces configured (${names.join(", ")}) but none selected.\n` +
      `Run: slack workspace use <name>  — or pass --workspace=<name>`,
  );
}
