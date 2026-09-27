import { describe, test, expect } from "./harness.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, pbkdf2Sync, createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { extractSessions, extractChromeSessions, discoverFirefoxCookies, discoverChromeCookies } from "../ts/slack-app.ts";

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

  test("imports Ubuntu Chrome token and v10 cookie from one profile", async () => {
    if (process.platform !== "linux") return;
    const home = mkdtempSync(join(tmpdir(), "slack-chrome-test-"));
    const oldHome = process.env.HOME;
    const oldConfig = process.env.XDG_CONFIG_HOME;
    try {
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, ".config");
      const profile = join(home, ".config", "google-chrome", "Default");
      mkdirSync(join(profile, "Network"), { recursive: true });
      const db = new Database(join(profile, "Network", "Cookies"));
      db.exec("CREATE TABLE cookies (name TEXT, host_key TEXT, value TEXT, encrypted_value BLOB)");
      const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
      const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
      const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update("xoxd-fake"), cipher.final()]);
      db.query("INSERT INTO cookies VALUES (?, ?, ?, ?)").run("d", ".slack.com", "", encrypted);
      db.close();
      expect(discoverChromeCookies().candidates).toEqual([
        { profileDir: "Default", profileName: "Default", cookie: "xoxd-fake" },
      ]);
      const leveldb = join(profile, "Local Storage", "leveldb");
      mkdirSync(leveldb, { recursive: true });
      const token = "xoxc-00000001-00000002-00000003-abcdefabcdefabcdefabcdef";
      writeFileSync(join(leveldb, "000001.log"), JSON.stringify({ token, url: "https://acme.slack.com/", team_name: "Acme" }));
      const sessions = await extractChromeSessions();
      expect(sessions[0]?.token).toBe(token);
      expect(sessions[0]?.cookie).toBe("xoxd-fake");
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("decrypts Ubuntu Chrome v11 cookie using a secret-tool key", () => {
    if (process.platform !== "linux") return;
    const home = mkdtempSync(join(tmpdir(), "slack-chrome-test-"));
    const oldHome = process.env.HOME;
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const oldPath = process.env.PATH;
    try {
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, ".config");
      const bin = join(home, "bin");
      mkdirSync(bin);
      const secretTool = join(bin, "secret-tool");
      writeFileSync(secretTool, "#!/bin/sh\nprintf 'fake-password\n'\n");
      chmodSync(secretTool, 0o700);
      process.env.PATH = bin;
      const profile = join(home, ".config", "google-chrome", "Default");
      mkdirSync(join(profile, "Network"), { recursive: true });
      const db = new Database(join(profile, "Network", "Cookies"));
      db.exec("CREATE TABLE cookies (name TEXT, host_key TEXT, value TEXT, encrypted_value BLOB)");
      const key = pbkdf2Sync("fake-password", "saltysalt", 1, 16, "sha1");
      const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
      const plaintext = Buffer.concat([createHash("sha256").update(".slack.com").digest(), Buffer.from("xoxd-fake")]);
      const encrypted = Buffer.concat([Buffer.from("v11"), cipher.update(plaintext), cipher.final()]);
      db.query("INSERT INTO cookies VALUES (?, ?, ?, ?)").run("d", ".slack.com", "", encrypted);
      db.close();
      expect(discoverChromeCookies().candidates[0]?.cookie).toBe("xoxd-fake");
      const wrongCipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
      const wrongHost = Buffer.concat([createHash("sha256").update(".other.example").digest(), Buffer.from("xoxd-fake")]);
      const wrongEncrypted = Buffer.concat([Buffer.from("v11"), wrongCipher.update(wrongHost), wrongCipher.final()]);
      const db2 = new Database(join(profile, "Network", "Cookies"));
      db2.query("UPDATE cookies SET encrypted_value = ?").run(wrongEncrypted);
      db2.close();
      expect(discoverChromeCookies().candidates).toEqual([]);
      rmSync(secretTool);
      expect(() => discoverChromeCookies()).toThrow("Chrome v11 cookie key is unavailable");
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
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
