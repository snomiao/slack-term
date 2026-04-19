// Extract xoxc- tokens from the Slack desktop app's LevelDB (macOS/Linux/Windows).
// Reads raw .ldb/.log files with regex — works even while Slack is running (no exclusive lock).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SlackAppSession = {
  token: string;   // xoxc-...
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

  // For sessions without a name, fall back to deriving one from the workspace URL.
  for (const session of sessions.values()) {
    if (!session.teamName && session.url) {
      const slug = session.url.match(/https:\/\/([a-z0-9-]+)\.slack\.com\//)?.[1];
      if (slug) session.teamName = slug;
    }
  }

  return [...sessions.values()];
}
