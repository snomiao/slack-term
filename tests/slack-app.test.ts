import { describe, test, expect } from "./harness.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { extractSessions, discoverFirefoxCookies } from "../ts/slack-app.ts";

describe("Linux session discovery", () => {
  test("finds a Slack desktop token in the Snap data directory", async () => {
    if (process.platform !== "linux") return;
    const home = mkdtempSync(join(tmpdir(), "slack-auth-paths-"));
    const previous = process.env.HOME;
    try {
      process.env.HOME = home;
      const leveldb = join(home, "snap", "slack", "current", ".config", "Slack", "Local Storage", "leveldb");
      mkdirSync(leveldb, { recursive: true });
      const token = "xoxc-00000001-00000002-00000003-abcdefabcdefabcdefabcdef";
      writeFileSync(join(leveldb, "000001.log"), JSON.stringify({ token, url: "https://acme.slack.com/", team_name: "Acme" }));
      const sessions = await extractSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.token).toBe(token);
      expect(sessions[0]?.teamId).toBe("00000001");
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("finds Firefox Snap cookie and reads its local profiles.ini name", () => {
    if (process.platform !== "linux") return;
    const home = mkdtempSync(join(tmpdir(), "slack-auth-paths-"));
    const previous = process.env.HOME;
    try {
      process.env.HOME = home;
      const root = join(home, "snap", "firefox", "common", ".mozilla", "firefox");
      const profile = join(root, "fake.default-release");
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(root, "profiles.ini"), "[Profile0]\nName=Acme Browser\nIsRelative=1\nPath=fake.default-release\n");
      const db = new Database(join(profile, "cookies.sqlite"));
      db.exec("CREATE TABLE moz_cookies (name TEXT, host TEXT, value TEXT)");
      db.query("INSERT INTO moz_cookies VALUES (?, ?, ?)").run("d", ".slack.com", "xoxd-fake");
      db.close();
      expect(discoverFirefoxCookies()).toEqual([
        { profileDir: "fake.default-release", profileName: "Acme Browser", cookie: "xoxd-fake" },
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
