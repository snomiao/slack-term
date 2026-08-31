// Mock Slack API server. Serves anonymized fixtures from tests/fixtures/mock/.
//
// Usage:
//   import { startMock, stopMock } from "./mock.ts";
//   const { baseUrl } = await startMock();
//   // ... run CLI with SLACK_API_BASE=baseUrl ...
//   await stopMock();

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "fixtures", "mock");

type Fixtures = Map<string, unknown>;

function fixtureKey(method: string, params: Record<string, string>): string {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return parts ? `${method}__${parts}` : method;
}

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.=&-]/g, "_");
}

/** A fixture value shaped `{ __byAuth: { "Bearer xoxb-...": {...}, "*": {...} } }`
 *  branches its response on the request's Authorization header — lets a test
 *  simulate two tokens hitting the identical method+params (e.g. a bot token
 *  rejected, a user token accepted) without the mock otherwise inspecting
 *  headers. Fixtures without `__byAuth` pass through unchanged. */
function resolveByAuth(fx: unknown, req: IncomingMessage): unknown {
  if (fx && typeof fx === "object" && !Array.isArray(fx) && "__byAuth" in (fx as Record<string, unknown>)) {
    const byAuth = (fx as Record<string, unknown>).__byAuth as Record<string, unknown>;
    const auth = req.headers.authorization ?? "";
    return byAuth[auth] ?? byAuth["*"] ?? { ok: false, error: `no_fixture_for_auth:${auth}` };
  }
  return fx;
}

async function loadFixtures(): Promise<Fixtures> {
  const map: Fixtures = new Map();
  const files = await readdir(MOCK).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(join(MOCK, f), "utf8"));
    map.set(f.replace(/\.json$/, ""), data);
  }
  return map;
}

export type RecordedRequest = {
  method: string;
  httpMethod: string;
  params: Record<string, string>;
  body: string;
  /** Incoming request headers (lowercased keys, per Node's http module) — lets
   *  tests assert on Authorization/Cookie forwarding. */
  headers: Record<string, string | string[] | undefined>;
};

export type MockHandle = {
  baseUrl: string;
  /** Every request the mock served, in order — lets tests assert on POST bodies. */
  requests: RecordedRequest[];
  stop: () => Promise<void>;
};

export type InlineFixtures = Record<string, unknown>;

export async function startMock(
  opts: { port?: number; inline?: InlineFixtures } = {},
): Promise<MockHandle> {
  const { port = 0, inline } = opts;
  const fixtures: Fixtures = inline
    ? new Map(Object.entries(inline))
    : await loadFixtures();

  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = url.pathname.replace(/^\/+api\/+/, "").replace(/^\/+/, "");
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams) params[k] = v;

    const respond = (body: unknown, status = 200): void => {
      let s = status;
      let retryAfterHdr: string | null = null;
      let extraHeaders: Record<string, string> = {};
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const b = body as Record<string, unknown>;
        if (typeof b.__status === "number") s = b.__status;
        if (b.__retryAfter !== undefined) retryAfterHdr = String(b.__retryAfter);
        if (b.__headers && typeof b.__headers === "object") {
          extraHeaders = b.__headers as Record<string, string>;
        }
      }
      res.statusCode = s;
      res.setHeader("Content-Type", "application/json");
      if (retryAfterHdr !== null) res.setHeader("retry-after", retryAfterHdr);
      for (const [hk, hv] of Object.entries(extraHeaders)) res.setHeader(hk, String(hv));
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method, httpMethod: "POST", params, body, headers: req.headers });
        // An inline fixture keyed by the bare method name (e.g. "chat.postMessage":
        // {ok:false,...}) overrides the hardcoded success default below — lets
        // tests simulate a failure on an otherwise-faked write endpoint.
        const override = fixtures.get(safeName(method));
        if (override) {
          respond(resolveByAuth(override, req));
          return;
        }
        // Best-effort lookup: ignore body for fixture lookup. POST endpoints
        // we fake: chat.postMessage, conversations.open.
        if (method === "chat.postMessage") {
          respond({ ok: true, ts: "1700000000.000100", channel: "C00000001" });
          return;
        }
        if (method === "chat.update") {
          respond({ ok: true, ts: "1700000000.000100", channel: "C00000001" });
          return;
        }
        if (method === "chat.delete") {
          respond({ ok: true, ts: "1700000000.000100", channel: "C00000001" });
          return;
        }
        if (method === "chat.scheduleMessage") {
          respond({ ok: true, scheduled_message_id: "Q00000001", channel: "C00000001", post_at: 1700100000 });
          return;
        }
        if (method === "chat.deleteScheduledMessage") {
          respond({ ok: true });
          return;
        }
        if (method === "conversations.open") {
          respond({ ok: true, channel: { id: "C00000099" } });
          return;
        }
        if (method === "conversations.create") {
          respond({ ok: true, channel: { id: "C00000042", name: "new-channel" } });
          return;
        }
        if (method === "conversations.invite") {
          respond({ ok: true, channel: { id: "C00000042" } });
          return;
        }
        if (method === "upload-slot") {
          res.statusCode = 200;
          res.end("uploaded");
          return;
        }
        if (method === "files.completeUploadExternal") {
          respond({ ok: true, files: [{ id: "F00000001", permalink: "https://acme.slack.com/files/U00000001/F00000001/test.txt" }] });
          return;
        }
        const key = safeName(fixtureKey(method, {}));
        const fx = fixtures.get(key);
        if (fx) respond(resolveByAuth(fx, req));
        else respond({ ok: false, error: `no_fixture:${key}` }, 200);
      });
      return;
    }

    requests.push({ method, httpMethod: "GET", params, body: "", headers: req.headers });

    // Special GET handlers that need dynamic content
    if (method === "files.getUploadURLExternal") {
      respond({ ok: true, upload_url: `http://${req.headers.host}/api/upload-slot`, file_id: "F00000001" });
      return;
    }

    const key = safeName(fixtureKey(method, params));
    const fx = fixtures.get(key);
    if (fx) {
      respond(resolveByAuth(fx, req));
      return;
    }
    // Fall back: ignore params (so minor param drift still returns something).
    const looseKey = safeName(method);
    const loose = fixtures.get(looseKey);
    if (loose) {
      respond(resolveByAuth(loose, req));
      return;
    }
    respond({ ok: false, error: `no_fixture:${key}` }, 200);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to start mock");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        // A `server.close()` alone waits for every existing keep-alive
        // connection to finish. Tests abort poll loops while an HTTP request is
        // still in flight, so the client may never close its socket; the
        // teardown then hangs forever and the worker never moves on to the next
        // test file. Closing connections explicitly makes `stop()` finish even
        // when a keep-alive socket was left behind.
        //
        // The timer is the part that matters, and it is NOT belt-and-braces:
        // `closeAllConnections` is optional (hence `?.`), and where it is
        // missing — or does not reach a socket wedged mid-response — `close()`
        // never calls back and NOTHING reports it. Vitest has no timeout for
        // this: testTimeout and hookTimeout both sit above `afterAll`, so the
        // run simply stops with the last test still marked green. That is
        // exactly how this suite burned the whole CI budget after
        // `slack.test.ts`'s final test, with no failing test to point at.
        //
        // Resolving rather than rejecting is deliberate: the tests are over by
        // now, and a leaked listener in a worker that is about to exit is not
        // worth failing a build for. Being slow to reap a socket must not look
        // like a broken test suite.
        let settled = false;
        const done = (err?: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        };
        const timer = setTimeout(() => done(), 2000);
        // Do not hold the process open for this timer alone.
        (timer as unknown as { unref?: () => void }).unref?.();
        server.close((err) => done(err));
        server.closeAllConnections?.();
      }),
  };
}
