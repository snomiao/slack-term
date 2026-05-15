// Tests for ts/auth.ts — uses a mock HTTP server and temp HOME dir.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, type MockHandle } from "./mock.ts";

// Module-level mocks (hoisted by Vitest before imports).
vi.mock("../ts/slack-app.ts", () => ({
  extractSessions: vi.fn().mockResolvedValue([]),
}));

// Shared readline answer queue — mutated per-test before calling cmdAuthLogin.
const rlState = { answers: [] as string[], idx: 0 };

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn().mockImplementation(() => ({
    question: vi.fn().mockImplementation(() =>
      Promise.resolve(rlState.answers[rlState.idx++] ?? ""),
    ),
    close: vi.fn(),
  })),
}));

// Static imports — works because auth.ts and profiles.ts have no module-level mutable state.
// Filesystem isolation comes from process.env.HOME = tmpHome (profiles.ts uses process.env.HOME).
import { cmdAuthLogin, importFromDesktop } from "../ts/auth.ts";
import { listProfiles, addProfile, useProfile } from "../ts/profiles.ts";
import { extractSessions } from "../ts/slack-app.ts";

// vi.mocked is not available in Bun's test runner — use a direct cast instead.
type MockFn<T extends (...args: unknown[]) => unknown> = T & {
  mockResolvedValueOnce: (v: Awaited<ReturnType<T>> | never) => void;
};
const mockExtractSessions = extractSessions as unknown as MockFn<typeof extractSessions>;

let tmpHome: string;
let tmpCwd: string;
let origCwd: string;
let mock: MockHandle;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "slack-auth-test-"));
  tmpCwd = mkdtempSync(join(tmpdir(), "slack-auth-cwd-"));
  origCwd = process.cwd();
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
  delete process.env.HOME;
  delete process.env.SLACK_MCP_XOXP_TOKEN;
  delete process.env.SLACK_MCP_XOXD_COOKIE;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
});

function setTTY(val: boolean | undefined) {
  Object.defineProperty(process.stdin, "isTTY", { value: val, configurable: true });
}

describe("auth.ts", () => {
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
    rlState.answers = ["2", "1", "xoxp-fake", ""];
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxp-fake");
    } finally {
      setTTY(undefined);
    }
  });

  test("cmdAuthLogin TTY choice 2 (existing app, bot token) saves profile", async () => {
    setTTY(true);
    rlState.answers = ["2", "2", "xoxb-fake", ""];
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxb-fake");
    } finally {
      setTTY(undefined);
    }
  });

  test("cmdAuthLogin TTY choice 3 (new user app) saves profile", async () => {
    setTTY(true);
    rlState.answers = ["3", "xoxp-fake", "my-workspace"];
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
    rlState.answers = ["4", "xoxb-fake", ""];
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxb-fake");
    } finally {
      setTTY(undefined);
    }
  });

  test("cmdAuthLogin TTY choice 1 (desktop import) calls importFromDesktop", async () => {
    mockExtractSessions.mockResolvedValueOnce([
      { token: "xoxc-desk", teamId: "T1", teamName: "Desk", url: "https://desk.slack.com/" },
    ]);
    setTTY(true);
    rlState.answers = ["1"];
    try {
      await cmdAuthLogin({});
      expect(listProfiles()[0]?.profile.token).toBe("xoxc-desk");
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
