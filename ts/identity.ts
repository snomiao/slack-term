// `slack @<who> <command> …` — name the identity a command acts as (11-02):
// a bot (`@deploy-bot`, `@ops-bot`) or a person (`@alice`). Replaces --as-bot /
// --as-user and env-file juggling. The names map to WHERE a token lives (an
// env var, optionally in an env file, or a slack-term profile) — never to the
// token itself, which stays in the env/vault:
//
//   identities:                       # .slack-term/settings.yml or ~/.config/slack-term/settings.yml
//     deploy-bot: { kind: bot,  env_file: ~/.config/slack-cli/deploy-bot.env }   # SLACK_BOT_TOKEN in it
//     ops-bot:    { kind: bot,  env_file: ~/.config/slack-cli/ops-bot.env }
//     alice:      { kind: user, profile: acme }                                # slack auth profile
//
// And the trap it closes (11-02: an agent's `slack ask` without --as-bot was
// posted AS a person): a write that would go out as a person's session is refused
// from inside an agent, or when several identities exist, unless it names one.
// From an agent, --as-user is not enough (11-12): it must name the person.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findScope, globalScopeDir, readSettingsFile, type Scope } from "./scope.ts";

export type Identity = {
  kind: "bot" | "user";
  /** The env var holding the token (default SLACK_BOT_TOKEN for a bot, SLACK_TOKEN for a user). */
  env?: string;
  /** An env file to read that var from; else the process environment. */
  env_file?: string;
  /** A user: a slack-term workspace profile (`slack auth ls`). */
  profile?: string;
};

const WHO_RE = /^@([a-z0-9][a-z0-9._-]{0,63})$/;

/** `@who` as the first argument: its name and the arguments after it. */
export function splitWho(args: string[]): { who?: string; rest: string[] } {
  const m = WHO_RE.exec(args[0] ?? "");
  return m ? { who: m[1]!, rest: args.slice(1) } : { rest: args };
}

function asIdentity(v: unknown): Identity | undefined {
  const o = v as Partial<Identity> | null;
  if (!o || typeof o !== "object" || (o.kind !== "bot" && o.kind !== "user")) return undefined;
  const id: Identity = { kind: o.kind };
  if (typeof o.env === "string" && /^[A-Z_][A-Z0-9_]*$/.test(o.env)) id.env = o.env;
  if (typeof o.env_file === "string") id.env_file = o.env_file;
  if (typeof o.profile === "string") id.profile = o.profile;
  return id;
}

/** Identities from the nearest scope (settings.yml, then settings.local.yml
 *  unless restricted), then the global one; nearer wins. */
export function listIdentities(cwd = process.cwd()): Map<string, Identity> {
  const near = findScope(cwd);
  const scopes: Scope[] = near.global ? [near] : [{ dir: globalScopeDir(), global: true }, near];
  const out = new Map<string, Identity>();
  for (const s of scopes) {
    const base = readSettingsFile(join(s.dir, "settings.yml"));
    const files = base.restrict_to_subscriptions ? ["settings.yml"] : ["settings.yml", "settings.local.yml"];
    for (const f of files) {
      let raw: unknown;
      try {
        raw = Bun.YAML.parse(readFileSync(join(s.dir, f), "utf8"));
      } catch { continue; }
      const ids = (raw as { identities?: Record<string, unknown> } | null)?.identities;
      if (!ids || typeof ids !== "object") continue;
      for (const [name, v] of Object.entries(ids)) {
        const id = asIdentity(v);
        if (id && WHO_RE.test(`@${name}`)) out.set(name, id);
      }
    }
  }
  return out;
}

/** KEY=value lines (quotes stripped); `export ` prefixes allowed. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path.replace(/^~(?=\/|$)/, homedir()), "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** Point this process at identity `who`: the token goes into the env the
 *  rest of the CLI already reads (never printed). Returns its kind, or an
 *  error naming the known identities. */
export function applyIdentity(who: string, env: NodeJS.ProcessEnv = process.env, ids = listIdentities()): { kind: "bot" | "user" } | { error: string } {
  const id = ids.get(who);
  const known = [...ids.keys()].sort().map((n) => `@${n}`).join(", ") || "(none: add `identities:` to .slack-term/settings.yml)";
  if (!id) return { error: `unknown identity @${who}. Known: ${known}` };
  if (id.kind === "user" && id.profile && !id.env && !id.env_file) {
    env.SLACK_WORKSPACE = id.profile;
    delete env.SLACK_TOKEN;
    delete env.SLACK_BOT_TOKEN;
    env.SLACK_TERM_IDENTITY = who;
    return { kind: "user" };
  }
  const name = id.env ?? (id.kind === "bot" ? "SLACK_BOT_TOKEN" : "SLACK_TOKEN");
  let token: string | undefined;
  try {
    token = id.env_file ? readEnvFile(id.env_file)[name] : env[name];
  } catch {
    return { error: `@${who}: cannot read ${id.env_file}` };
  }
  if (!token) return { error: `@${who}: no ${name}${id.env_file ? ` in ${id.env_file}` : " in the environment"}` };
  if (id.kind === "bot" && !token.startsWith("xoxb-")) return { error: `@${who} is a bot, but ${name} is not a bot token (xoxb-)` };
  if (id.kind === "user" && token.startsWith("xoxb-")) return { error: `@${who} is a user, but ${name} holds a bot token` };
  if (id.kind === "bot") {
    env.SLACK_BOT_TOKEN = token;
    env.SLACK_TOKEN = token; // reads, too, go out as the bot
  } else {
    env.SLACK_TOKEN = token;
    delete env.SLACK_BOT_TOKEN;
  }
  env.SLACK_TERM_IDENTITY = who;
  return { kind: id.kind };
}

/** Set when this process runs inside an agent (ay, Claude Code, …). */
export function inAgent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return ["AY_AGENT_ID", "AGENT_YES_PID", "CLAUDECODE"].find((k) => env[k]);
}

/** Why a write that would post as a PERSON's session is refused, or null.
 *  Allowed when it names an identity (`@who`), says --as-bot, or the active
 *  token is a bot's anyway. `--as-user` is a person's own switch: inside an
 *  agent it no longer counts (11-12: lanes added it by habit, and their posts
 *  went out under the person's name). An agent that must act as a person names
 *  that person's identity (`slack @alice …`), so the command line says who, and
 *  the sent log records it. A person at a terminal keeps --as-user as is. */
export function userSessionRefusal(o: {
  isWrite: boolean; who?: string | undefined; asBot: boolean; asUser: boolean; activeIsBot: boolean;
  agent?: string | undefined; identities: string[]; userIdentities?: string[]; cmd: string;
}): string | null {
  if (!o.isWrite || o.who || o.asBot || o.activeIsBot) return null;
  const users = o.userIdentities ?? [];
  if (o.asUser && !o.agent) return null; // a person at a terminal: their own call
  const names = o.identities.map((n) => `@${n}`).join(" | ");
  const pick = names ? `  Name who acts:   slack ${o.identities[0] ? `@${o.identities[0]}` : "@<who>"} ${o.cmd} …   (${names})` : "  Add identities to .slack-term/settings.yml, then: slack @<who> " + o.cmd + " …";
  if (o.agent) {
    const person = users.length
      ? `  As a person, on purpose:  slack @${users[0]} ${o.cmd} …   (${users.map((n) => `@${n}`).join(" | ")})`
      : "  As a person, on purpose:  add them to `identities:` (kind: user), then slack @<name> " + o.cmd + " …";
    return [
      `Error: refusing to post as the user session from inside an agent (${o.agent} is set): \`${o.cmd}\` would go out as a PERSON.`,
      ...(o.asUser ? ["  --as-user is not accepted from an agent: it hides whose name the post goes out under."] : []),
      pick,
      "  As the app:      add --as-bot",
      person,
    ].join("\n");
  }
  if (o.identities.length >= 2) {
    return [
      `Error: several identities are configured (${names}): name the one \`${o.cmd}\` acts as.`,
      pick,
      "  Or: --as-bot / --as-user",
    ].join("\n");
  }
  return null;
}
