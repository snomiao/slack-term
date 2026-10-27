// `slack relay init` / `slack relay health`: set up and check the doorbell
// relay without cloning this repo.
//
// The relay's code ships in the npm package as `slack-term/worker`
// (worker/src/), so a deployable Worker is a two-line re-export plus a
// wrangler.jsonc. `init` writes that folder — local files only, no network,
// nothing that touches Slack — and prints a fresh RELAY_TOKEN with the next
// steps. The token is deliberately NOT written into the folder: it is a secret,
// and the folder is meant to be committed.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import pkg from "../package.json" with { type: "json" };

/** The wrangler the repo deploys worker/ with (worker/package.json). */
export const WRANGLER_VERSION = "4.105.0";
/** worker/wrangler.jsonc's compatibility_date. */
export const COMPATIBILITY_DATE = "2026-07-01";
export const DEFAULT_DIR = "slack-term-relay";
export const RELAY_DOCS_URL = "https://github.com/snomiao/slack-term/blob/main/worker/README.md";

/** A Workers script name: lowercase letters, digits and dashes, 1–63 chars,
 *  no leading or trailing dash. */
export function validWorkerName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

/** A directory name turned into a valid Worker name. */
export function workerNameFrom(dir: string): string {
  const n = basename(resolve(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
  return n || DEFAULT_DIR;
}

export type ScaffoldOptions = {
  /** Worker name; default: the directory's basename. */
  name?: string;
  /** The `slack-term` dependency spec; default: this CLI's own version. */
  slackTerm?: string;
};

/** The scaffold's files, relative path → content. */
export function relayFiles(name: string, opts: { slackTerm?: string } = {}): Record<string, string> {
  const packageJson = {
    name,
    private: true,
    type: "module",
    scripts: { deploy: "wrangler deploy", dev: "wrangler dev --local" },
    dependencies: { "slack-term": opts.slackTerm ?? pkg.version },
    devDependencies: { wrangler: WRANGLER_VERSION },
    engines: { node: ">=22" },
  };
  return {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "wrangler.jsonc": `// slack-term relay: Slack Events API -> doorbells for \`slack stream\`.
// Secrets (not in this file): wrangler secret put SLACK_SIGNING_SECRET / RELAY_TOKEN / SLACK_TEAM_ID (optional)
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(name)},
  "main": "src/index.ts",
  "compatibility_date": "${COMPATIBILITY_DATE}",
  "durable_objects": {
    "bindings": [{ "name": "RELAY", "class_name": "Relay" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Relay"] }],
  // Request bodies are message events from possibly customer-facing channels:
  // keep Workers Logs off so nothing about them is persisted by the platform.
  "observability": { "enabled": false }
}
`,
    "src/index.ts": `// The relay lives in the slack-term package. Relay (the Durable Object class)
// must be exported from this main module for the RELAY binding to find it.
export { default, Relay } from "slack-term/worker";
`,
    ".gitignore": "node_modules/\n.wrangler/\n.dev.vars*\n.env*\n",
    "README.md": readme(name),
  };
}

/** The steps after `init`, shared by the README and the printed output.
 *  `token` is only ever printed, never written to a file. */
export function nextSteps(name: string, token?: string): string {
  const tok = token ?? "<RELAY_TOKEN>";
  return `1. Node >= 22 (wrangler 4 needs it), then install:
     npm install
2. Log in to Cloudflare:
     npx wrangler login
   or set CLOUDFLARE_API_TOKEN (Workers Scripts: Edit) and CLOUDFLARE_ACCOUNT_ID.
3. Deploy, then set the secrets:
     npx wrangler deploy
     npx wrangler secret put SLACK_SIGNING_SECRET   # Slack app -> Basic Information -> Signing Secret
     npx wrangler secret put RELAY_TOKEN            # paste: ${tok}
     npx wrangler secret put SLACK_TEAM_ID          # optional: accept one workspace only (T...)
4. In the Slack app -> Event Subscriptions: Enable Events, Request URL
     https://${name}.<your-subdomain>.workers.dev/slack/events
   and subscribe to bot events: message.channels, message.groups, message.im,
   app_mention (and message.mpim if the bot has mpim:history). Save; reinstall if asked.
5. Where \`slack stream\` runs:
     export SLACK_RELAY_URL=https://${name}.<your-subdomain>.workers.dev
     export SLACK_RELAY_TOKEN=${tok}
6. Check it:
     slack relay health        # or: curl -H "Authorization: Bearer $SLACK_RELAY_TOKEN" $SLACK_RELAY_URL/health
     slack stream -e .         # stderr says: relay connected (websocket)
`;
}

function readme(name: string): string {
  return `# ${name}

A [slack-term](https://github.com/snomiao/slack-term) relay: a Cloudflare Worker
that turns Slack's Events API into a resumable doorbell stream for
\`slack stream\`. The code is the \`slack-term/worker\` export; this folder only
configures and deploys it. Created by \`slack relay init\`.

## Set up

${nextSteps(name)}
\`RELAY_TOKEN\` is any long random string (\`openssl rand -hex 32\`); \`slack relay init\`
printed one. Keep it out of this folder: anyone holding it can watch when and
where messages are posted.

## Update

Bump \`slack-term\` in package.json, \`npm install\`, \`npx wrangler deploy\`.
Storage survives redeploys; clients reconnect and resume.

Details (endpoints, privacy, protocol): ${RELAY_DOCS_URL}
`;
}

export type InitResult =
  | { ok: true; dir: string; name: string; written: string[]; token: string }
  | { ok: false; error: string; existing?: string[] };

/** Write the scaffold into `dir`. Refuses to overwrite any existing file
 *  unless `force`. Returns the generated RELAY_TOKEN for the caller to print. */
export function initRelay(
  dir: string,
  opts: ScaffoldOptions & { force?: boolean } = {},
  rand: (n: number) => Buffer = randomBytes,
): InitResult {
  const name = opts.name ?? workerNameFrom(dir);
  if (!validWorkerName(name)) {
    return { ok: false, error: `invalid worker name "${name}": use lowercase letters, digits and dashes (1-63 chars, no leading/trailing dash)` };
  }
  const files = relayFiles(name, opts.slackTerm !== undefined ? { slackTerm: opts.slackTerm } : {});
  const root = resolve(dir);
  const existing = Object.keys(files).filter((f) => existsSync(join(root, f)));
  if (existing.length && !opts.force) {
    return { ok: false, error: `refusing to overwrite existing files in ${root} (pass --force to replace them)`, existing };
  }
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return { ok: true, dir: root, name, written: Object.keys(files), token: rand(32).toString("hex") };
}

/** What `slack relay init` prints on success. */
export function initReport(r: Extract<InitResult, { ok: true }>, cwd: string = process.cwd()): string {
  const rel = r.dir.startsWith(`${cwd}/`) ? r.dir.slice(cwd.length + 1) : r.dir;
  return [
    `Created ${r.dir} (worker "${r.name}"):`,
    ...r.written.map((f) => `  ${f}`),
    "",
    `RELAY_TOKEN (generated now, not saved anywhere — copy it):`,
    `  ${r.token}`,
    "",
    "Next steps:",
    `0. cd ${rel}`,
    nextSteps(r.name, r.token),
  ].join("\n");
}

export type HealthResult = { code: 0 | 1 | 2; out: string };

/** GET /health on the relay (read-only). 0 = ok, 1 = unhealthy/unreachable,
 *  2 = not configured. */
export async function relayHealth(
  url: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<HealthResult> {
  if (!url || !token) {
    return { code: 2, out: "slack relay health: set SLACK_RELAY_URL and SLACK_RELAY_TOKEN (or pass --url / --token)" };
  }
  const target = `${url.replace(/\/+$/, "")}/health`;
  try {
    const res = await fetchImpl(target, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    if (res.status === 401) return { code: 1, out: `slack relay health: 401 unauthorized — SLACK_RELAY_TOKEN does not match the relay's RELAY_TOKEN secret` };
    if (!res.ok) return { code: 1, out: `slack relay health: HTTP ${res.status} from ${target}${body ? `: ${body.slice(0, 200)}` : ""}` };
    let json: { ok?: unknown };
    try {
      json = JSON.parse(body) as typeof json;
    } catch {
      return { code: 1, out: `slack relay health: not a slack-term relay (non-JSON reply from ${target})` };
    }
    return { code: json.ok === true ? 0 : 1, out: JSON.stringify(json, null, 2) };
  } catch (e) {
    return { code: 1, out: `slack relay health: cannot reach ${target}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
