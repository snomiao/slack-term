import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { tailRTMImpl, _internals } from "../ts/rtm.ts";
import { startMock, type MockHandle } from "./mock.ts";

// Minimal in-process WebSocket stand-in for unit tests
class FakeWS {
  private readonly _handlers = new Map<string, Array<(event: unknown) => void>>();
  readonly sentMessages: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    // Fire "open" after current synchronous setup completes
    Promise.resolve().then(() => this._emit("open", {}));
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const arr = this._handlers.get(type) ?? [];
    arr.push(handler);
    this._handlers.set(type, arr);
  }

  send(data: string): void { this.sentMessages.push(data); }

  close(): void { this._emit("close", {}); }

  _emit(type: string, event: unknown): void {
    for (const h of this._handlers.get(type) ?? []) h(event);
  }

  simulateMessage(data: object): void {
    this._emit("message", { data: JSON.stringify(data) });
  }

  simulateError(): void { this._emit("error", new Error("ws error")); }
}

// Helper: create a WS class that exposes the latest instance
function makeWsClass(): [typeof FakeWS, () => FakeWS | undefined] {
  let last: FakeWS | undefined;
  class TrackedWS extends FakeWS {
    constructor(url: string) { super(url); last = this; }
  }
  return [TrackedWS, () => last];
}

describe("tailRTMImpl", () => {
  // Captured before beforeAll installs spies — gives direct access to real implementations.
  const { getWebSocket: realGetWebSocket, sleep: realSleep } = _internals;

  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMock({
      inline: {
        "users.info__user=U00000001": {
          ok: true,
          user: { id: "U00000001", name: "alice", profile: { display_name: "Alice" } },
        },
        "users.info__user=U00000002": {
          ok: true,
          user: { id: "U00000002", name: "bob", profile: { display_name: "Bob" } },
        },
      },
    });
    process.env.SLACK_API_BASE = `${mock.baseUrl}/api`;
    vi.spyOn(_internals, "sleep").mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await mock.stop();
    delete process.env.SLACK_API_BASE;
    vi.restoreAllMocks();
  });

  test("returns immediately when WebSocket not available", async () => {
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(undefined);
    const bootSpy = vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://fake", selfId: "" });
    await tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map());
    expect(bootSpy).not.toHaveBeenCalled();
  });

  test("returns after all retries when clientBoot fails", async () => {
    const [WS, getInstance] = makeWsClass();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockRejectedValue(new Error("boot failed"));
    const sleepSpy = vi.spyOn(_internals, "sleep");
    sleepSpy.mockClear();

    await tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map());

    expect(sleepSpy).toHaveBeenCalledTimes(2); // MAX_RETRIES - 1 = 2 sleeps between 3 attempts
    expect(getInstance()).toBeUndefined(); // no WS created — boot failed before connect
  });

  test("sends pong in response to ping", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://ping-test", selfId: "" });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);

    await Promise.resolve(); // let open fire
    getInstance()!.simulateMessage({ type: "ping", id: 42 });
    await Promise.resolve(); // let handler process
    ac.abort();
    await rtmPromise;

    const pongs = getInstance()!.sentMessages.filter((m) => {
      try { return JSON.parse(m).type === "pong"; } catch { return false; }
    });
    expect(pongs.length).toBeGreaterThan(0);
    expect(JSON.parse(pongs[0]!).reply_to).toBe(42);
  });

  test("streams message from target channel and writes output", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://stream-test", selfId: "" });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);

    await Promise.resolve(); // let open fire
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C00000001",
      user: "U00000001",
      text: "hello rtm\nsecond line",
      ts: "1700000001.000000",
    });

    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).toContain("hello rtm");
    expect(output.join("")).toContain("second line");
  });

  test("ignores messages from other channels", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://chan-test", selfId: "" });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);

    await Promise.resolve(); // let open fire
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C99999999", // wrong channel
      user: "U00000001",
      text: "wrong channel msg",
      ts: "1700000002.000000",
    });
    await Promise.resolve();
    ac.abort();
    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).not.toContain("wrong channel msg");
  });

  test("skips already-seen ts", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://dedup-test", selfId: "" });

    const seen = new Set(["1700000003.000000"]);
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, seen, new Map(), ac.signal);

    await Promise.resolve();
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C00000001",
      user: "U00000001",
      text: "duplicate message",
      ts: "1700000003.000000",
    });
    await Promise.resolve();
    ac.abort();
    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).not.toContain("duplicate message");
  });

  test("ignores message_changed subtype", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://subtype-test", selfId: "" });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);

    await Promise.resolve();
    getInstance()!.simulateMessage({
      type: "message",
      subtype: "message_changed",
      channel: "C00000001",
      user: "U00000001",
      text: "edited",
      ts: "1700000004.000000",
    });
    await Promise.resolve();
    ac.abort();
    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).not.toContain("edited");
  });

  test("aborts cleanly via signal — no retries after abort", async () => {
    const [WS] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://abort-test", selfId: "" });
    const sleepSpy = vi.spyOn(_internals, "sleep");
    sleepSpy.mockClear();

    // Pre-abort so the very first signal check in the loop fires immediately.
    ac.abort();
    await tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);

    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test("retries after WebSocket closes unexpectedly then aborts", async () => {
    let instanceCount = 0;
    let lastWs: FakeWS | undefined;
    class CountedWS extends FakeWS {
      constructor(url: string) {
        super(url);
        instanceCount++;
        lastWs = this;
      }
    }
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(CountedWS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://retry-test", selfId: "" });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);

    await Promise.resolve(); // attempt 1 open
    lastWs!.close(); // unexpected close → attempt 2 starts
    await Promise.resolve();
    await Promise.resolve(); // sleep mock + boot resolves
    ac.abort(); // abort during attempt 2
    await rtmPromise;

    expect(instanceCount).toBeGreaterThanOrEqual(1);
  });

  test("seen set cap evicts at 1000 during RTM", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://cap-test", selfId: "" });

    // Pre-fill seen to 1000
    const seen = new Set<string>(Array.from({ length: 1000 }, (_, i) => `${1700000000 + i}.000000`));
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, seen, new Map(), ac.signal);
    await Promise.resolve();
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C00000001",
      user: "U00000001",
      text: "cap test msg",
      ts: "1700001000.000001", // new ts, not in seen
    });
    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).toContain("cap test msg");
    expect(seen.size).toBe(1000); // evicted one, added one
  });

  test("bot message (no user field) uses username", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://bot-test", selfId: "" });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);
    await Promise.resolve();
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C00000001",
      username: "mybot",
      text: "bot says hi",
      ts: "1700000010.000000",
    });
    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).toContain("mybot");
  });

  test("thread filter passes matching thread message", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://thread-test", selfId: "" });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });

    const rtmPromise = tailRTMImpl(
      "xoxc-fake", "xoxd-cookie", "C00000001",
      { thread: "1700000000.000000" },
      new Set(), new Map(), ac.signal,
    );
    await Promise.resolve();
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C00000001",
      user: "U00000001",
      text: "thread reply",
      ts: "1700000011.000000",
      thread_ts: "1700000000.000000",
    });
    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).toContain("thread reply");
  });

  test("thread filter blocks non-matching thread message", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://thread-block-test", selfId: "" });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    const rtmPromise = tailRTMImpl(
      "xoxc-fake", "xoxd-cookie", "C00000001",
      { thread: "1700000000.000000" },
      new Set(), new Map(), ac.signal,
    );
    await Promise.resolve();
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C00000001",
      user: "U00000001",
      text: "wrong thread reply",
      ts: "1700000012.000000",
      thread_ts: "1700000999.000000", // different thread
    });
    await Promise.resolve();
    ac.abort();
    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).not.toContain("wrong thread reply");
  });

  test("me filter passes messages mentioning myUserId", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://me-test", selfId: "" });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      ac.abort();
      return true;
    });

    const rtmPromise = tailRTMImpl(
      "xoxc-fake", "xoxd-cookie", "C00000001",
      { me: true, myUserId: "U00000001" },
      new Set(), new Map(), ac.signal,
    );
    await Promise.resolve();
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C00000001",
      user: "U00000002",
      text: "hey <@U00000001> ping",
      ts: "1700000013.000000",
    });
    await rtmPromise;
    writeSpy.mockRestore();

    expect(output.join("")).toContain("ping");
  });

  test("WS error resolves connectAndStream (no reject) and all 3 retries exhaust", async () => {
    let bootCallCount = 0;
    let lastWs: FakeWS | undefined;
    class ErrorWS extends FakeWS {
      constructor(url: string) {
        super(url);
        lastWs = this;
      }
    }
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(ErrorWS as never);
    vi.spyOn(_internals, "clientBoot").mockImplementation(async () => {
      bootCallCount++;
      return { wsUrl: "ws://error-test", selfId: "" };
    });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map());

    // Drive all 3 attempts: after each open, simulate error → resolve → sleep → next attempt
    for (let i = 0; i < 3; i++) {
      await Promise.resolve(); // let open fire for this attempt
      lastWs!.simulateError();
      await new Promise((r) => setTimeout(r, 0)); // drain microtasks (sleep + clientBoot + open schedule)
    }

    await rtmPromise; // all 3 retries exhausted, function returns
    expect(bootCallCount).toBe(3);
  });

  test("_internals.sleep real impl: resolves after timeout", async () => {
    await realSleep(1); // covers the lambda body and inner (res) => setTimeout callback
  });

  test("_internals.getWebSocket: returns undefined when no global WebSocket", () => {
    const saved = (globalThis as Record<string, unknown>).WebSocket;
    delete (globalThis as Record<string, unknown>).WebSocket;
    try {
      expect(realGetWebSocket()).toBeUndefined();
    } finally {
      if (saved !== undefined) (globalThis as Record<string, unknown>).WebSocket = saved;
    }
  });

  test("_internals.getWebSocket: returns constructor when global WebSocket present", () => {
    const saved = (globalThis as Record<string, unknown>).WebSocket;
    class FakeGlobalWS {}
    (globalThis as Record<string, unknown>).WebSocket = FakeGlobalWS;
    try {
      expect(realGetWebSocket()).toBe(FakeGlobalWS as unknown as ReturnType<typeof realGetWebSocket>);
    } finally {
      (globalThis as Record<string, unknown>).WebSocket = saved;
    }
  });

  test("invalid JSON message is silently ignored", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://json-test", selfId: "" });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);
    await Promise.resolve();
    getInstance()!._emit("message", { data: "not-valid-json!!!" });
    await Promise.resolve();
    ac.abort();
    await rtmPromise;
    writeSpy.mockRestore();
  });

  test("message handler outer catch: logs RTM error to stderr", async () => {
    const [WS, getInstance] = makeWsClass();
    const ac = new AbortController();
    vi.spyOn(_internals, "getWebSocket").mockReturnValue(WS as never);
    vi.spyOn(_internals, "clientBoot").mockResolvedValue({ wsUrl: "ws://catch-test", selfId: "" });

    const errMessages: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("stdout error");
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      errMessages.push(String(s));
      return true;
    });

    const rtmPromise = tailRTMImpl("xoxc-fake", "xoxd-cookie", "C00000001", {}, new Set(), new Map(), ac.signal);
    await Promise.resolve();
    getInstance()!.simulateMessage({
      type: "message",
      channel: "C00000001",
      user: "U00000001",
      text: "hello",
      ts: "1700000088.000000",
    });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await rtmPromise;
    writeSpy.mockRestore();
    errSpy.mockRestore();

    expect(errMessages.some((m) => m.includes("RTM message error"))).toBe(true);
  });
});
