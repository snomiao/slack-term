// Anonymize recorded Slack API fixtures for safe committing.
//
// Reads tests/fixtures/raw/*.json, produces tests/fixtures/mock/*.json with
// stable deterministic replacements: user IDs → U00000001, channel IDs →
// C00000001, names → "user-01" / "channel-01", text content → lorem, team IDs
// → T00000001. Timestamps are preserved (deterministic) but workspace URLs
// and emails are stripped.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "fixtures", "raw");
const MOCK = join(HERE, "fixtures", "mock");

const LOREM = [
  "lorem ipsum dolor sit amet",
  "consectetur adipiscing elit",
  "sed do eiusmod tempor incididunt",
  "ut labore et dolore magna aliqua",
  "ut enim ad minim veniam",
  "quis nostrud exercitation ullamco",
];

type Maps = {
  users: Map<string, string>;
  channels: Map<string, string>;
  teams: Map<string, string>;
  names: Map<string, string>;
  bots: Map<string, string>;
};

function makeMaps(): Maps {
  return {
    users: new Map(),
    channels: new Map(),
    teams: new Map(),
    names: new Map(),
    bots: new Map(),
  };
}

function nextId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(8, "0")}`;
}

function mockId(maps: Maps, kind: "U" | "C" | "T" | "B", real: string): string {
  const m =
    kind === "U"
      ? maps.users
      : kind === "C"
        ? maps.channels
        : kind === "T"
          ? maps.teams
          : maps.bots;
  const existing = m.get(real);
  if (existing) return existing;
  const id = nextId(kind, m.size + 1);
  m.set(real, id);
  return id;
}

function mockName(maps: Maps, kind: "user" | "channel", real: string): string {
  const key = `${kind}:${real}`;
  const existing = maps.names.get(key);
  if (existing) return existing;
  const n = [...maps.names.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1;
  const name = `${kind}-${String(n).padStart(2, "0")}`;
  maps.names.set(key, name);
  return name;
}

function mockText(real: string, seed: number): string {
  if (!real) return real;
  return LOREM[seed % LOREM.length] ?? "lorem ipsum";
}

function walk(val: unknown, maps: Maps, depth = 0): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    // Replace embedded <@UID> mentions
    return val
      .replace(/U[A-Z0-9]{6,}/g, (m) => mockId(maps, "U", m))
      .replace(/C[A-Z0-9]{6,}/g, (m) => mockId(maps, "C", m))
      .replace(/T[A-Z0-9]{6,}/g, (m) => mockId(maps, "T", m))
      .replace(/B[A-Z0-9]{6,}/g, (m) => mockId(maps, "B", m))
      .replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+/g, "user@example.com")
      .replace(/https:\/\/[a-z0-9-]+\.slack\.com/g, "https://example.slack.com");
  }
  if (typeof val === "number" || typeof val === "boolean") return val;
  if (Array.isArray(val)) return val.map((v, i) => walk(v, maps, depth + i));

  const obj = val as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Special-case sensitive string fields: replace with mock.
    if (k === "text" && typeof v === "string") {
      out[k] = mockText(v, v.length);
    } else if ((k === "name" || k === "real_name" || k === "display_name") && typeof v === "string") {
      // Is this inside a channel or user context? Infer from siblings.
      const looksChannel = typeof obj["id"] === "string" && obj["id"]?.startsWith("C");
      out[k] = mockName(maps, looksChannel ? "channel" : "user", v);
    } else if (k === "email" && typeof v === "string") {
      out[k] = "user@example.com";
    } else if (k === "image_original" || k === "image_24" || k === "image_32" || k === "image_48" || k === "image_72" || k === "image_192" || k === "image_512" || k === "image_1024" || k === "avatar_hash") {
      out[k] = "mock";
    } else {
      out[k] = walk(v, maps, depth + 1);
    }
  }
  return out;
}

const maps = makeMaps();
await mkdir(MOCK, { recursive: true });
const files = (await readdir(RAW)).filter((f) => f.endsWith(".json"));
for (const f of files) {
  const raw = JSON.parse(await readFile(join(RAW, f), "utf8"));
  const mock = walk(raw, maps);
  await writeFile(join(MOCK, f), JSON.stringify(mock, null, 2));
  console.error(`anonymized ${f}`);
}
console.error(
  `done. ${maps.users.size} users, ${maps.channels.size} channels, ${maps.teams.size} teams, ${maps.bots.size} bots remapped.`,
);
