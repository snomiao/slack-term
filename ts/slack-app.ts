// Extract xoxc- tokens from the Slack desktop app's LevelDB (macOS/Linux/Windows).
// Reads raw .ldb/.log files with regex — works even while Slack is running (no exclusive lock).
// Also extracts the xoxd session cookie from the Slack Cookies SQLite database (macOS only).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { execSync } from "node:child_process";

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

// Scan raw LevelDB files for xoxc- tokens without opening the DB exclusively.
// Works while Slack is running.
//
// Strategy:
//  1. .log files (write-ahead log): values are stored as readable JSON strings.
//     Scan for "token":"xoxc-..." to get complete, clean tokens + workspace URL.
//  2. .ldb files (sorted tables): values are length-prefixed with binary framing
//     bytes that can split the token mid-segment. Use gap-bridging as fallback.
export async function extractSessions(): Promise<SlackAppSession[]> {
  const dbPath = leveldbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Slack desktop app LevelDB not found at:\n  ${dbPath}\nIs Slack installed and opened at least once?`,
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
  const xoxd = extractXoxd();
  const result = [...sessions.values()];
  if (xoxd) {
    for (const s of result) s.cookie = xoxd;
  }
  return result;
}
