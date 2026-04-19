import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../ts/profiles.ts";

// Redirect profile storage AND lockfile paths to temp dirs.
// HOME and CWD must be distinct so local/global lockfiles don't collide.
let tmpHome: string;
let tmpCwd: string;
let origCwd: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-cli-home-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "slack-cli-cwd-"));
  origCwd = process.cwd();
  process.env.HOME = tmpHome;
  (homedir as unknown as { _override?: string })._override = tmpHome;
  process.chdir(tmpCwd);
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
  delete process.env.HOME;
  delete process.env.SLACK_MCP_XOXP_TOKEN;
  delete process.env.SLACK_WORKSPACE;
});

async function getProfiles() {
  return import("../ts/profiles.ts?" + tmpHome);
}

const fakeProfile: Profile = {
  token: "xoxp-fake-001",
  team: "Acme Corp",
  teamId: "T00000001",
  url: "https://acme.slack.com/",
  user: "alice",
};

const fakeProfile2: Profile = {
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
    // No lockfile set → current is false
    expect(list[0]?.current).toBe(false);
  });

  test("useProfile (local) sets current via lockfile", async () => {
    const { addProfile, useProfile, listProfiles } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("acme");
    const cur = listProfiles().find((p: { current: boolean; name: string; profile: Profile }) => p.current);
    expect(cur?.name).toBe("acme");
  });

  test("useProfile (global) sets current via global lockfile", async () => {
    const { addProfile, useProfile, listProfiles } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta", true);
    const cur = listProfiles().find((p: { current: boolean; name: string; profile: Profile }) => p.current);
    expect(cur?.name).toBe("beta");
  });

  test("local lockfile overrides global lockfile", async () => {
    const { addProfile, useProfile, listProfiles } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta", true);   // global → beta
    useProfile("acme", false);  // local  → acme
    const cur = listProfiles().find((p: { current: boolean; name: string; profile: Profile }) => p.current);
    expect(cur?.name).toBe("acme");
  });

  test("useProfile throws for unknown name", async () => {
    const { useProfile } = await getProfiles();
    expect(() => useProfile("nope")).toThrow("Profile not found: nope");
  });

  test("removeProfile removes profile", async () => {
    const { addProfile, removeProfile, listProfiles } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    removeProfile("acme");
    const list = listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("beta");
  });

  test("removeProfile throws for unknown name", async () => {
    const { removeProfile } = await getProfiles();
    expect(() => removeProfile("nope")).toThrow("Profile not found: nope");
  });

  test("resolveToken uses local lockfile", async () => {
    const { addProfile, useProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    useProfile("acme");
    expect(resolveToken()).toBe("xoxp-fake-001");
  });

  test("resolveToken uses global lockfile when no local", async () => {
    const { addProfile, useProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta", true);
    expect(resolveToken()).toBe("xoxp-fake-002");
  });

  test("resolveToken local overrides global", async () => {
    const { addProfile, useProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta", true);
    useProfile("acme", false);
    expect(resolveToken()).toBe("xoxp-fake-001");
  });

  test("resolveToken throws when profiles exist but none selected", async () => {
    const { addProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    // Even one profile with no lockfile → throw
    expect(() => resolveToken()).toThrow("Workspace not selected");
  });

  test("resolveToken throws when multiple profiles and no lockfile", async () => {
    const { addProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    expect(() => resolveToken()).toThrow("Workspace not selected");
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

  test("resolveToken uses SLACK_MCP_XOXP_TOKEN when no profiles", async () => {
    const { resolveToken } = await getProfiles();
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-env-token";
    expect(resolveToken()).toBe("xoxp-env-token");
    delete process.env.SLACK_MCP_XOXP_TOKEN;
  });

  test("resolveToken throws when both SLACK_MCP_XOXP_TOKEN and profiles exist", async () => {
    const { addProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-env-token";
    expect(() => resolveToken()).toThrow("keep only one");
    delete process.env.SLACK_MCP_XOXP_TOKEN;
  });

  test("resolveToken throws when no profiles and no env var", async () => {
    const { resolveToken } = await getProfiles();
    delete process.env.SLACK_MCP_XOXP_TOKEN;
    expect(() => resolveToken()).toThrow("No profiles configured");
  });

  test("resolveToken throws when global lockfile points to missing profile", async () => {
    const { addProfile, useProfile, removeProfile, resolveToken } = await getProfiles();
    addProfile("acme", fakeProfile);
    useProfile("acme", true); // global lockfile → "acme"
    removeProfile("acme");    // remove the profile but leave the lockfile
    expect(() => resolveToken()).toThrow("~/.slack-cli/workspace");
  });
});
