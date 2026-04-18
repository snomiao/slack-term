import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../ts/profiles.ts";

// Redirect profile storage to a temp dir for isolation.
let tmpHome: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-cli-test-"));
  process.env.HOME = tmpHome;
  (homedir as unknown as { _override?: string })._override = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.HOME;
});

// Import after HOME is patched — profiles.ts calls homedir() at call time.
async function getProfiles() {
  // Fresh dynamic import each test to avoid module-level caching of homedir().
  return import("../ts/profiles.ts?" + tmpHome);
}

const fakeProfile = {
  token: "xoxp-fake-001",
  team: "Acme Corp",
  teamId: "T00000001",
  url: "https://acme.slack.com/",
  user: "alice",
};

const fakeProfile2 = {
  token: "xoxp-fake-002",
  team: "Beta Inc",
  teamId: "T00000002",
  url: "https://beta.slack.com/",
  user: "bob",
};

describe("profiles", () => {
  test("listProfiles returns empty when no file", async () => {
    const { listProfiles } = await getProfiles();
    expect(listProfiles()).toEqual([]);
  });

  test("addProfile and listProfiles", async () => {
    const { addProfile, listProfiles } = await getProfiles();
    addProfile("acme", fakeProfile);
    const list = listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("acme");
    expect(list[0]?.profile.team).toBe("Acme Corp");
    expect(list[0]?.current).toBe(true);
  });

  test("first profile is set as current automatically", async () => {
    const { addProfile, listProfiles } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    const cur = listProfiles().find((p: { current: boolean; name: string; profile: Profile }) => p.current);
    expect(cur?.name).toBe("acme");
  });

  test("useProfile switches current", async () => {
    const { addProfile, useProfile, listProfiles } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta");
    const cur = listProfiles().find((p: { current: boolean; name: string; profile: Profile }) => p.current);
    expect(cur?.name).toBe("beta");
  });

  test("useProfile throws for unknown name", async () => {
    const { useProfile } = await getProfiles();
    expect(() => useProfile("nope")).toThrow("Profile not found: nope");
  });

  test("removeProfile removes and clears current", async () => {
    const { addProfile, useProfile, removeProfile, listProfiles } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("acme");
    removeProfile("acme");
    const list = listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("beta");
  });

  test("removeProfile throws for unknown name", async () => {
    const { removeProfile } = await getProfiles();
    expect(() => removeProfile("nope")).toThrow("Profile not found: nope");
  });

  test("resolveToken uses single profile automatically", async () => {
    const { addProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    expect(resolveToken()).toBe("xoxp-fake-001");
  });

  test("resolveToken uses current with multiple profiles", async () => {
    const { addProfile, useProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta");
    expect(resolveToken()).toBe("xoxp-fake-002");
  });

  test("resolveToken throws when multiple profiles and no current", async () => {
    const { addProfile, resolveToken } = await getProfiles();
    // Add two; first becomes current. Clear current via file manipulation.
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    // Manually clear current by patching the file.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const path = join(homedir(), ".config", "slack-cli", "profiles.json");
    const store = JSON.parse(readFileSync(path, "utf8"));
    delete store.current;
    writeFileSync(path, JSON.stringify(store));
    expect(() => resolveToken()).toThrow("Multiple workspaces");
  });

  test("resolveToken by --workspace flag", async () => {
    const { addProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    expect(resolveToken("beta")).toBe("xoxp-fake-002");
  });

  test("resolveToken throws for unknown workspace flag", async () => {
    const { addProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    expect(() => resolveToken("nope")).toThrow(`Workspace "nope" not found`);
  });

  test("resolveToken falls back to SLACK_MCP_XOXP_TOKEN when no profiles", async () => {
    const { resolveToken } = await getProfiles();
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-env-token";
    expect(resolveToken()).toBe("xoxp-env-token");
    delete process.env.SLACK_MCP_XOXP_TOKEN;
  });

  test("resolveToken throws when no profiles and no env var", async () => {
    const { resolveToken } = await getProfiles();
    delete process.env.SLACK_MCP_XOXP_TOKEN;
    expect(() => resolveToken()).toThrow("No profiles configured");
  });
});
