// `slack relay init` / `slack relay health` (ts/relayInit.ts), and the
// `slack-term/worker` package export the scaffold depends on.

import { describe, test, expect, beforeEach, afterEach, vi } from "./harness.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPATIBILITY_DATE, DEFAULT_DIR, WRANGLER_VERSION, initRelay, initReport, nextSteps, relayFiles, relayHealth,
  validWorkerName, workerNameFrom,
} from "../ts/relayInit.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string; exports: Record<string, string>; files: string[];
  peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional?: boolean }>;
};
/** JSONC → JSON for the simple configs here (whole-line // comments only). */
const jsonc = (s: string): unknown => JSON.parse(s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slack-relay-init-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Every file under `d`, relative, sorted. */
function walk(d: string, pre = ""): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]).sort();
}

describe("scaffold contents", () => {
  test("pins match the repo's own worker/ (wrangler version, compatibility date)", () => {
    const wp = JSON.parse(readFileSync(join(ROOT, "worker", "package.json"), "utf8")) as { scripts: { deploy: string } };
    expect(wp.scripts.deploy).toContain(`wrangler@${WRANGLER_VERSION}`);
    const wc = jsonc(readFileSync(join(ROOT, "worker", "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    expect(wc.compatibility_date).toBe(COMPATIBILITY_DATE);
  });

  test("wrangler.jsonc matches worker/wrangler.jsonc except the name", () => {
    const files = relayFiles("my-relay");
    const got = jsonc(files["wrangler.jsonc"]!) as Record<string, unknown>;
    const want = jsonc(readFileSync(join(ROOT, "worker", "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    expect(got).toEqual({ ...want, name: "my-relay" });
    expect(got.observability).toEqual({ enabled: false });
  });

  test("package.json: private, slack-term pinned to this version, wrangler pinned", () => {
    const p = JSON.parse(relayFiles("r")["package.json"]!) as Record<string, any>;
    expect(p.private).toBe(true);
    expect(p.dependencies).toEqual({ "slack-term": rootPkg.version });
    expect(p.devDependencies).toEqual({ wrangler: WRANGLER_VERSION });
    expect(p.engines.node).toBe(">=22");
    expect(JSON.parse(relayFiles("r", { slackTerm: "file:../x" })["package.json"]!).dependencies["slack-term"]).toBe("file:../x");
  });

  test("src/index.ts re-exports the handler and the Durable Object class", () => {
    expect(relayFiles("r")["src/index.ts"]).toContain('export { default, Relay } from "slack-term/worker";');
  });

  test(".gitignore keeps secrets and build output out", () => {
    const g = relayFiles("r")[".gitignore"]!.split("\n");
    for (const p of ["node_modules/", ".wrangler/", ".dev.vars*", ".env*"]) expect(g).toContain(p);
  });

  test("README carries the steps with a placeholder token", () => {
    const r = relayFiles("my-relay")["README.md"]!;
    expect(r).toContain("# my-relay");
    expect(r).toContain("wrangler secret put SLACK_SIGNING_SECRET");
    expect(r).toContain("<RELAY_TOKEN>");
    expect(r).toContain("https://my-relay.<your-subdomain>.workers.dev/slack/events");
  });

  test("next steps name everything a first deploy needs", () => {
    const s = nextSteps("my-relay", "tok123");
    for (const want of [
      "Node >= 22", "npx wrangler login", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "npx wrangler deploy",
      "secret put SLACK_SIGNING_SECRET", "secret put RELAY_TOKEN", "secret put SLACK_TEAM_ID",
      "/slack/events", "message.channels", "message.groups", "message.im", "app_mention", "message.mpim", "mpim:history",
      "SLACK_RELAY_URL=", "SLACK_RELAY_TOKEN=tok123", "/health", "relay connected (websocket)",
    ]) expect(s).toContain(want);
  });
});

describe("worker names", () => {
  test("valid names", () => {
    for (const n of ["a", "slack-term-relay", "r2", "a".repeat(63)]) expect(validWorkerName(n)).toBe(true);
    for (const n of ["", "-a", "a-", "A", "a_b", "a".repeat(64)]) expect(validWorkerName(n)).toBe(false);
  });
  test("derived from the folder's basename", () => {
    expect(workerNameFrom("/x/My_Relay.v2")).toBe("my-relay-v2");
    expect(workerNameFrom("rel")).toBe("rel");
    expect(workerNameFrom("/x/___")).toBe(DEFAULT_DIR);
    expect(validWorkerName(workerNameFrom(`/x/${"ab-".repeat(30)}`))).toBe(true);
  });
});

describe("initRelay", () => {
  const fixed = () => Buffer.alloc(32, 0xab);

  test("writes the five files, returns a 32-byte hex token that no file contains", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const target = join(dir, "My Relay");
      const r = initRelay(target);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.name).toBe("my-relay");
      expect(walk(target)).toEqual([".gitignore", "README.md", "package.json", "src/index.ts", "wrangler.jsonc"]);
      expect(r.token).toMatch(/^[0-9a-f]{64}$/);
      for (const f of walk(target)) expect(readFileSync(join(target, f), "utf8")).not.toContain(r.token);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("uses the injected randomness", () => {
    const r = initRelay(join(dir, "r"), {}, fixed);
    expect(r.ok && r.token).toBe("ab".repeat(32));
  });

  test("--name overrides the folder name; an invalid one is refused before writing", () => {
    const r = initRelay(join(dir, "r"), { name: "prod-relay" }, fixed);
    expect(r.ok && r.name).toBe("prod-relay");
    expect(readFileSync(join(dir, "r", "wrangler.jsonc"), "utf8")).toContain('"name": "prod-relay"');
    const bad = initRelay(join(dir, "s"), { name: "Bad_Name" }, fixed);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('invalid worker name "Bad_Name"');
    expect(existsSync(join(dir, "s"))).toBe(false);
  });

  test("an existing folder without clashes is fine", () => {
    writeFileSync(join(dir, "notes.txt"), "keep");
    expect(initRelay(dir, {}, fixed).ok).toBe(true);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("keep");
  });

  test("refuses to overwrite any existing file, writing nothing; --force replaces", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "mine");
    const r = initRelay(dir, {}, fixed);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--force");
    expect(r.existing).toEqual(["src/index.ts"]);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
    expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toBe("mine");

    expect(initRelay(dir, { force: true }, fixed).ok).toBe(true);
    expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toContain("slack-term/worker");
  });

  test("the report prints the token, the files and the steps", () => {
    const r = initRelay(join(dir, "r"), {}, fixed);
    if (!r.ok) throw new Error(r.error);
    const out = initReport(r, dir);
    expect(out).toContain("ab".repeat(32));
    expect(out).toContain("not saved anywhere");
    expect(out).toContain("cd r\n");
    expect(out).toContain("  wrangler.jsonc");
    expect(out).toContain("SLACK_RELAY_TOKEN=" + "ab".repeat(32));
    // Outside cwd: the absolute path.
    expect(initReport(r, "/elsewhere")).toContain(`cd ${r.dir}\n`);
  });
});

describe("relayHealth", () => {
  const reply = (status: number, body: string) => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

  test("not configured → 2, without a request", async () => {
    const f = reply(200, "{}");
    expect((await relayHealth(undefined, "t", f)).code).toBe(2);
    expect((await relayHealth("https://r.example", undefined, f)).code).toBe(2);
    expect(f).not.toHaveBeenCalled();
  });

  test("ok → 0, GET /health with the bearer (trailing slash tolerated)", async () => {
    const f = reply(200, JSON.stringify({ ok: true, latest: 3 }));
    const r = await relayHealth("https://r.example/", "sekrit", f);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"latest": 3');
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://r.example/health");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sekrit");
  });

  test("failures → 1", async () => {
    expect((await relayHealth("https://r", "t", reply(401, "unauthorized"))).out).toContain("does not match");
    expect((await relayHealth("https://r", "t", reply(500, "boom"))).out).toContain("HTTP 500 from https://r/health: boom");
    expect((await relayHealth("https://r", "t", reply(404, ""))).out).toBe("slack relay health: HTTP 404 from https://r/health");
    expect((await relayHealth("https://r", "t", reply(200, "<html>"))).out).toContain("not a slack-term relay");
    const notOk = await relayHealth("https://r", "t", reply(200, JSON.stringify({ ok: false })));
    expect(notOk.code).toBe(1);
    const down = await relayHealth("https://r", "t", vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    expect(down.code).toBe(1);
    expect(down.out).toContain("cannot reach https://r/health: ECONNREFUSED");
    const odd = await relayHealth("https://r", "t", vi.fn(async () => { throw "weird"; }) as unknown as typeof fetch);
    expect(odd.out).toContain("weird");
  });
});

describe("package export slack-term/worker", () => {
  test("package.json: exports, files and an optional workers-types peer", () => {
    expect(rootPkg.exports["./worker"]).toBe("./worker/src/index.ts");
    expect(rootPkg.files).toContain("worker/src/");
    expect(rootPkg.peerDependencies["@cloudflare/workers-types"]).toBeDefined();
    expect(rootPkg.peerDependenciesMeta["@cloudflare/workers-types"]?.optional).toBe(true);
  });

  test("resolves from a project that depends on slack-term", () => {
    const proj = join(dir, "proj");
    mkdirSync(join(proj, "node_modules"), { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", private: true, dependencies: { "slack-term": `file:${ROOT}` } }));
    symlinkSync(ROOT, join(proj, "node_modules", "slack-term"), "dir");
    const req = createRequire(join(proj, "package.json"));
    const resolved = req.resolve("slack-term/worker");
    expect(resolved.endsWith(join("worker", "src", "index.ts"))).toBe(true);
    expect(req.resolve("slack-term/package.json").endsWith("package.json")).toBe(true);
    // The deep path is NOT exposed: only the exports map is.
    expect(() => req.resolve("slack-term/worker/src/hub.ts")).toThrow();
  });

  test("the exported module has the default handler, Relay and Env", () => {
    const src = readFileSync(join(ROOT, rootPkg.exports["./worker"]!), "utf8");
    expect(src).toMatch(/^export default \{/m);
    expect(src).toMatch(/^export class Relay extends DurableObject<Env>/m);
    expect(src).toMatch(/^export interface Env \{/m);
  });
});
