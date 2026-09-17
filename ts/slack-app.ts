// Extract xoxc- tokens from the Slack desktop app's LevelDB (macOS/Linux/Windows).
// Reads raw .ldb/.log files with regex — works even while Slack is running (no exclusive lock).
// Also extracts the xoxd session cookie from the Slack Cookies SQLite database (macOS only).

import { readdirSync, readFileSync, existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pbkdf2Sync, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";

export type SlackAppSession = {
  token: string;   // xoxc-...
  cookie?: string; // xoxd-... (macOS only, from Cookies SQLite)
  teamId: string;
  teamName?: string;
  url?: string;
};

function leveldbPaths(): string[] {
  const home = process.env.HOME ?? homedir();
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", "Slack", "Local Storage", "leveldb")];
  }
  if (process.platform === "linux") {
    return [
      join(home, ".config", "Slack", "Local Storage", "leveldb"),
      join(home, "snap", "slack", "current", ".config", "Slack", "Local Storage", "leveldb"),
      join(home, ".var", "app", "com.slack.Slack", "config", "Slack", "Local Storage", "leveldb"),
    ];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Slack", "Local Storage", "leveldb")];
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function cookiesDbPath(): string {
  const home = process.env.HOME ?? homedir();
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

// Scan raw LevelDB files for xoxc- tokens without opening the DB exclusively.
// Works while Slack is running.
//
// Strategy:
//  1. .log files (write-ahead log): values are stored as readable JSON strings.
//     Scan for "token":"xoxc-..." to get complete, clean tokens + workspace URL.
//  2. .ldb files (sorted tables): values are length-prefixed with binary framing
//     bytes that can split the token mid-segment. Use gap-bridging as fallback.
export async function extractSessions(leveldbOverride?: string): Promise<SlackAppSession[]> {
  const dbPath = leveldbOverride ?? leveldbPaths().find(existsSync);
  if (!dbPath) {
    throw new Error(
      `Slack desktop app LevelDB not found at:\n  ${leveldbPaths().join("\n  ")}\nIs Slack installed and opened at least once?`,
    );
  }

  const files = readdirSync(dbPath).filter((f) => f.endsWith(".ldb") || f.endsWith(".log"));
  if (files.length === 0) throw new Error(`No LevelDB data files found in ${dbPath}`);

  const sessions = new Map<string, SlackAppSession>();

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dbPath, file), "latin1");
    } catch {
      continue;
    }

    if (file.endsWith(".log")) {
      // .log files store JSON values verbatim — extract complete token + URL + name in one pass.
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
    } else {
      // .ldb files: binary framing bytes split the token mid-segment.
      // Match the first 3 numeric segments, then bridge over binary bytes to find the rest.
      for (const m of content.matchAll(/xoxc-(\d+)-(\d+)-(\d+)/g)) {
        const teamId = m[1]!;
        // Skip if already found in a .log file (prefer clean .log data)
        if (sessions.has(teamId)) continue;

        let i = m.index! + m[0].length;
        const limit = Math.min(i + 10, content.length);
        while (i < limit && (content.charCodeAt(i) < 0x30 || content.charCodeAt(i) > 0x39)) i++;

        let seg3tail = "";
        while (i < content.length && content.charCodeAt(i) >= 0x30 && content.charCodeAt(i) <= 0x39) {
          seg3tail += content[i++];
        }
        if (content[i] !== "-") continue;
        i++;
        let hex = "";
        while (i < content.length) {
          const code = content.charCodeAt(i);
          if ((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66)) {
            hex += content[i++];
          } else break;
        }
        if (hex.length < 20) continue;

        const token = `${m[0]}${seg3tail}-${hex}`;
        sessions.set(teamId, { token, teamId });
      }
    }
  }

  // Second pass: for sessions still missing a name, search all file content
  // (printable-transformed) for team_name/name near the numeric team ID, then
  // fall back to a title-cased URL slug.
  const allFiles = readdirSync(dbPath).filter((f) => f.endsWith(".ldb") || f.endsWith(".log"));
  const allContent = allFiles
    .map((f) => {
      try {
        // Replace non-printable bytes with spaces to expose readable text in binary ldb frames.
        return readFileSync(join(dbPath, f), "latin1").replace(/[^\x20-\x7e]/g, " ");
      } catch {
        return "";
      }
    })
    .join(" ");

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

  // Attach xoxd cookie to all sessions (shared — one Slack desktop app, one cookie jar)
  const xoxd = leveldbOverride ? undefined : extractXoxd();
  const result = [...sessions.values()];
  if (xoxd) {
    for (const s of result) s.cookie = xoxd;
  }
  return result;
}

/**
 * Try both AES-128-CBC layouts for a versioned Chromium cookie.
 * Returns the decrypted string if it starts with "xoxd-", otherwise undefined.
 *
 * Variant A (older Chrome):      IV = 16 spaces, ciphertext = enc[3:]
 * Variant B (newer Chrome 127+): IV = enc[19:35], ciphertext = enc[35:]
 */
function decryptV10Cookie(enc: Buffer, aesKey: Buffer, hostKey: string, allowEmbedded = false): string | undefined {
  const tryDecrypt = (iv: Buffer, ciphertext: Buffer): string | undefined => {
    try {
      const decipher = createDecipheriv("aes-128-cbc", aesKey, iv);
      decipher.setAutoPadding(true);
      const result = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (result.subarray(0, 5).toString() === "xoxd-") return result.toString("utf8");
      if (result.length >= 37) {
        const hostHash = createHash("sha256").update(hostKey).digest();
        if (timingSafeEqual(result.subarray(0, 32), hostHash)) {
          const value = result.subarray(32).toString("utf8");
          if (value.startsWith("xoxd-")) return value;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  return tryDecrypt(Buffer.alloc(16, 32), enc.slice(3))
    ?? (allowEmbedded && enc.length >= 35 ? tryDecrypt(enc.slice(19, 35), enc.slice(35)) : undefined);
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

/** Discover Slack cookies in Chrome profiles on macOS and Linux. */
export type ChromeDiscoveryResult = {
  candidates: ChromeCookieCandidate[];
  totalProfiles: number;
};

function chromeUserDataDir(): string {
  const home = process.env.HOME ?? homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (process.platform === "linux") return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "google-chrome");
  return "";
}

function linuxChromePassword(): string | undefined {
  try {
    const password = execFileSync("secret-tool", ["lookup", "application", "chrome"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
    return password || undefined;
  } catch {
    return undefined;
  }
}

export function discoverChromeCookies(): ChromeDiscoveryResult {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { candidates: [], totalProfiles: 0 };
  }
  const userDataDir = chromeUserDataDir();
  if (!existsSync(userDataDir)) return { candidates: [], totalProfiles: 0 };

  let macKey: Buffer | undefined;
  if (process.platform === "darwin") {
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
    macKey = pbkdf2Sync(keychainPw, "saltysalt", 1003, 16, "sha1");
  }

  const profileDirs = ["Default", ...readdirSync(userDataDir).filter((d) => d.startsWith("Profile "))];
  const candidates: ChromeCookieCandidate[] = [];
  let linuxV11Key: Buffer | undefined;
  let missingLinuxKey = false;

  for (const profileDir of profileDirs) {
    const dbPath = [join(userDataDir, profileDir, "Network", "Cookies"), join(userDataDir, profileDir, "Cookies")]
      .find(existsSync);
    if (!dbPath) continue;

    const tmpDir = mkdtempSync(join(tmpdir(), "slack-chrome-cookies-"));
    const tmp = join(tmpDir, "Cookies");
    try {
      copyFileSync(dbPath, tmp);
      if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${tmp}-wal`);
      const { default: Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(tmp, { readonly: true });
      let row: { encrypted_value: Uint8Array; value: string; host_key: string } | null;
      try {
        row = db.prepare(
          "SELECT encrypted_value, value, host_key FROM cookies WHERE name='d' AND (host_key='slack.com' OR host_key LIKE '%.slack.com') LIMIT 1",
        ).get() as typeof row;
      } finally {
        db.close();
      }
      if (!row) continue;
      const enc = Buffer.from(row.encrypted_value);
      const prefix = enc.subarray(0, 3).toString();
      let cookie: string | undefined;
      if (prefix === "v20") {
        throw new Error("Chrome cookie uses unsupported v20 app-bound encryption.");
      }
      if (process.platform === "linux") {
        if (!enc.length && row.value?.startsWith("xoxd-")) cookie = row.value;
        else if (prefix === "v10") {
          cookie = decryptV10Cookie(enc, pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"), row.host_key);
        } else if (prefix === "v11") {
          if (!linuxV11Key) {
            const password = linuxChromePassword();
            if (password) linuxV11Key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
          }
          if (linuxV11Key) cookie = decryptV10Cookie(enc, linuxV11Key, row.host_key);
          else missingLinuxKey = true;
        }
      } else if (prefix === "v10" && macKey) {
        cookie = decryptV10Cookie(enc, macKey, row.host_key, true);
      } else if (prefix !== "v10") {
        throw new Error("Unknown cookie encryption prefix.");
      }
      if (cookie) candidates.push({ profileDir, profileName: chromeProfileName(userDataDir, profileDir), cookie });
    } catch (e: unknown) {
      if (e instanceof Error && (e.message.includes("unsupported v20") || e.message.includes("Unknown cookie"))) throw e;
      // Skip unreadable profiles without exposing cookie or key material.
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  if (missingLinuxKey && candidates.length === 0) {
    throw new Error("Chrome v11 cookie key is unavailable. Install secret-tool and unlock the GNOME keyring, or use slack auth firefox.");
  }
  return { candidates, totalProfiles: profileDirs.length };
}

/** Read xoxc tokens from Chrome's Slack local storage and pair cookies from the same profile. */
export async function extractChromeSessions(): Promise<SlackAppSession[]> {
  if (process.platform !== "linux") throw new Error("Chrome session import is currently supported on Linux only.");
  const userDataDir = chromeUserDataDir();
  if (!existsSync(userDataDir)) throw new Error("Chrome profile directory was not found.");
  const cookies = new Map(discoverChromeCookies().candidates.map((c) => [c.profileDir, c.cookie]));
  const sessions = new Map<string, SlackAppSession>();
  const profileDirs = ["Default", ...readdirSync(userDataDir).filter((d) => d.startsWith("Profile "))];
  for (const profileDir of profileDirs) {
    const leveldb = join(userDataDir, profileDir, "Local Storage", "leveldb");
    if (!existsSync(leveldb)) continue;
    let found: SlackAppSession[];
    try {
      found = await extractSessions(leveldb);
    } catch {
      continue;
    }
    for (const session of found) {
      if (sessions.has(session.teamId)) {
        throw new Error("More than one Chrome profile has a token for the same workspace. Select one browser profile first.");
      }
      const cookie = cookies.get(profileDir);
      if (cookie) session.cookie = cookie;
      sessions.set(session.teamId, session);
    }
  }
  return [...sessions.values()];
}

export type FirefoxCookieCandidate = {
  profileDir: string;  // e.g. "abc123.default-release"
  profileName: string; // display name from profiles.ini, or the dir name
  cookie: string;      // plaintext xoxd-... (Firefox stores cookies unencrypted)
};

function firefoxProfilesDirs(): string[] {
  const home = process.env.HOME ?? homedir();
  if (process.platform === "darwin") return [join(home, "Library", "Application Support", "Firefox", "Profiles")];
  if (process.platform === "linux") return [
    join(home, ".mozilla", "firefox"),
    join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
  ];
  if (process.platform === "win32") {
    return [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Mozilla", "Firefox", "Profiles")];
  }
  return [];
}

/** Read Firefox profiles.ini to map profile dir names to display names. */
function firefoxProfileNames(profilesDir: string): Record<string, string> {
  const localIni = join(profilesDir, "profiles.ini");
  const iniPath = existsSync(localIni) ? localIni : join(dirname(profilesDir), "profiles.ini");
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
  const candidates: FirefoxCookieCandidate[] = [];
  for (const profilesDir of firefoxProfilesDirs().filter(existsSync)) {
    const nameMap = firefoxProfileNames(profilesDir);
    let profileDirs: string[];
    try {
      profileDirs = readdirSync(profilesDir);
    } catch {
      continue;
    }

    for (const profileDir of profileDirs) {
      const dbPath = join(profilesDir, profileDir, "cookies.sqlite");
      if (!existsSync(dbPath)) continue;

      const tmpDir = mkdtempSync(join(tmpdir(), "slack-firefox-cookies-"));
      const tmp = join(tmpDir, "cookies.sqlite");
      try {
        copyFileSync(dbPath, tmp);
        const { default: Database } = require("bun:sqlite") as typeof import("bun:sqlite");
        const db = new Database(tmp, { readonly: true });
        const row = db
          .prepare("SELECT value FROM moz_cookies WHERE name='d' AND (host='slack.com' OR host LIKE '%.slack.com') LIMIT 1")
          .get() as { value: string } | null;
        db.close();
        if (!row?.value || !row.value.startsWith("xoxd-")) continue;
        const profileName = nameMap[profileDir] ?? profileDir;
        candidates.push({ profileDir, profileName, cookie: row.value });
      } catch {
        // skip this profile
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }
  return candidates;
}
