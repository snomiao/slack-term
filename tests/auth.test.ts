// Tests for ts/auth.ts — uses a mock HTTP server and temp HOME dir.

import { describe, test, expect, beforeEach, afterEach, vi, mockModule } from "./harness.ts";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, type MockHandle } from "./mock.ts";

// Module-level mocks. Registered before the subject is imported — see
// `mockModule` in harness.ts for why that ordering is mandatory here.
// Every export ts/auth.ts imports has to be present: replacing a module drops
// the exports the factory omits, and bun refuses the import outright when one
// of them is missing (vitest only fails once the missing one is called).
mockModule("../ts/slack-app.ts", () => ({
  extractSessions: vi.fn().mockResolvedValue([]),
  extractChromeSessions: vi.fn().mockResolvedValue([]),
  discoverChromeCookies: vi.fn().mockReturnValue({ candidates: [], totalProfiles: 0 }),
  discoverFirefoxCookies: vi.fn().mockReturnValue([]),
}));

// Shared readline answer queue — mutated per-test before calling cmdAuthLogin.
const rlState = { answers: [] as string[], idx: 0 };

mockModule("node:readline/promises", () => ({
  createInterface: vi.fn().mockImplementation(() => ({
    question: vi.fn().mockImplementation(() =>
      Promise.resolve(rlState.answers[rlState.idx++] ?? ""),
    ),
    close: vi.fn(),
  })),
}));

// Imported AFTER the mocks above, and dynamically: the registration is not
// hoisted, so a static import here would bind the real modules.
// Filesystem isolation comes from process.env.HOME = tmpHome (profiles.ts uses process.env.HOME).
const { cmdAuthLogin, cmdAuthChrome, cmdAuthSave, cmdAuthTokens, importFromDesktop } = await import("../ts/auth.ts");
const { listProfiles, addProfile, useProfile } = await import("../ts/profiles.ts");
const { extractSessions, extractChromeSessions, discoverFirefoxCookies, discoverChromeCookies } = await import("../ts/slack-app.ts");

// A direct cast rather than vi.mocked: the shape is all these tests need, and
// it reads the same under either runner.
type MockFn<T extends (...args: never[]) => unknown> = T & {
  mockResolvedValueOnce: (v: Awaited<ReturnType<T>> | never) => void;
  mockReturnValueOnce: (v: ReturnType<T>) => void;
};
const mockExtractSessions = extractSessions as unknown as MockFn<typeof extractSessions>;
const mockExtractChromeSessions = extractChromeSessions as unknown as MockFn<typeof extractChromeSessions>;
const mockDiscoverFirefox = discoverFirefoxCookies as unknown as MockFn<typeof discoverFirefoxCookies>;
const mockDiscoverChrome = discoverChromeCookies as unknown as MockFn<typeof discoverChromeCookies>;

let tmpHome: string;
let tmpCwd: string;
let origCwd: string;
let origHome: string | undefined;
let mock: MockHandle;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-auth-test-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "slack-auth-cwd-"));
  origCwd = process.cwd();
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  process.chdir(tmpCwd);
  mock = await startMock({
    inline: {
      "auth.test": {
        ok: true,
        user_id: "U00000001",
        user: "alice",
        team: "Acme Corp",
        team_id: "T00000001",
        url: "https://acme.slack.com/",
      },
    },
  });
  process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
  rlState.answers = [];
  rlState.idx = 0;
});

afterEach(async () => {
  process.chdir(origCwd);
  await mock.stop();
  delete process.env.SLACK_API_BASE;
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  delete process.env.SLACK_MCP_XOXP_TOKEN;
  delete process.env.SLACK_MCP_XOXD_COOKIE;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
});

function setTTY(val: boolean | undefined) {
  Object.defineProperty(process.stdin, "isTTY", { value: val, configurable: true });
}

describe("auth.ts", () => {
  test("auth tokens prints selected credentials in dotenv format", () => {
    addProfile("acme", { token: "xoxc-fake", cookie: "xoxd-fake", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "alice" });
    useProfile("acme");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      cmdAuthTokens();
      expect(spy.mock.calls[0]?.[0]).toBe("SLACK_TOKEN=xoxc-fake\nSLACK_COOKIE=xoxd-fake");
    } finally {
      spy.mockRestore();
    }
  });

  test("auth save writes token and cookie to a private env file", () => {
    addProfile("acme", { token: "xoxc-fake", cookie: "xoxd-fake", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "alice" });
    const path = join(tmpCwd, ".env.local");
    cmdAuthSave({ envfile: path });
    expect(readFileSync(path, "utf8")).toContain("SLACK_TOKEN=xoxc-fake\n");
    expect(readFileSync(path, "utf8")).toContain("SLACK_COOKIE=xoxd-fake\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("auth save rejects a profile without a cookie", () => {
    addProfile("acme", { token: "xoxc-fake", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "alice" });
    expect(() => cmdAuthSave({ envfile: join(tmpCwd, ".env.local") })).toThrow("has no session cookie");
  });

  // --- non-interactive (--token flag) ---

  test("cmdAuthLogin with --token saves profile named from team", async () => {
    await cmdAuthLogin({ token: "xoxp-fake" });
    const list = listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("acme-corp");
    expect(list[0]?.profile.token).toBe("xoxp-fake");
    expect(list[0]?.profile.team).toBe("Acme Corp");
  });

  test("cmdAuthLogin with --name uses given name", async () => {
    await cmdAuthLogin({ token: "xoxp-fake", name: "my-ws" });
    expect(listProfiles()[0]?.name).toBe("my-ws");
  });

  test("cmdAuthLogin reads token from piped stdin", async () => {
    const { Readable } = await import("node:stream");
    const mockStdin = Readable.from([Buffer.from("xoxp-piped-token\n")]);
    const origDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true, writable: true });
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxp-piped-token");
    } finally {
      if (origDescriptor) Object.defineProperty(process, "stdin", origDescriptor);
    }
  });

  test("cmdAuthLogin exits when piped stdin is empty", async () => {
    const { Readable } = await import("node:stream");
    const mockStdin = Readable.from([Buffer.from("   \n")]);
    const origDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true, writable: true });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    try {
      await expect(cmdAuthLogin({})).rejects.toThrow("process.exit");
    } finally {
      if (origDescriptor) Object.defineProperty(process, "stdin", origDescriptor);
      exitSpy.mockRestore();
    }
  });

  test("cmdAuthLogin logs SLACK_MCP_XOXP_TOKEN warning when env var set", async () => {
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-existing";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdAuthLogin({ token: "xoxp-fake" });
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("SLACK_MCP_XOXP_TOKEN");
    } finally {
      spy.mockRestore();
    }
  });

  test("cmdAuthLogin shows existing profiles before adding another", async () => {
    addProfile("beta", { token: "xoxp-beta", team: "Beta", teamId: "T2", url: "", user: "bob" });
    useProfile("beta");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdAuthLogin({ token: "xoxp-fake", name: "acme" });
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("beta");
    } finally {
      spy.mockRestore();
    }
  });

  test("cmdAuthLogin shows 'unknown' for profile with empty user", async () => {
    addProfile("nouser", { token: "xoxp-x", team: "Nope", teamId: "T3", url: "", user: "" });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdAuthLogin({ token: "xoxp-fake", name: "acme" });
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("unknown");
    } finally {
      spy.mockRestore();
    }
  });

  // --- TTY interactive paths ---

  test("cmdAuthLogin TTY choice 2 (existing app, user token) saves profile", async () => {
    setTTY(true);
    rlState.answers = ["2", "1", "xoxp-fake", "", "4"]; // "4" = save to profiles.json
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxp-fake");
    } finally {
      setTTY(undefined);
    }
  });

  test("cmdAuthLogin TTY choice 2 (existing app, bot token) saves profile", async () => {
    setTTY(true);
    rlState.answers = ["2", "2", "xoxb-fake", "", "4"]; // "4" = save to profiles.json
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxb-fake");
    } finally {
      setTTY(undefined);
    }
  });

  test("cmdAuthLogin TTY choice 3 (new user app) saves profile", async () => {
    setTTY(true);
    rlState.answers = ["3", "xoxp-fake", "my-workspace", "4"]; // "4" = save to profiles.json
    try {
      await cmdAuthLogin({});
      const profile = listProfiles()[0];
      expect(profile?.profile.token).toBe("xoxp-fake");
      expect(profile?.name).toBe("my-workspace");
    } finally {
      setTTY(undefined);
    }
  });

  test("cmdAuthLogin TTY choice 4 (new bot app) saves profile", async () => {
    setTTY(true);
    rlState.answers = ["4", "xoxb-fake", "", "4"]; // "4" = save to profiles.json
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxb-fake");
    } finally {
      setTTY(undefined);
    }
  });

  test("cmdAuthLogin TTY choice 1 (desktop import) calls importFromDesktop", async () => {
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-desk", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/", cookie: "xoxd-fake" },
    ]);
    setTTY(true);
    rlState.answers = ["1", "4"]; // "4" = save to profiles.json (no workspace name prompt — nameOverride passed)
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxc-desk");
      expect(mock.requests.find((r) => r.method === "auth.test")?.headers.cookie).toBe("d=xoxd-fake");
    } finally {
      setTTY(undefined);
    }
  });

  test("desktop import without a cookie saves a profile for auth firefox", async () => {
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/" },
    ]);
    setTTY(true);
    rlState.answers = ["1"];
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxc-fake");
      expect(listProfiles()[0]?.profile.cookie).toBeUndefined();
      expect(mock.requests.find((r) => r.method === "auth.test")).toBeUndefined();
    } finally {
      setTTY(undefined);
    }
  });

  test("cmdAuthLogin TTY invalid choice calls process.exit", async () => {
    setTTY(true);
    rlState.answers = ["9"];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    try {
      await expect(cmdAuthLogin({})).rejects.toThrow("process.exit");
    } finally {
      setTTY(undefined);
      exitSpy.mockRestore();
    }
  });

  test("cmdAuthLogin TTY choice 2 empty token calls process.exit", async () => {
    setTTY(true);
    rlState.answers = ["2", "1", ""];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    try {
      await expect(cmdAuthLogin({})).rejects.toThrow("process.exit");
    } finally {
      setTTY(undefined);
      exitSpy.mockRestore();
    }
  });

  test("cmdAuthLogin TTY choice 3 empty token calls process.exit", async () => {
    setTTY(true);
    rlState.answers = ["3", ""];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    try {
      await expect(cmdAuthLogin({})).rejects.toThrow("process.exit");
    } finally {
      setTTY(undefined);
      exitSpy.mockRestore();
    }
  });

  test("cmdAuthLogin TTY choice 2 wrong token prefix calls process.exit", async () => {
    setTTY(true);
    rlState.answers = ["2", "1", "wrong-prefix-token", ""];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    try {
      await expect(cmdAuthLogin({})).rejects.toThrow("process.exit");
    } finally {
      setTTY(undefined);
      exitSpy.mockRestore();
    }
  });

  test("cmdAuthLogin TTY choice 3 wrong token prefix calls process.exit", async () => {
    setTTY(true);
    rlState.answers = ["3", "xoxb-wrong-for-user", ""];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    try {
      await expect(cmdAuthLogin({})).rejects.toThrow("process.exit");
    } finally {
      setTTY(undefined);
      exitSpy.mockRestore();
    }
  });

  // --- importFromDesktop ---

  test("importFromDesktop falls back to teamId when teamName absent", async () => {
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-noid", teamId: "T99999", url: undefined } as never,
    ]);
    await importFromDesktop();
    expect(listProfiles()[0]?.name).toBe("t99999");
    expect(listProfiles()[0]?.profile.url).toBe("");
  });

  test("importFromDesktop saves session as profile", async () => {
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme Corp", url: "https://acme.slack.com/" },
    ]);
    await importFromDesktop();
    const list = listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("acme-corp");
    expect(list[0]?.profile.token).toBe("xoxc-fake");
  });

  test("Linux desktop import attaches the sole Firefox cookie", async () => {
    if (process.platform !== "linux") return;
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/" },
    ]);
    mockDiscoverFirefox.mockReturnValueOnce([
      { profileDir: "fake.default", profileName: "default", cookie: "xoxd-fake" },
    ]);
    await importFromDesktop(undefined, true);
    expect(listProfiles()[0]?.profile.cookie).toBe("xoxd-fake");
  });

  test("Linux desktop import uses Chrome when Firefox has no Slack session", async () => {
    if (process.platform !== "linux") return;
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/" },
    ]);
    mockDiscoverChrome.mockReturnValueOnce({
      candidates: [{ profileDir: "Default", profileName: "Default", cookie: "xoxd-fake" }],
      totalProfiles: 1,
    });
    await importFromDesktop(undefined, true);
    expect(listProfiles()[0]?.profile.cookie).toBe("xoxd-fake");
  });

  test("Linux auth chrome attaches a selected browser cookie", async () => {
    if (process.platform !== "linux") return;
    addProfile("acme", { token: "xoxc-fake", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "alice" });
    mockDiscoverChrome.mockReturnValueOnce({
      candidates: [{ profileDir: "Default", profileName: "Default", cookie: "xoxd-fake" }],
      totalProfiles: 1,
    });
    await cmdAuthChrome({ workspace: "acme", yes: true });
    expect(listProfiles()[0]?.profile.cookie).toBe("xoxd-fake");
  });

  test("--yes --from-chrome imports Chrome token and cookie without desktop", async () => {
    if (process.platform !== "linux") return;
    mockExtractChromeSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/", cookie: "xoxd-fake" },
    ]);
    await cmdAuthLogin({ fromChrome: true, yes: true });
    expect(listProfiles()[0]?.profile.token).toBe("xoxc-fake");
    expect(listProfiles()[0]?.profile.cookie).toBe("xoxd-fake");
  });

  test("--from-all --yes uses Chrome session when desktop is absent", async () => {
    if (process.platform !== "linux") return;
    const rejecting = extractSessions as unknown as { mockRejectedValueOnce: (error: Error) => void };
    rejecting.mockRejectedValueOnce(new Error("Slack desktop app LevelDB not found"));
    mockExtractChromeSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/", cookie: "xoxd-fake" },
    ]);
    await cmdAuthLogin({ fromAll: true, yes: true });
    expect(listProfiles()[0]?.profile.cookie).toBe("xoxd-fake");
  });

  test("--from-all --yes leaves ambiguous browser cookies unselected", async () => {
    if (process.platform !== "linux") return;
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/" },
    ]);
    mockDiscoverFirefox.mockReturnValueOnce([
      { profileDir: "fake.default", profileName: "Firefox", cookie: "xoxd-firefox" },
    ]);
    mockDiscoverChrome.mockReturnValueOnce({
      candidates: [{ profileDir: "Default", profileName: "Chrome", cookie: "xoxd-chrome" }],
      totalProfiles: 1,
    });
    await cmdAuthLogin({ fromAll: true, yes: true });
    expect(listProfiles()[0]?.profile.cookie).toBeUndefined();
  });

  test("declining --from-all does not read either browser", async () => {
    if (process.platform !== "linux") return;
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/" },
    ]);
    const chromeCalls = (discoverChromeCookies as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const firefoxCalls = (discoverFirefoxCookies as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    setTTY(true);
    rlState.answers = ["n"];
    try {
      await cmdAuthLogin({ fromAll: true });
      expect(listProfiles()[0]?.profile.cookie).toBeUndefined();
      expect((discoverChromeCookies as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(chromeCalls);
      expect((discoverFirefoxCookies as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(firefoxCalls);
    } finally {
      setTTY(undefined);
    }
  });

  test("--from-chrome requires consent without --yes", async () => {
    if (process.platform !== "linux") return;
    setTTY(undefined);
    await expect(cmdAuthLogin({ fromChrome: true })).rejects.toThrow("requires confirmation");
  });

  test("--from-desktop does not inspect browser profiles", async () => {
    if (process.platform !== "linux") return;
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/" },
    ]);
    await cmdAuthLogin({ fromDesktop: true, yes: true });
    expect(listProfiles()[0]?.profile.cookie).toBeUndefined();
  });

  test("Linux desktop import leaves cookie unset when Firefox has multiple sessions", async () => {
    if (process.platform !== "linux") return;
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T00000001", teamName: "Acme", url: "https://acme.slack.com/" },
    ]);
    mockDiscoverFirefox.mockReturnValueOnce([
      { profileDir: "a.default", profileName: "one", cookie: "xoxd-fake-one" },
      { profileDir: "b.default", profileName: "two", cookie: "xoxd-fake-two" },
    ]);
    await importFromDesktop(undefined, true);
    expect(listProfiles()[0]?.profile.cookie).toBeUndefined();
  });

  test("importFromDesktop saves cookie when session includes one", async () => {
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-beta", teamId: "T2", teamName: "Beta", url: "https://beta.slack.com/", cookie: "xoxd-secret" },
    ]);
    await importFromDesktop();
    expect(listProfiles()[0]?.profile.cookie).toBe("xoxd-secret");
  });

  test("importFromDesktop prints run command for single workspace", async () => {
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-fake", teamId: "T1", teamName: "Acme Corp", url: "https://acme.slack.com/" },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await importFromDesktop();
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("slack auth use -g");
    } finally {
      spy.mockRestore();
    }
  });

  test("importFromDesktop prints ls hint for multiple workspaces", async () => {
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-a", teamId: "T1", teamName: "Acme", url: "https://acme.slack.com/" },
      { token: "xoxc-b", teamId: "T2", teamName: "Beta", url: "https://beta.slack.com/" },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await importFromDesktop();
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("slack auth ls");
    } finally {
      spy.mockRestore();
    }
  });

  test("importFromDesktop exits when no sessions found", async () => {
    mockExtractSessions.mockResolvedValueOnce([]);
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as () => never);
    try {
      await expect(importFromDesktop()).rejects.toThrow("process.exit(1)");
    } finally {
      mockExit.mockRestore();
    }
  });
});
