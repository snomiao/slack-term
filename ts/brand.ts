// The project was renamed slack-term → slack-hub. New names are written and
// preferred; the old ones are still read so existing installs keep working:
//
//   SLACK_HUB_<X> env vars       fall back to SLACK_TERM_<X>
//   .slack-hub/ scope dirs        an existing .slack-term/ is still found
//   ~/.config/slack-hub, ~/.slack-hub, $XDG_STATE_HOME/slack-hub
//                                 an existing slack-term one is used when the
//                                 slack-hub one does not exist yet
//
// The relay subprotocol is slack-hub-relay.v1; client and worker also accept
// the pre-rename slack-term-relay.v1 so either side can be upgraded first.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const NAME = "slack-hub";
export const LEGACY_NAME = "slack-term";
/** Per-directory state dir, and the legacy one still recognised. */
export const SCOPE_DIR = ".slack-hub";
export const LEGACY_SCOPE_DIR = ".slack-term";

/** `SLACK_HUB_<key>`, else the legacy `SLACK_TERM_<key>`. */
export function hubEnv(key: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[`SLACK_HUB_${key}`] ?? env[`SLACK_TERM_${key}`];
}

/** `<parent>/<new>` unless only the legacy `<parent>/<old>` exists. */
export function preferExisting(path: string, legacyPath: string): string {
  return !existsSync(path) && existsSync(legacyPath) ? legacyPath : path;
}

/** `<base>/slack-hub`, or `<base>/slack-term` when only that one exists. */
export function namedDir(base: string): string {
  return preferExisting(join(base, NAME), join(base, LEGACY_NAME));
}

/** The scope dir in `parent`: .slack-hub, or a legacy .slack-term already there. */
export function scopeDirIn(parent: string): string {
  return preferExisting(join(parent, SCOPE_DIR), join(parent, LEGACY_SCOPE_DIR));
}

/** Installed under the old npm name? CI still publishes each release as
 *  `slack-term` (toolchains may depend on the name), but it is NOT npm-deprecated,
 *  so installs stay quiet; instead the CLI says so on stderr, once per run.
 *  stdout is untouched; SLACK_HUB_NO_RENAME_NOTICE=1 silences it. */
export function renameNotice(pkgName: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (pkgName !== LEGACY_NAME || /^(1|true|yes|on)$/i.test(hubEnv("NO_RENAME_NOTICE", env) ?? "")) return undefined;
  return "slack: [deprecated] the slack-term npm package is now slack-hub and will stop being published. "
    + "Switch: npm uninstall -g slack-term && npm install -g slack-hub (same `slack` command, settings carry over). "
    + "Silence: SLACK_HUB_NO_RENAME_NOTICE=1";
}
