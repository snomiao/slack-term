import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../ts/profiles.ts";
import {
  listProfiles,
  addProfile,
  removeProfile,
  useProfile,
  resolveToken,
  setCookie,
  resolveCookie,
} from "../ts/profiles.ts";

// Redirect profile storage AND lockfile paths to temp dirs.
// profiles.ts uses process.env.HOME (via home() helper), so setting HOME here is sufficient.
// HOME and CWD must be distinct so local/global lockfiles don't collide.
let tmpHome: string;
let tmpCwd: string;
let origCwd: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-cli-home-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "slack-cli-cwd-"));
  origCwd = process.cwd();
  process.env.HOME = tmpHome;
  process.chdir(tmpCwd);
  delete (globalThis as Record<string, unknown>).__slackEnvWarnShown;
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
  delete process.env.HOME;
  delete process.env.SLACK_MCP_XOXP_TOKEN;
  delete process.env.SLACK_WORKSPACE;
  delete process.env.SLACK_MCP_XOXD_COOKIE;
  delete (globalThis as Record<string, unknown>).__slackEnvWarnShown;
});

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
  test("listProfiles returns empty when no file", () => {
    expect(listProfiles()).toEqual([]);
  });

  test("addProfile and listProfiles", () => {
    addProfile("acme", fakeProfile);
    const list = listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("acme");
    expect(list[0]?.profile.team).toBe("Acme Corp");
    // No lockfile set → current is false
    expect(list[0]?.current).toBe(false);
  });

  test("useProfile (local) sets current via lockfile", () => {
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("acme");
    const cur = listProfiles().find((p: { current: boolean; name: string; profile: Profile }) => p.current);
    expect(cur?.name).toBe("acme");
  });

  test("useProfile (global) sets current via global lockfile", () => {
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta", true);
    const cur = listProfiles().find((p: { current: boolean; name: string; profile: Profile }) => p.current);
    expect(cur?.name).toBe("beta");
  });

  test("local lockfile overrides global lockfile", () => {
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta", true);   // global → beta
    useProfile("acme", false);  // local  → acme
    const cur = listProfiles().find((p: { current: boolean; name: string; profile: Profile }) => p.current);
    expect(cur?.name).toBe("acme");
  });

  test("useProfile throws for unknown name", () => {
    expect(() => useProfile("nope")).toThrow("Profile not found: nope");
  });

  test("removeProfile removes profile", () => {
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    removeProfile("acme");
    const list = listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("beta");
  });

  test("removeProfile throws for unknown name", () => {
    expect(() => removeProfile("nope")).toThrow("Profile not found: nope");
  });

  test("resolveToken uses local lockfile", () => {
    addProfile("acme", fakeProfile);
    useProfile("acme");
    expect(resolveToken()).toBe("xoxp-fake-001");
  });

  test("resolveToken uses global lockfile when no local", () => {
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta", true);
    expect(resolveToken()).toBe("xoxp-fake-002");
  });

  test("resolveToken local overrides global", () => {
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    useProfile("beta", true);
    useProfile("acme", false);
    expect(resolveToken()).toBe("xoxp-fake-001");
  });

  test("resolveToken throws when profiles exist but none selected", () => {
    addProfile("acme", fakeProfile);
    // Even one profile with no lockfile → throw
    expect(() => resolveToken()).toThrow("Workspace not selected");
  });

  test("resolveToken throws when multiple profiles and no lockfile", () => {
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    expect(() => resolveToken()).toThrow("Workspace not selected");
  });

  test("resolveToken by --workspace flag", () => {
    addProfile("acme", fakeProfile);
    addProfile("beta", fakeProfile2);
    expect(resolveToken("beta")).toBe("xoxp-fake-002");
  });

  test("resolveToken throws for unknown workspace flag", () => {
    addProfile("acme", fakeProfile);
    expect(() => resolveToken("nope")).toThrow(`Workspace "nope" not found`);
  });

  test("resolveToken uses SLACK_MCP_XOXP_TOKEN when no profiles", () => {
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-env-token";
    expect(resolveToken()).toBe("xoxp-env-token");
    delete process.env.SLACK_MCP_XOXP_TOKEN;
  });

  test("resolveToken throws when both SLACK_MCP_XOXP_TOKEN and profiles exist", () => {
    addProfile("acme", fakeProfile);
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-env-token";
    expect(() => resolveToken()).toThrow("Workspace not selected"); // shows warning (sets flag)
    expect(() => resolveToken()).toThrow("Workspace not selected"); // skips warning (already shown)
    delete process.env.SLACK_MCP_XOXP_TOKEN;
  });

  test("resolveToken throws when no profiles and no env var", () => {
    delete process.env.SLACK_MCP_XOXP_TOKEN;
    expect(() => resolveToken()).toThrow("No profiles configured");
  });

  test("resolveToken throws when global lockfile points to missing profile", () => {
    addProfile("acme", fakeProfile);
    useProfile("acme", true); // global lockfile → "acme"
    removeProfile("acme");    // remove the profile but leave the lockfile
    expect(() => resolveToken()).toThrow("~/.slack-cli/workspace");
  });

  test("setCookie sets cookie on existing profile", () => {
    addProfile("acme", fakeProfile);
    setCookie("acme", "xoxd-test-cookie");
    const profile = listProfiles().find((p: { name: string }) => p.name === "acme")?.profile;
    expect(profile?.cookie).toBe("xoxd-test-cookie");
  });

  test("setCookie throws for unknown profile", () => {
    expect(() => setCookie("nope", "cookie")).toThrow("Profile not found: nope");
  });

  test("resolveCookie returns cookie from local-lockfile profile", () => {
    addProfile("acme", { ...fakeProfile, cookie: "xoxd-local" });
    useProfile("acme");
    expect(resolveCookie()).toBe("xoxd-local");
  });

  test("resolveCookie returns cookie from global-lockfile profile", () => {
    addProfile("acme", { ...fakeProfile, cookie: "xoxd-global" });
    useProfile("acme", true);
    expect(resolveCookie()).toBe("xoxd-global");
  });

  test("resolveCookie returns SLACK_MCP_XOXD_COOKIE when env token active", () => {
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-env";
    process.env.SLACK_MCP_XOXD_COOKIE = "xoxd-env-cookie";
    expect(resolveCookie()).toBe("xoxd-env-cookie");
    delete process.env.SLACK_MCP_XOXP_TOKEN;
    delete process.env.SLACK_MCP_XOXD_COOKIE;
  });

  test("resolveCookie returns undefined for env token with no cookie var", () => {
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-env";
    delete process.env.SLACK_MCP_XOXD_COOKIE;
    expect(resolveCookie()).toBeUndefined();
    delete process.env.SLACK_MCP_XOXP_TOKEN;
  });

  test("resolveCookie returns cookie for --workspace flag", () => {
    addProfile("acme", { ...fakeProfile, cookie: "xoxd-acme" });
    expect(resolveCookie("acme")).toBe("xoxd-acme");
  });

  test("resolveCookie returns undefined when no lockfile", () => {
    expect(resolveCookie()).toBeUndefined();
  });

  test("useProfile second call skips writing gitignore when it already exists", () => {
    addProfile("acme", fakeProfile);
    useProfile("acme"); // writes .slack-cli/.gitignore
    useProfile("acme"); // .gitignore already exists — skip write
    const cur = listProfiles().find((p: { current: boolean }) => p.current);
    expect(cur?.name).toBe("acme");
  });

  test("resolveToken throws when local lockfile points to missing profile", () => {
    addProfile("acme", fakeProfile);
    useProfile("acme", false); // local lockfile → "acme"
    removeProfile("acme");     // remove the profile but leave the lockfile
    expect(() => resolveToken()).toThrow(".slack-cli/workspace");
  });

  test("resolveToken uses SLACK_WORKSPACE env var", () => {
    addProfile("acme", fakeProfile);
    process.env.SLACK_WORKSPACE = "acme";
    expect(resolveToken()).toBe("xoxp-fake-001");
    delete process.env.SLACK_WORKSPACE;
  });

  test("readLockfile returns undefined for empty-content lockfile", () => {
    addProfile("acme", fakeProfile);
    useProfile("acme");
    // Overwrite the lockfile with whitespace only
    writeFileSync(join(process.cwd(), ".slack-cli", "workspace"), "   \n");
    // Empty lockfile → falls through to "Workspace not selected"
    expect(() => resolveToken()).toThrow("Workspace not selected");
  });
});
