// `.slack-term/` — per-directory state, found like `.git`: the nearest one
// walking up from the cwd is the scope, so each lane's tree (or repo) owns its
// own aliases and settings without a pid, an env var or a daemon. No
// `.slack-term/` anywhere up the tree falls back to ~/.config/slack-term/.
//
//   .slack-term/
//     README.md            what this is (written on init)
//     .gitignore           "*" — nothing in here is ever committed
//     settings.yml         written by people: prefix, channel, as_bot, subscriptions
//     settings.local.yml   written by `slack alias`; overrides settings.yml
//     inbox/ archived/     incoming messages, one file each; handled ones move to archived/
//     outbox/ sent/        outgoing messages, one file each; sent ones move to sent/
//
// Every write is tmp + rename (a reader never sees half a file), and the
// read-modify-write of settings.local.yml holds a lock file, so two `slack
// alias set` at once cannot drop each other's entry.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SCOPE_DIR = ".slack-term";
export const SCOPE_SUBDIRS = ["inbox", "archived", "outbox", "sent"] as const;

export type Scope = { dir: string; global: boolean };

/** The global fallback: ~/.config/slack-term (SLACK_TERM_HOME overrides, for tests). */
export function globalScopeDir(): string {
  return process.env.SLACK_TERM_HOME ?? join(homedir(), ".config", "slack-term");
}

/** The nearest `.slack-term/` at or above `cwd`, else the global one. */
export function findScope(cwd = process.cwd()): Scope {
  let d = resolve(cwd);
  for (;;) {
    const c = join(d, SCOPE_DIR);
    try {
      if (statSync(c).isDirectory()) return { dir: c, global: false };
    } catch { /* not here */ }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return { dir: globalScopeDir(), global: true };
}

const README = `# .slack-term/

State for [slack-term](https://github.com/snomiao/slack-term) in this directory.
\`slack\` uses the nearest \`.slack-term/\` walking up from where it runs (like
\`.git\`), so everything below this directory shares it. Without one it uses
~/.config/slack-term/.

Nothing here is committed: \`.gitignore\` holds \`*\`.

| Path | What |
|---|---|
| \`settings.yml\` | yours to edit: \`prefix\` (put in front of every \`slack reply\`, e.g. \`"[design]"\`), \`channel\` (default), \`as_bot\`, \`subscriptions\` |
| \`settings.local.yml\` | written by \`slack alias set/unset\`; same keys, wins over \`settings.yml\` |
| \`inbox/\` → \`archived/\` | one file per incoming message; it moves to \`archived/\` once handled |
| \`outbox/\` → \`sent/\` | one file per outgoing message; it moves to \`sent/\` once Slack returns its ts |

\`subscriptions\` maps an alias to a place:

    subscriptions:
      board:
        channel: C00000001
        thread_ts: "1700000000.000100"

## Commands

    slack alias ls                         # the aliases here
    slack alias set <name> <permalink>     # name a thread (a reply's permalink names its root)
    slack alias unset <name>
    slack read <name>                      # read the thread
    slack reply <name> '<text>'            # reply in it, with the prefix, behind the --code gate
    slack reply --to <permalink> '<text>'  # reply in the thread where that message is
    slack reply <name> --to <permalink> …  # refused when that message is in another thread
`;

const SETTINGS = `# slack-term settings for this directory. settings.local.yml (written by
# \`slack alias\`) has the same keys and wins over this file.
#
# prefix: "[lane]"      # put in front of every \`slack reply\`; never doubled
# channel: C00000001    # default channel
# as_bot: false         # reply as the bot (SLACK_BOT_TOKEN)
# subscriptions:        # alias -> place (\`slack alias set\` writes settings.local.yml)
#   board:
#     channel: C00000001
#     thread_ts: "1700000000.000100"
`;

export type Subscription = { channel: string; thread_ts?: string; added?: string; note?: string };
export type Settings = { prefix?: string; channel?: string; as_bot?: boolean; subscriptions?: Record<string, Subscription> };

/** Create (or complete) `<parent>/.slack-term/`. Idempotent: existing files are kept. */
export function initScope(parent: string, settings: Omit<Settings, "subscriptions"> = {}): { dir: string; created: string[] } {
  const dir = join(resolve(parent), SCOPE_DIR);
  const created: string[] = [];
  mkdirSync(dir, { recursive: true });
  for (const sub of SCOPE_SUBDIRS) {
    const d = join(dir, sub);
    if (!existsSync(d)) { mkdirSync(d, { recursive: true }); created.push(`${sub}/`); }
  }
  const put = (name: string, body: string): void => {
    const p = join(dir, name);
    if (existsSync(p)) return;
    atomicWrite(p, body);
    created.push(name);
  };
  put(".gitignore", "*\n");
  put("README.md", README);
  const given = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
  put("settings.yml", SETTINGS + (Object.keys(given).length ? "\n" + Bun.YAML.stringify(given, null, 2) + "\n" : ""));
  return { dir, created };
}

export function atomicWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Hold `<path>.lock` (O_EXCL) around `fn`. A lock older than `staleMs` is a
 *  crashed writer's and is taken over. */
export function withFileLock<T>(path: string, fn: () => T, staleMs = 10_000, waitMs = 5_000): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) { unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() > until) throw new Error(`${lock} is held by another writer`);
      Bun.sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

function asSubscription(v: unknown): Subscription | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.channel !== "string" || !o.channel) return undefined;
  const s: Subscription = { channel: o.channel };
  // A ts written unquoted parses as a number and loses its trailing zeros.
  if (typeof o.thread_ts === "string" && /^\d{10}\.\d{6}$/.test(o.thread_ts)) s.thread_ts = o.thread_ts;
  if (typeof o.added === "string") s.added = o.added;
  if (typeof o.note === "string") s.note = o.note;
  return s;
}

/** One settings file, validated; unknown keys and malformed entries are dropped. */
export function readSettingsFile(path: string): Settings {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const s: Settings = {};
  if (typeof o.prefix === "string" && o.prefix.trim()) s.prefix = o.prefix.trim();
  // `prefix: [lane]` unquoted is a YAML list: take the one-element form as meant.
  else if (Array.isArray(o.prefix) && o.prefix.length === 1 && typeof o.prefix[0] === "string") s.prefix = `[${o.prefix[0]}]`;
  if (typeof o.channel === "string" && o.channel) s.channel = o.channel;
  if (typeof o.as_bot === "boolean") s.as_bot = o.as_bot;
  if (o.subscriptions && typeof o.subscriptions === "object") {
    const subs: Record<string, Subscription> = {};
    for (const [k, v] of Object.entries(o.subscriptions as Record<string, unknown>)) {
      const sub = asSubscription(v);
      if (sub && validAliasName(k)) subs[k] = sub;
    }
    s.subscriptions = subs;
  }
  return s;
}

/** settings.yml with settings.local.yml over it (subscriptions merge by name). */
export function readSettings(scope: Scope): Settings {
  const base = readSettingsFile(join(scope.dir, "settings.yml"));
  const local = readSettingsFile(join(scope.dir, "settings.local.yml"));
  const subs = { ...base.subscriptions, ...local.subscriptions };
  const out: Settings = { ...base, ...local };
  if (Object.keys(subs).length) out.subscriptions = subs;
  else delete out.subscriptions;
  return out;
}

// --- aliases ---

export type Alias = Subscription & { name: string; scope: Scope; file: "settings.yml" | "settings.local.yml" };

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Lowercase letters, digits, `.` `_` `-`; never a bare ts or a Slack id. */
export function validAliasName(name: string): boolean {
  return ALIAS_RE.test(name) && !/^\d{10}\.\d{6}$/.test(name);
}

export function listAliases(scope: Scope): Alias[] {
  const base = readSettingsFile(join(scope.dir, "settings.yml")).subscriptions ?? {};
  const local = readSettingsFile(join(scope.dir, "settings.local.yml")).subscriptions ?? {};
  const out: Alias[] = [];
  for (const [name, s] of Object.entries(base)) if (!local[name]) out.push({ ...s, name, scope, file: "settings.yml" });
  for (const [name, s] of Object.entries(local)) out.push({ ...s, name, scope, file: "settings.local.yml" });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A bare alias name, in the nearest scope, then the global one. */
export function lookupAlias(name: string, cwd = process.cwd()): Alias | undefined {
  if (!validAliasName(name)) return undefined;
  const near = findScope(cwd);
  const scopes = near.global ? [near] : [near, { dir: globalScopeDir(), global: true }];
  for (const s of scopes) {
    const a = listAliases(s).find((x) => x.name === name);
    if (a) return a;
  }
  return undefined;
}

const LOCAL_HEADER = "# Written by `slack alias set/unset`; wins over settings.yml. Safe to edit by hand.\n";

function updateLocal(scope: Scope, fn: (s: Record<string, unknown>) => void): void {
  const path = join(scope.dir, "settings.local.yml");
  withFileLock(path, () => {
    let raw: Record<string, unknown> = {};
    try {
      const v = Bun.YAML.parse(readFileSync(path, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    fn(raw);
    atomicWrite(path, LOCAL_HEADER + Bun.YAML.stringify(raw, null, 2) + "\n");
  });
}

/** Add or replace an alias in settings.local.yml; returns the one it replaced. */
export function setAlias(scope: Scope, name: string, sub: Subscription): Subscription | undefined {
  if (!validAliasName(name)) throw new Error(`invalid alias name "${name}" (a-z 0-9 . _ -, at most 64, not a bare ts)`);
  const before = listAliases(scope).find((a) => a.name === name);
  updateLocal(scope, (raw) => {
    const subs = (raw.subscriptions && typeof raw.subscriptions === "object" ? raw.subscriptions : {}) as Record<string, unknown>;
    subs[name] = { channel: sub.channel, ...(sub.thread_ts ? { thread_ts: sub.thread_ts } : {}), added: sub.added ?? new Date().toISOString(), ...(sub.note ? { note: sub.note } : {}) };
    raw.subscriptions = subs;
  });
  return before;
}

/** Remove an alias from settings.local.yml. One defined in settings.yml is
 *  refused: that file belongs to whoever wrote it. */
export function unsetAlias(scope: Scope, name: string): "removed" | "absent" | "in-settings.yml" {
  const a = listAliases(scope).find((x) => x.name === name);
  if (!a) return "absent";
  if (a.file === "settings.yml") return "in-settings.yml";
  updateLocal(scope, (raw) => {
    const subs = raw.subscriptions as Record<string, unknown> | undefined;
    if (subs) delete subs[name];
    if (subs && !Object.keys(subs).length) delete raw.subscriptions;
  });
  return "removed";
}

// --- reply text ---

/** Put `prefix` in front of `text`, never twice: a caller that already wrote
 *  `[lane] ` (or `[lane@machine] `) keeps one (symphr-thread #654, taku 11-02:
 *  "[shr] [shr]"). Only the exact lane is stripped — `[lanex]` or another
 *  lane's tag is the caller's text. Returns "" when nothing is left. */
export function applyPrefix(text: string, prefix: string | undefined): string {
  const p = prefix?.trim();
  if (!p) return text;
  const m = /^\[([^\]@\s]+)\]$/.exec(p);
  let body = text;
  if (m) {
    const lane = m[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    body = text.replace(new RegExp(`^\\s*\\[${lane}(?:@[a-z0-9-]{1,16})?\\][ \\t]*`), "");
  } else if (text.trimStart().startsWith(p)) {
    body = text.trimStart().slice(p.length).replace(/^[ \t]+/, "");
  }
  return body.trim() ? `${p} ${body}` : "";
}

/** Where a message sits: its channel and its thread root (its own ts at top level). */
export type MessagePlace = { channel: string; ts: string; root: string };

/** Why an explicit destination is not where the answered message lives (the
 *  11-02 "replied in the wrong thread"), or undefined when it is. */
export function threadMismatch(dest: { channel: string; threadTs?: string }, answered: MessagePlace): string | undefined {
  if (dest.channel === answered.channel && dest.threadTs === answered.root) return undefined;
  const where = (c: string, t?: string): string => (t ? `${c} thread ${t}` : `${c} (top level)`);
  return `the message you are answering (${answered.ts}) is in ${where(answered.channel, answered.root)}, ` +
    `but the destination is ${where(dest.channel, dest.threadTs)}.\n` +
    `  Drop the destination to reply where the message is:  slack reply --to <permalink> '…'\n` +
    `  Or pass --any-thread if the other thread is really meant.`;
}
