// Language packs: locales/<lang>.json in the package, overridden key by key by
// the nearest .slack-hub/locales/<lang>.json. They hold only what slack-hub
// posts to PEOPLE (slack ask's copy) and the patterns it looks for in their
// messages (the choice-question hint); the CLI's own text is English, in code.
//
// Read at call time and cached by mtime, so editing a pack takes effect on the
// next command (and the next access in a long-running one): no rebuild.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findScope } from "./scope.ts";

export type Pack = {
  lang: string;
  /** Slack / POSIX locales that pick this pack (`ja` matches ja-JP, ja_JP.UTF-8). */
  locale_prefixes?: string[];
  ask?: Record<string, string>;
  /** Regex sources (flags iu) for "this text is a choice question". */
  choice_patterns?: string[];
};

// fileURLToPath, not .pathname: a path with spaces or non-ASCII stays
// percent-encoded in .pathname, and a Windows one comes out as /C:/….
const PACKAGE_DIR = fileURLToPath(new URL("../locales/", import.meta.url));

const cache = new Map<string, { mtimeMs: number; pack: Pack | undefined }>();

function readPack(path: string): Pack | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.pack;
  let pack: Pack | undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Pack;
    pack = v && typeof v.lang === "string" ? v : undefined;
  } catch {
    pack = undefined; // a broken override must not take the CLI down: the package pack stands
  }
  cache.set(path, { mtimeMs, pack });
  return pack;
}

function overrideDir(): string | undefined {
  const s = findScope();
  return s.global ? undefined : join(s.dir, "locales");
}

/** Every language with a pack, package or override. */
export function packLangs(): string[] {
  const out = new Set<string>();
  for (const d of [PACKAGE_DIR, overrideDir()]) {
    if (!d) continue;
    try {
      for (const f of readdirSync(d)) if (f.endsWith(".json")) out.add(f.slice(0, -5));
    } catch { /* no such dir */ }
  }
  return [...out].sort();
}

/** The pack for `lang`: the package's, with the override's keys on top. */
export function pack(lang: string): Pack | undefined {
  const base = readPack(join(PACKAGE_DIR, `${lang}.json`));
  const od = overrideDir();
  const over = od ? readPack(join(od, `${lang}.json`)) : undefined;
  if (!over) return base;
  if (!base) return over;
  return {
    ...base, ...over,
    ask: { ...base.ask, ...over.ask },
    choice_patterns: over.choice_patterns ?? base.choice_patterns ?? [],
  };
}

/** One ask string, `{name}` placeholders filled. Keys may carry a ` (WIRE)`
 *  note in the JSON; looked up with or without it. */
export function askString(lang: string, key: string, vars: Record<string, string | number> = {}): string {
  const a = pack(lang)?.ask ?? {};
  const raw = a[key] ?? a[`${key} (WIRE)`] ?? pack("en")?.ask?.[key] ?? pack("en")?.ask?.[`${key} (WIRE)`];
  if (raw === undefined) throw new Error(`language pack ${lang}: no ask.${key}`);
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** The pack whose locale prefix `locale` names, or undefined. */
export function langOfLocale(locale: string | undefined): string | undefined {
  const v = (locale ?? "").toLowerCase();
  if (!v) return undefined;
  for (const l of packLangs()) {
    for (const p of pack(l)?.locale_prefixes ?? [l]) {
      const q = p.toLowerCase();
      if (v === q || (v.startsWith(q) && /^[_.\-@]/.test(v.slice(q.length)))) return l;
    }
  }
  return undefined;
}

/** Compiled choice patterns of every pack: a choice question is spotted in
 *  any language, whatever the sender's own. */
export function choicePatterns(): { lang: string; re: RegExp }[] {
  const out: { lang: string; re: RegExp }[] = [];
  for (const l of packLangs()) {
    for (const src of pack(l)?.choice_patterns ?? []) {
      try {
        out.push({ lang: l, re: new RegExp(src, "iu") });
      } catch { /* a broken pattern in an override is skipped, not fatal */ }
    }
  }
  return out;
}
