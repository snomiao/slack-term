// Mock Slack API server. Serves anonymized fixtures from tests/fixtures/anon/.
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
const ANON = join(HERE, "fixtures", "anon");

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

async function loadFixtures(): Promise<Fixtures> {
  const map: Fixtures = new Map();
  const files = await readdir(ANON).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(join(ANON, f), "utf8"));
    map.set(f.replace(/\.json$/, ""), data);
  }
  return map;
}

export type MockHandle = {
  baseUrl: string;
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

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = url.pathname.replace(/^\/+api\/+/, "").replace(/^\/+/, "");
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams) params[k] = v;

    const respond = (body: unknown, status = 200): void => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        // Best-effort lookup: ignore body for fixture lookup. POST endpoints
        // we fake: chat.postMessage, conversations.open.
        if (method === "chat.postMessage") {
          respond({ ok: true, ts: "1700000000.000100", channel: "C00000001" });
          return;
        }
        if (method === "conversations.open") {
          respond({ ok: true, channel: { id: "C00000099" } });
          return;
        }
        const key = safeName(fixtureKey(method, {}));
        const fx = fixtures.get(key);
        if (fx) respond(fx);
        else respond({ ok: false, error: `no_fixture:${key}` }, 200);
      });
      return;
    }

    const key = safeName(fixtureKey(method, params));
    const fx = fixtures.get(key);
    if (fx) {
      respond(fx);
      return;
    }
    // Fall back: ignore params (so minor param drift still returns something).
    const looseKey = safeName(method);
    const loose = fixtures.get(looseKey);
    if (loose) {
      respond(loose);
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
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
