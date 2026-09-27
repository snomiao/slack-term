// Extract xoxc- tokens from the Slack desktop app's LevelDB (macOS/Linux/Windows).
// Reads raw .ldb/.log files with regex — works even while Slack is running (no exclusive lock).
// Also extracts the xoxd session cookie from the Slack Cookies SQLite database (macOS only).

import { readdirSync, readFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { execSync } from "node:child_process";
import { ldbDecompressedBytes } from "./leveldb.ts";

export type SlackAppSession = {
  token: string;   // xoxc-...
  cookie?: string; // xoxd-... (macOS only, from Cookies SQLite)
  teamId: string;
  teamName?: string;
  url?: string;
};

function leveldbPath(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Slack", "Local Storage", "leveldb");
  }
  if (process.platform === "linux") {
    return join(home, ".config", "Slack", "Local Storage", "leveldb");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Slack", "Local Storage", "leveldb");
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function cookiesDbPath(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Slack", "Cookies");
  }
  // Linux/Windows: cookie extraction not implemented
  return "";
}

// Encrypted cookie format (macOS Electron/Chromium v10):
//   bytes [0..3)   = "v10"
//   bytes [3..19)  = 16-byte prefix (version/key-id, shared across all cookies)
//   bytes [19..35) = 16-byte IV (shared across all cookies in this profile)
//   bytes [35..)   = AES-128-CBC ciphertext
// Key = PBKDF2(keychain_password, "saltysalt", 1003, 16, SHA1)
function decryptChromeCookie(encryptedValue: Buffer, key: Buffer): string {
  if (encryptedValue.length < 35 || encryptedValue.slice(0, 3).toString() !== "v10") {
    throw new Error("Not a v10 encrypted cookie");
  }
  const iv = encryptedValue.slice(19, 35);
  const ciphertext = encryptedValue.slice(35);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Extract the xoxd session cookie from Slack's Cookies SQLite (macOS only).
 *  Returns undefined if unavailable or decryption fails. */
export function extractXoxd(): string | undefined {
  if (process.platform !== "darwin") return undefined;

  const dbPath = cookiesDbPath();
  if (!existsSync(dbPath)) return undefined;

  let keychainPw: string;
  try {
    keychainPw = execSync(
      `security find-generic-password -w -s "Slack Safe Storage" -a "Slack Key"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trimEnd();
  } catch {
    return undefined;
  }
  const aesKey = pbkdf2Sync(keychainPw, "saltysalt", 1003, 16, "sha1");

  try {
    // Use dynamic import so bun:sqlite doesn't break on non-bun runtimes
    const { default: Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT encrypted_value FROM cookies WHERE name='d' AND host_key LIKE '%slack%'")
      .get() as { encrypted_value: Uint8Array } | null;
    db.close();
    if (!row) return undefined;
    return decryptChromeCookie(Buffer.from(row.encrypted_value), aesKey);
  } catch {
    return undefined;
  }
}

// Scan a LevelDB directory for xoxc- tokens without opening the DB exclusively
// (works while the owning app is running). Reads the raw .log/.ldb files, then
// pulls "token":"xoxc-…" plus nearby workspace url/name out of the values. .ldb
// data blocks are Snappy-compressed, so they are decompressed first.
function scanLevelDbSessions(dbPath: string): SlackAppSession[] {
  if (!existsSync(dbPath)) return [];

  const files = readdirSync(dbPath).filter((f) => f.endsWith(".ldb") || f.endsWith(".log"));
  if (files.length === 0) return [];

  // Readable text per file: .ldb data blocks are Snappy-compressed (a copy-op can
  // split "token":"xoxc-…" apart), so decompress them; .log (write-ahead log) values
  // are already plaintext JSON. Memoized — both passes below reuse it.
  const textCache = new Map<string, string>();
  const fileText = (file: string): string => {
    const cached = textCache.get(file);
    if (cached !== undefined) return cached;
    let text = "";
    try {
      const raw = readFileSync(join(dbPath, file));
      text = file.endsWith(".ldb")
        ? (ldbDecompressedBytes(raw).toString("latin1") || raw.toString("latin1"))
        : raw.toString("latin1");
    } catch {
      text = "";
    }
    textCache.set(file, text);
    return text;
  };

  const sessions = new Map<string, SlackAppSession>();

  for (const file of files) {
    const content = fileText(file);
    // Values are verbatim JSON (after decompression) — extract token + URL + name in one pass.
    for (const m of content.matchAll(/"token":"(xoxc-[^"]+)"/g)) {
      const token = m[1]!;
      const teamId = token.split("-")[1] ?? "";
      if (!teamId || token.length < 40) continue;

      // Look for workspace metadata near this token (within ±2KB)
      const start = Math.max(0, m.index! - 2000);
      const end = Math.min(content.length, m.index! + 2000);
      const ctx = content.slice(start, end);
      const urlMatch = ctx.match(/"url":"(https:\/\/[a-z0-9-]+\.slack\.com\/)"/);
      const nameMatch = ctx.match(/"(?:team_name|name)":"([^"]{2,60})"/);

      const existing = sessions.get(teamId);
      if (!existing || token.length > existing.token.length) {
        const entry: SlackAppSession = { token, teamId };
        const url = urlMatch?.[1] ?? existing?.url;
        const teamName = nameMatch?.[1] ?? existing?.teamName;
        if (url) entry.url = url;
        if (teamName) entry.teamName = teamName;
        sessions.set(teamId, entry);
      }
    }
  }

  // Second pass: for sessions still missing a name, search all file content
  // (printable-transformed) for team_name/name near the numeric team ID, then
  // fall back to a title-cased URL slug.
  const allContent = files.map((f) => fileText(f).replace(/[^\x20-\x7e]/g, " ")).join(" ");

  for (const session of sessions.values()) {
    if (session.teamName) continue;

    // Strategy 1: search for "team_name":"..." or "name":"..." near the numeric team ID.
    const idIdx = allContent.indexOf(session.teamId);
    if (idIdx !== -1) {
      const start = Math.max(0, idIdx - 500);
      const end = Math.min(allContent.length, idIdx + 500);
      const ctx = allContent.slice(start, end);
      const nameMatch = ctx.match(/"(?:team_name|name)":"([^"]{2,60})"/);
      if (nameMatch?.[1]) {
        session.teamName = nameMatch[1];
        continue;
      }
    }

    // Strategy 2: search for the workspace URL slug and look for "name":"..." near it.
    if (!session.teamName && session.url) {
      const slug = session.url.match(/https:\/\/([a-z0-9-]+)\.slack\.com\//)?.[1];
      if (slug) {
        const slugIdx = allContent.indexOf(slug);
        if (slugIdx !== -1) {
          const start = Math.max(0, slugIdx - 500);
          const end = Math.min(allContent.length, slugIdx + 500);
          const ctx = allContent.slice(start, end);
          const nameMatch = ctx.match(/"(?:team_name|name)":"([^"]{2,60})"/);
          if (nameMatch?.[1]) {
            session.teamName = nameMatch[1];
            continue;
          }
        }

        // Strategy 3: title-case the slug as a last resort.
        session.teamName = slug
          .split("-")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
      }
    }
  }

  return [...sessions.values()];
}

/**
 * Import sessions from the Slack desktop app. The xoxc token is read on all
 * platforms; the shared xoxd cookie is attached on macOS only (extractXoxd).
 */
export async function extractSessions(): Promise<SlackAppSession[]> {
  const dbPath = leveldbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Slack desktop app LevelDB not found at:\n  ${dbPath}\nIs Slack installed and opened at least once?`,
    );
  }
  const result = scanLevelDbSessions(dbPath);
  // Attach xoxd cookie to all sessions (shared — one Slack desktop app, one cookie jar)
  const xoxd = extractXoxd();
  if (xoxd) {
    for (const s of result) s.cookie = xoxd;
  }
  return result;
}

/** Chrome user-data directory (all platforms), or "" if unknown. */
function chromeUserDataDir(): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (process.platform === "linux") return join(home, ".config", "google-chrome");
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(localAppData, "Google", "Chrome", "User Data");
  }
  return "";
}

/** Account email for a Chrome profile from Local State → info_cache (never the gaia real name). */
function chromeProfileEmail(userDataDir: string, profileDir: string): string | undefined {
  try {
    const localState = JSON.parse(
      readFileSync(join(userDataDir, "Local State"), "utf8"),
    ) as { profile?: { info_cache?: Record<string, { user_name?: string }> } };
    const email = localState.profile?.info_cache?.[profileDir]?.user_name;
    return email || undefined;
  } catch {
    return undefined;
  }
}

export type ChromeSessionProfile = {
  profileDir: string;         // "Default", "Profile 3", …
  email?: string;             // account email from Local State, if known
  label: string;              // display name (nickname + email)
  sessions: SlackAppSession[]; // xoxc tokens found in this profile's LocalStorage (no cookie)
};

/**
 * Discover Slack web sessions in Chrome by scanning each profile's LocalStorage
 * LevelDB for xoxc- tokens. LocalStorage is plaintext, so this works on all
 * platforms and needs no keychain/DPAPI access — it yields tokens only. The
 * xoxd cookie is fetched separately (macOS at-rest via discoverChromeCookies,
 * or a live CDP read on other platforms).
 */
export function discoverChromeSessions(): ChromeSessionProfile[] {
  const userDataDir = chromeUserDataDir();
  if (!userDataDir || !existsSync(userDataDir)) return [];

  const profileDirs = ["Default", ...readdirSync(userDataDir).filter((d) => d.startsWith("Profile "))];
  const out: ChromeSessionProfile[] = [];
  for (const profileDir of profileDirs) {
    const dbPath = join(userDataDir, profileDir, "Local Storage", "leveldb");
    const sessions = scanLevelDbSessions(dbPath);
    if (sessions.length === 0) continue;
    const email = chromeProfileEmail(userDataDir, profileDir);
    out.push({ profileDir, ...(email ? { email } : {}), label: chromeProfileName(userDataDir, profileDir), sessions });
  }
  return out;
}

/**
 * Try both AES-128-CBC variants used across Chromium versions to decrypt a v10 cookie.
 * Returns the decrypted string if it starts with "xoxd-", otherwise undefined.
 *
 * Variant A (older Chrome):      IV = 16 spaces, ciphertext = enc[3:]
 * Variant B (newer Chrome 127+): IV = enc[19:35], ciphertext = enc[35:]
 */
function decryptV10Cookie(enc: Buffer, aesKey: Buffer): string | undefined {
  const tryDecrypt = (iv: Buffer, ciphertext: Buffer): string | undefined => {
    try {
      const decipher = createDecipheriv("aes-128-cbc", aesKey, iv);
      decipher.setAutoPadding(true);
      const result = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return result.startsWith("xoxd-") ? result : undefined;
    } catch {
      return undefined;
    }
  };

  return tryDecrypt(Buffer.alloc(16, 32), enc.slice(3))
    ?? (enc.length >= 35 ? tryDecrypt(enc.slice(19, 35), enc.slice(35)) : undefined);
}

export type ChromeCookieCandidate = {
  profileDir: string;  // "Default", "Profile 1", etc.
  profileName: string; // display name from Chrome Preferences, e.g. email address
  cookie: string;      // decrypted xoxd-...
};

/**
 * Read a human-friendly display name (nickname + email) for a Chrome profile so a bare
 * "Default"/"Profile N" is never shown alone.
 *
 * Prefers Chrome's `Local State` → profile.info_cache, which reliably carries both the
 * nickname (`name`) and account email (`user_name`); the per-profile Preferences file
 * often has neither. Only nickname + email are surfaced — the gaia real name is never read.
 */
function chromeProfileName(userDataDir: string, profileDir: string): string {
  const label = (name: string, email: string): string => {
    if (name && email) return `${name} (${email})`;
    return name || email || profileDir;
  };
  try {
    const localState = JSON.parse(
      readFileSync(join(userDataDir, "Local State"), "utf8"),
    ) as { profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> } };
    const info = localState.profile?.info_cache?.[profileDir];
    if (info && (info.name || info.user_name)) {
      return label(info.name ?? "", info.user_name ?? "");
    }
  } catch {
    // fall through to Preferences
  }
  try {
    const prefs = JSON.parse(
      readFileSync(join(userDataDir, profileDir, "Preferences"), "utf8"),
    ) as Record<string, unknown>;
    const profile = prefs.profile as Record<string, unknown> | undefined;
    return label(
      (profile?.name as string | undefined) ?? "",
      (profile?.user_name as string | undefined) ?? "",
    );
  } catch {
    return profileDir;
  }
}

/**
 * Discover all Chrome browser profiles that have a Slack xoxd cookie (macOS only).
 *
 * Requires the Chrome Safe Storage key from the system keychain. When called from an
 * interactive terminal, macOS will show a dialog asking for the login password.
 * Throws on v20 (app-bound encryption). Returns [] if keychain is inaccessible.
 */
export type ChromeDiscoveryResult = {
  candidates: ChromeCookieCandidate[];
  totalProfiles: number; // how many Chrome profile dirs were scanned
};

export function discoverChromeCookies(): ChromeDiscoveryResult {
  if (process.platform !== "darwin") return { candidates: [], totalProfiles: 0 };

  const userDataDir = join(homedir(), "Library", "Application Support", "Google", "Chrome");
  if (!existsSync(userDataDir)) return { candidates: [], totalProfiles: 0 };

  let keychainPw: string;
  try {
    keychainPw = execSync(
      `security find-generic-password -a Chrome -s "Chrome Safe Storage" -w`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trimEnd();
  } catch {
    return { candidates: [], totalProfiles: 0 };
  }
  if (!keychainPw) return { candidates: [], totalProfiles: 0 };

  const aesKey = pbkdf2Sync(keychainPw, "saltysalt", 1003, 16, "sha1");

  const profileDirs = ["Default", ...readdirSync(userDataDir).filter((d) => d.startsWith("Profile "))];
  const candidates: ChromeCookieCandidate[] = [];

  for (const profileDir of profileDirs) {
    const dbPath = join(userDataDir, profileDir, "Cookies");
    if (!existsSync(dbPath)) continue;

    const tmp = join(tmpdir(), `slack-chrome-cookies-${Date.now()}-${profileDir}.db`);
    try {
      copyFileSync(dbPath, tmp);
      const { default: Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(tmp, { readonly: true });
      const row = db
        .prepare("SELECT encrypted_value FROM cookies WHERE name='d' AND host_key LIKE '%slack%'")
        .get() as { encrypted_value: Uint8Array } | null;
      db.close();
      if (!row) continue;

      const enc = Buffer.from(row.encrypted_value);
      const prefix = enc.slice(0, 3).toString();
      if (prefix === "v10") {
        // Try both AES-128-CBC variants used by different Chromium versions:
        //   1. Standard (older Chrome):  IV = 16 spaces, ciphertext = enc[3:]
        //   2. Embedded (newer Chrome/Electron): IV = enc[19:35], ciphertext = enc[35:]
        const cookie = decryptV10Cookie(enc, aesKey);
        if (!cookie) continue; // neither format produced a valid xoxd- value
        candidates.push({ profileDir, profileName: chromeProfileName(userDataDir, profileDir), cookie });
      } else if (prefix === "v20") {
        throw new Error(
          `Chrome cookie uses v20 (app-bound AES-256-GCM) which is not supported yet. ` +
          `Prefix found: ${enc.slice(0, 4).toString("hex")}`,
        );
      } else {
        throw new Error(`Unknown cookie encryption prefix: ${enc.slice(0, 4).toString("hex")}`);
      }
    } catch (e: unknown) {
      if (e instanceof Error && (e.message.includes("app-bound") || e.message.includes("Unknown cookie"))) throw e;
      // Otherwise skip this profile
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  return { candidates, totalProfiles: profileDirs.length };
}

export type FirefoxCookieCandidate = {
  profileDir: string;  // e.g. "abc123.default-release"
  profileName: string; // display name from profiles.ini, or the dir name
  cookie: string;      // plaintext xoxd-... (Firefox stores cookies unencrypted)
};

function firefoxProfilesDir(): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Firefox", "Profiles");
  if (process.platform === "linux") return join(home, ".mozilla", "firefox");
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Mozilla", "Firefox", "Profiles");
  }
  return "";
}

/** Read Firefox profiles.ini to map profile dir names to display names. */
function firefoxProfileNames(profilesDir: string): Record<string, string> {
  const iniPath = join(dirname(profilesDir), "profiles.ini");
  const map: Record<string, string> = {};
  if (!existsSync(iniPath)) return map;
  try {
    const text = readFileSync(iniPath, "utf8");
    let currentName = "";
    let currentPath = "";
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("[")) { currentName = ""; currentPath = ""; continue; }
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim().toLowerCase();
      const val = t.slice(eq + 1).trim();
      if (key === "name") currentName = val;
      if (key === "path") currentPath = val.split(/[\\/]/).pop() ?? val;
      if (currentName && currentPath) { map[currentPath] = currentName; currentName = ""; currentPath = ""; }
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * Discover all Firefox profiles that have a Slack xoxd cookie.
 * Firefox stores cookies in plaintext — no keychain or decryption needed.
 * Returns [] if Firefox is not installed or has no Slack session.
 */
export function discoverFirefoxCookies(): FirefoxCookieCandidate[] {
  const profilesDir = firefoxProfilesDir();
  if (!profilesDir || !existsSync(profilesDir)) return [];

  const nameMap = firefoxProfileNames(profilesDir);
  const candidates: FirefoxCookieCandidate[] = [];

  let profileDirs: string[];
  try {
    profileDirs = readdirSync(profilesDir);
  } catch {
    return [];
  }

  for (const profileDir of profileDirs) {
    const dbPath = join(profilesDir, profileDir, "cookies.sqlite");
    if (!existsSync(dbPath)) continue;

    const tmp = join(tmpdir(), `slack-firefox-cookies-${Date.now()}-${profileDir}.db`);
    try {
      copyFileSync(dbPath, tmp);
      const { default: Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(tmp, { readonly: true });
      const row = db
        .prepare("SELECT value FROM moz_cookies WHERE name='d' AND host LIKE '%slack%' LIMIT 1")
        .get() as { value: string } | null;
      db.close();
      if (!row?.value || !row.value.startsWith("xoxd-")) continue;
      const profileName = nameMap[profileDir] ?? profileDir;
      candidates.push({ profileDir, profileName, cookie: row.value });
    } catch {
      // skip this profile
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  return candidates;
}
