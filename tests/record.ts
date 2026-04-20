// Record real Slack API responses for fixture generation.
//
// Usage:
//   SLACK_MCP_XOXP_TOKEN=xoxp-... bun run tests/record.ts
//
// Writes raw JSON to tests/fixtures/raw/ (gitignored). Run tests/anonymize.ts
// afterwards to produce committable fixtures under tests/fixtures/mock/.

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(HERE, "fixtures", "raw");

const token = process.env.SLACK_MCP_XOXP_TOKEN;
if (!token) {
  console.error("SLACK_MCP_XOXP_TOKEN required");
  process.exit(1);
}

await mkdir(RAW_DIR, { recursive: true });

function fixtureKey(method: string, params: Record<string, string>): string {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return parts ? `${method}__${parts}` : method;
}

// Sanitize fs-unsafe chars in the key
function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.=&-]/g, "_");
}

async function callAndRecord(method: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `https://slack.com/api/${method}?${qs}` : `https://slack.com/api/${method}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  const key = fixtureKey(method, params);
  await writeFile(join(RAW_DIR, `${safeName(key)}.json`), JSON.stringify(body, null, 2));
  console.error(`recorded ${key}`);
  return body;
}

// Record a representative slice of each endpoint used by the CLI.
await callAndRecord("auth.test", {});
await callAndRecord("search.messages", {
  query: "to:me",
  sort: "timestamp",
  sort_dir: "desc",
  count: "20",
  page: "1",
});
await callAndRecord("search.messages", {
  query: "deploy",
  sort: "timestamp",
  sort_dir: "desc",
  count: "10",
  page: "1",
});
await callAndRecord("conversations.list", {
  limit: "200",
  types: "public_channel,private_channel,im,mpim",
});

// Record history for the first few channels we can see.
const list = (await callAndRecord("conversations.list", {
  limit: "20",
  types: "public_channel",
  exclude_archived: "true",
})) as { channels?: Array<{ id?: string }> };

for (const ch of (list.channels ?? []).slice(0, 3)) {
  if (ch.id) await callAndRecord("conversations.history", { channel: ch.id, limit: "20" });
}

// Record users.info for a few users seen in history/search.
// (mock server can be extended later; this is the initial slice)
console.error("done. run `bun run tests/anonymize.ts` next.");
