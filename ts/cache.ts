// Persistent, TTL'd lookup cache stored in ~/.config/slack-cli/cache.json.
//
// Scope is deliberately tiny — only two mappings that are cheap to re-derive and
// effectively immutable within an hour:
//   channels: "#name" -> channel ID
//   users:    user ID  -> handle
//
// Never cached (by design, see ts/todo.ts):
//   - reaction state: it IS the mutable thing todo commands read to decide a
//     no-op; a stale value would silently skip a real state change.
//   - search results: Slack's search index already lags behind reactions.add,
//     and caching on top of that lag turns "I set it but it isn't listed" into
//     a much longer-lived bug.
//
// Every read/write is fail-soft: a corrupt JSON file, an unwritable directory or
// a permission error must never take a command down — we just run uncached.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export type CacheKind = "channels" | "users";

type Entry = { value: string; expires: number };
type CacheFile = { channels: Record<string, Entry>; users: Record<string, Entry> };

export const _internals = {
  now: (): number => Date.now(),
  // Same directory resolution as profiles.ts (~/.config/slack-cli/…).
  path: (): string => join(process.env.HOME || homedir(), ".config", "slack-cli", "cache.json"),
};

let enabled = true;
let mem: CacheFile | undefined;

/** Disable persistence entirely (the --no-cache flag). Also drops anything loaded. */
export function setCacheEnabled(on: boolean): void {
  enabled = on;
  if (!on) mem = undefined;
}

function empty(): CacheFile {
  return { channels: {}, users: {} };
}

function load(): CacheFile {
  if (mem) return mem;
  mem = empty();
  if (!enabled) return mem;
  try {
    const path = _internals.path();
    if (!existsSync(path)) return mem;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    // Tolerate any shape — a hand-edited or half-written file must not throw.
    for (const kind of ["channels", "users"] as const) {
      const section = raw?.[kind];
      if (!section || typeof section !== "object" || Array.isArray(section)) continue;
      for (const [k, v] of Object.entries(section)) {
        if (v && typeof v === "object" && typeof v.value === "string" && typeof v.expires === "number") {
          mem[kind][k] = { value: v.value, expires: v.expires };
        }
      }
    }
  } catch {
    // Corrupt/unreadable cache — start empty rather than fail the command.
    mem = empty();
  }
  return mem;
}

function persist(store: CacheFile): void {
  if (!enabled) return;
  try {
    const path = _internals.path();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
  } catch {
    // Read-only home, full disk, … — cache is an optimisation, never a hard dep.
  }
}

/** Namespace every entry by workspace. Channel names AND user IDs are
 *  workspace-scoped: "#general" and "U123" mean different things in each team a
 *  token can reach, so an un-namespaced key would serve another workspace's
 *  channel ID for a full TTL — and `todo doctor --fix` writes reactions to
 *  whatever ID it is handed. An empty scope means "workspace unknown", and is
 *  treated as a permanent miss rather than risking a cross-workspace hit. */
function scopedKey(scope: string, key: string): string | undefined {
  return scope ? `${scope}\t${key}` : undefined;
}

export function cacheGet(kind: CacheKind, scope: string, key: string): string | undefined {
  if (!enabled) return undefined;
  const k = scopedKey(scope, key);
  if (!k) return undefined;
  const entry = load()[kind][k];
  if (!entry) return undefined;
  if (entry.expires <= _internals.now()) {
    delete load()[kind][k];
    return undefined;
  }
  return entry.value;
}

export function cacheSet(kind: CacheKind, scope: string, key: string, value: string, ttlMs = CACHE_TTL_MS): void {
  if (!enabled) return;
  const k = scopedKey(scope, key);
  if (!k) return;
  const store = load();
  store[kind][k] = { value, expires: _internals.now() + ttlMs };
  persist(store);
}

/** Test hook — forget the in-process copy so the next read re-reads the file. */
export function resetCacheForTests(): void {
  mem = undefined;
  enabled = true;
}
