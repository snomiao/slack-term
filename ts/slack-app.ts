// Extract xoxc- tokens from the Slack desktop app's LevelDB (macOS/Linux).
// Reads ~/Library/Application Support/Slack/Local Storage/leveldb/ and finds
// all logged-in workspaces without requiring any manual token copy-paste.

import { ClassicLevel } from "classic-level";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type SlackAppSession = {
  token: string;   // xoxc-...
  csid: string;    // _x_csid / d-s cookie value
  teamId: string;
  teamName?: string;
  url?: string;
};

function leveldbPath(): string {
  const platform = process.platform;
  const home = homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Slack", "Local Storage", "leveldb");
  }
  if (platform === "linux") {
    return join(home, ".config", "Slack", "Local Storage", "leveldb");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Slack", "Local Storage", "leveldb");
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export async function extractSessions(): Promise<SlackAppSession[]> {
  const dbPath = leveldbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Slack desktop app LevelDB not found at:\n  ${dbPath}\nIs Slack installed and has been opened at least once?`,
    );
  }

  const db = new ClassicLevel(dbPath, { createIfMissing: false });
  const sessions = new Map<string, Partial<SlackAppSession>>();

  try {
    for await (const [, val] of db.iterator()) {
      if (typeof val !== "string") continue;

      // xoxc- tokens appear as JSON values in LocalStorage
      const xoxcMatch = val.match(/"(xoxc-[A-Za-z0-9_-]+)"/g);
      if (xoxcMatch) {
        for (const m of xoxcMatch) {
          const token = m.replace(/"/g, "");
          // Extract team ID from token (xoxc-TEAMID-...)
          const teamId = token.split("-")[1] ?? "";
          if (!sessions.has(teamId)) sessions.set(teamId, { teamId });
          sessions.get(teamId)!.token = token;
        }
      }

      // csid / d-s cookie appears alongside the token
      const csidMatch = val.match(/"(d-s=([A-Za-z0-9_.-]+))"/);
      if (csidMatch?.[2]) {
        const csid = csidMatch[2];
        for (const [, session] of sessions) {
          if (!session.csid) session.csid = csid;
        }
      }

      // Team URLs appear as workspace metadata
      const urlMatch = val.match(/"url"\s*:\s*"(https:\/\/[^"]+\.slack\.com\/)"/);
      if (urlMatch) {
        const url = urlMatch[1] ?? "";
        // team ID embedded in url context
        for (const [, session] of sessions) {
          if (!session.url) session.url = url;
        }
      }

      // Team name
      const nameMatch = val.match(/"name"\s*:\s*"([^"]{2,80})"/);
      if (nameMatch?.[1]) {
        for (const [, session] of sessions) {
          if (!session.teamName) session.teamName = nameMatch[1];
        }
      }
    }
  } finally {
    await db.close();
  }

  return [...sessions.values()].filter(
    (s): s is SlackAppSession => Boolean(s.token && s.teamId),
  );
}
