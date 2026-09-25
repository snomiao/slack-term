import { test, expect } from "./harness.ts";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dirname, "../ts/cli.ts");
const target = "C00000001:1700000000.000100";
type Call = { method: string; body: Record<string, unknown>; authorization: string | undefined; cookie: string | undefined };
type Reply = { ok: boolean; error?: string; channels?: { id: string; name: string }[] };

async function fixture(handle: (call: Call, calls: Call[]) => Reply | Promise<Reply> = () => ({ ok: true })) {
  const calls: Call[] = [];
  const directory = mkdtempSync(join(tmpdir(), "slack-agent-test-"));
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const call = {
      method: new URL(req.url!, "http://localhost").pathname.slice(1),
      body: text ? JSON.parse(text) as Record<string, unknown> : {},
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    };
    calls.push(call);
    const body = await handle(call, calls);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing mock port");
  const children: ReturnType<typeof spawn>[] = [];
  const start = (args: string[], extraEnv: Record<string, string> = {}) => {
    const child = spawn("bun", [cli, "agent", ...args], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        SLACK_API_BASE: `http://127.0.0.1:${address.port}`,
        SLACK_BOT_TOKEN: "xoxb-fake",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data: Buffer) => { stdout += String(data); });
    child.stderr!.on("data", (data: Buffer) => { stderr += String(data); });
    const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      child.on("error", reject);
      child.on("close", (code) => done({ code, stdout, stderr }));
    });
    return { child, result };
  };
  return {
    calls, start,
    async close() {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const script = (source: string) => ["--", "bun", "-e", source];
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await wait(10);
  }
}

test("agent status and rename send exact bodies, bot auth, and no cookie or discovery", async () => {
  const f = await fixture();
  try {
    const r = await f.start(["status", target, "suspended", "--title", "Review"], {
      SLACK_TOKEN: "xoxc-fake", SLACK_COOKIE: "xoxd-fake",
    }).result;
    expect(r.code).toBe(0);
    expect(f.calls.map((c) => [c.method, c.body])).toEqual([
      ["agents.sessions.setStatus", { channel_id: "C00000001", thread_ts: "1700000000.000100", status: "suspended" }],
      ["agents.sessions.rename", { channel_id: "C00000001", thread_ts: "1700000000.000100", title: "Review" }],
    ]);
    expect(f.calls.every((c) => c.authorization === "Bearer xoxb-fake" && c.cookie === undefined)).toBe(true);
  } finally { await f.close(); }
});

test("permalink uses parent root and explicitly selected bot", async () => {
  const f = await fixture();
  try {
    const r = await f.start([
      "status", "https://acme.slack.com/archives/D00000001/p1700000000000200?thread_ts=1700000000.000100", "active",
      "--bot-token-env", "AGENT_BOT_TOKEN",
    ], { AGENT_BOT_TOKEN: "xoxb-agent" }).result;
    expect(r.code).toBe(0);
    expect(f.calls[0]?.body).toEqual({ channel_id: "D00000001", thread_ts: "1700000000.000100", status: "active" });
    expect(f.calls[0]?.authorization).toBe("Bearer xoxb-agent");
    expect(f.calls.length).toBe(1);
  } finally { await f.close(); }
});

test("channel names resolve using the bot", async () => {
  const f = await fixture((c) => c.method === "conversations.list"
    ? { ok: true, channels: [{ id: "C00000001", name: "general" }] } : { ok: true });
  try {
    expect((await f.start(["status", "#general:1700000000.000100", "closed"]).result).code).toBe(0);
    expect(f.calls.map((c) => c.method)).toEqual(["conversations.list", "agents.sessions.setStatus"]);
    expect(f.calls.every((c) => c.authorization === "Bearer xoxb-fake")).toBe(true);
  } finally { await f.close(); }
});

test("run sets processing before command, refreshes, preserves argv/stdio, then clears", async () => {
  const f = await fixture();
  try {
    const running = f.start(["run", target, "--every", "0.05", "--title", "Work", ...script(
      'console.log(JSON.stringify(process.argv.slice(1))); console.error("child stderr"); setTimeout(() => {}, 250)',
    ), "--", "007", "a b", "--title", "child"]);
    const r = await running.result;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('["007","a b","--title","child"]');
    expect(r.stderr).toContain("child stderr");
    expect(f.calls[0]?.body.status).toBe("processing");
    expect(f.calls[1]?.method).toBe("agents.sessions.rename");
    expect(f.calls.filter((c) => c.body.status === "processing").length).toBeGreaterThan(1);
    expect(f.calls.at(-1)?.body.status).toBe("active");
    expect(f.calls.filter((c) => c.body.status === "active").length).toBe(1);
  } finally { await f.close(); }
});

test("command failure keeps exit code and still clears", async () => {
  const f = await fixture();
  try {
    expect((await f.start(["run", target, ...script("process.exit(7)")]).result).code).toBe(7);
    expect(f.calls.map((c) => c.body.status)).toEqual(["processing", "active"]);
  } finally { await f.close(); }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  test(`${sig} forwards to command and clears before wrapper exits`, async () => {
    const f = await fixture();
    try {
      const running = f.start(["run", target, "--every", "0.05", ...script(
        `process.on("${sig}", () => { console.log("child stopped"); process.exit(0); }); console.log("ready"); setInterval(() => {}, 1000)`,
      )]);
      let ready = false;
      running.child.stdout!.on("data", (data: Buffer) => { if (String(data).includes("ready")) ready = true; });
      await until(() => ready);
      running.child.kill(sig);
      const r = await running.result;
      expect(r.code).toBe(sig === "SIGINT" ? 130 : 143);
      expect(r.stdout).toContain("child stopped");
      expect(f.calls.at(-1)?.body.status).toBe("active");
    } finally { await f.close(); }
  });
}

test("refresh failures are logged and retried without stopping command", async () => {
  const f = await fixture((c, calls) => c.body.status === "processing" && calls.length === 2
    ? { ok: false, error: "internal_error" } : { ok: true });
  try {
    const r = await f.start(["run", target, "--every", "0.05", ...script('setTimeout(() => console.log("finished"), 250)')]).result;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("finished");
    expect(r.stderr).toContain("heartbeat failed");
    expect(f.calls.filter((c) => c.body.status === "processing").length).toBeGreaterThan(2);
    expect(f.calls.at(-1)?.body.status).toBe("active");
  } finally { await f.close(); }
});

test("SIGTERM during initial status waits for cleanup and never launches command", async () => {
  const f = await fixture(async (c) => {
    if (c.body.status === "processing") await wait(150);
    return { ok: true };
  });
  try {
    const running = f.start(["run", target, ...script('console.log("must not run")')]);
    await until(() => f.calls.length === 1);
    running.child.kill("SIGTERM");
    const r = await running.result;
    expect(r.code).toBe(143);
    expect(r.stdout).toBe("");
    expect(f.calls.map((c) => c.body.status)).toEqual(["processing", "active"]);
  } finally { await f.close(); }
});

test("repeated interrupts during final clear do not skip its acknowledgement", async () => {
  let cleared = false;
  const f = await fixture(async (c) => {
    if (c.body.status === "active") {
      await wait(200);
      cleared = true;
    }
    return { ok: true };
  });
  try {
    const running = f.start(["run", target, ...script("setTimeout(() => {}, 100)")]);
    await until(() => f.calls.some((c) => c.body.status === "active"));
    running.child.kill("SIGTERM");
    await wait(20);
    running.child.kill("SIGINT");
    expect((await running.result).code).toBe(143);
    expect(cleared).toBe(true);
  } finally { await f.close(); }
});

test("in-flight refresh finishes before final clear, with no later processing", async () => {
  const completed: unknown[] = [];
  const f = await fixture(async (c, calls) => {
    if (calls.length === 2) await wait(250);
    completed.push(c.body.status);
    return { ok: true };
  });
  try {
    expect((await f.start(["run", target, "--every", "0.03", ...script("setTimeout(() => {}, 100)")]).result).code).toBe(0);
    expect(completed).toEqual(["processing", "processing", "active"]);
  } finally { await f.close(); }
});

for (const exit of [0, 7]) {
  test(`final clear failure reports error and preserves command exit ${exit || "success as failure"}`, async () => {
    const f = await fixture((c) => c.body.status === "active" ? { ok: false, error: "internal_error" } : { ok: true });
    try {
      const r = await f.start(["run", target, ...script(`process.exit(${exit})`)]).result;
      expect(r.code).toBe(exit || 1);
      expect(r.stderr).toContain("final status clear failed");
    } finally { await f.close(); }
  });
}

test("close flag and spawn failure still clean up", async () => {
  const f = await fixture();
  try {
    expect((await f.start(["run", target, "--close", "--", "/nonexistent/slack-agent-command"]).result).code).toBe(127);
    expect(f.calls.map((c) => c.body.status)).toEqual(["processing", "closed"]);
  } finally { await f.close(); }
});

test("rename failure prevents command and clears the already-started session", async () => {
  const f = await fixture((c) => c.method.endsWith("rename") ? { ok: false, error: "internal_error" } : { ok: true });
  try {
    const r = await f.start(["run", target, "--title", "Work", ...script('console.log("must not run")')]).result;
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("must not run");
    expect(f.calls.at(-1)?.body.status).toBe("active");
  } finally { await f.close(); }
});

test("initial status failure does not launch command; uncertain write still gets cleanup", async () => {
  const f = await fixture((c) => c.body.status === "processing" ? { ok: false, error: "feature_disabled" } : { ok: true });
  try {
    const r = await f.start(["run", target, ...script('console.log("must not run")')]).result;
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("feature_disabled");
    expect(f.calls.at(-1)?.body.status).toBe("active");
  } finally { await f.close(); }
});

test("user tokens and missing selected bot are refused without API calls or leaking values", async () => {
  const f = await fixture();
  try {
    for (const token of ["xoxp-fake", "xoxc-fake", ""]) {
      const r = await f.start(["status", target, "active", "--bot-token-env", "AGENT_BOT_TOKEN"], {
        AGENT_BOT_TOKEN: token, SLACK_TOKEN: "xoxp-fake",
      }).result;
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("user tokens are refused");
      if (token) expect(r.stderr).not.toContain(token);
    }
    const r = await f.start(["run", target, ...script("process.exit(0)")], { SLACK_BOT_TOKEN: "xoxp-fake" }).result;
    expect(r.code).toBe(1);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test("invalid arguments fail before API calls", async () => {
  const f = await fixture();
  try {
    for (const args of [
      ["run", target],
      ["run", target, "--every", "0", ...script("process.exit(0)")],
      ["run", target, "--every", "3600", ...script("process.exit(0)")],
      ["status", "C00000001", "active"],
      ["status", target, "thinking"],
      ["status", target, "active", "--title", ""],
      ["status", target, "active", "--title", "a".repeat(201)],
    ]) expect((await f.start(args).result).code).toBe(1);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});
