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
// Works while Slack is running. LevelDB stores values as length-prefixed UTF-8
// strings in .ldb and .log files — xoxc- tokens survive as plaintext.
export async function extractSessions(): Promise<SlackAppSession[]> {
  const dbPath = leveldbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Slack desktop app LevelDB not found at:\n  ${dbPath}\nIs Slack installed and opened at least once?`,
    );
  }

  const files = readdirSync(dbPath).filter((f) => f.endsWith(".ldb") || f.endsWith(".log"));
  if (files.length === 0) throw new Error(`No LevelDB data files found in ${dbPath}`);

  // Accumulate raw bytes from all files, then regex-scan as latin1 string.
  // latin1 preserves all byte values, so binary prefixes don't corrupt the xoxc- text.
  const sessions = new Map<string, SlackAppSession>();

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dbPath, file), "latin1");
    } catch {
      continue; // skip locked/unreadable files
    }

    // xoxc- tokens: xoxc-TEAMID-USER-SESSION-EXTRA
    for (const m of content.matchAll(/xoxc-([A-Z0-9]+)-\d+-\d+-[A-Za-z0-9%]+/g)) {
      const token = m[0];
      const teamId = m[1] ?? "";
      if (!teamId || token.length < 20) continue;
      if (!sessions.has(teamId)) {
        sessions.set(teamId, { token, teamId });
      } else {
        // Prefer the longest token (most recent / most complete)
        const existing = sessions.get(teamId)!;
        if (token.length > existing.token.length) existing.token = token;
      }
    }
  }

  // Second pass: pull workspace URLs and team names from the same files.
  // These appear as JSON blobs in LocalStorage entries.
  const allContent = files
    .map((f) => { try { return readFileSync(join(dbPath, f), "latin1"); } catch { return ""; } })
    .join("");

  for (const session of sessions.values()) {
    // URL pattern: "https://teamname.slack.com/" near the team ID
    const urlRe = new RegExp(`https://[a-z0-9-]+\\.slack\\.com/`, "g");
    for (const m of allContent.matchAll(urlRe)) {
      if (!session.url) session.url = m[0];
    }

    // Team name from JSON: {"name":"Acme Corp",...} or "team_name":"Acme"
    const nameMatch = allContent.match(/"(?:team_name|name)"\s*:\s*"([^"]{2,60})"/);
    if (nameMatch?.[1] && !session.teamName) session.teamName = nameMatch[1];
  }

  return [...sessions.values()];
}
