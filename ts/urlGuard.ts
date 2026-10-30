/** Bare Unicode URL text has an ambiguous boundary for Slack's autolinker.
 * Explicit Slack links delimit the URL, including intentional Unicode paths.
 * ASCII whitespace (especially newlines) is a safe boundary; Unicode spaces
 * should be made explicit too. Do not rewrite the message or its newlines. */
const URL_TOKEN = /<https?:\/\/[^\s<>|]+(?:\|[^<>\r\n]*)?>|https?:\/\/[^\t\n\v\f\r <]+/gi;

/** A bare URL glued to the text before it — `《題名》https://…`, `（説明）https://…` — is
 *  not linked by Slack either: the autolinker wants a boundary on both sides. */
const gluedBefore = (text: string, at: number): boolean => at > 0 && /[^\x00-\x7f]/.test(text[at - 1]!);

export function adjacentUrls(text: string): string[] {
  const bare = text.split(/(<[^<>]*>)/).filter((p) => !(p.startsWith("<") && p.endsWith(">")))
    .flatMap((p) => [...p.matchAll(BARE_HOST)].filter(({ 0: t, index }) => /[^\x00-\x7f]/.test(t) || gluedBefore(p, index)).map(([t]) => t));
  return [...bare, ...[...text.matchAll(URL_TOKEN)]
    .filter(({ 0: token, index }) => !token.startsWith("<") &&
      (/[^\x00-\x7f]/.test(token) || token.includes(">") || gluedBefore(text, index)))
    .map(([token]) => token)];
}

/** For text that cannot be bounced back to its author (an agent's relay reply): wrap each
 *  bare URL that touches non-ASCII text as <url>, ending it at the first non-ASCII char or
 *  `>` — real URLs carry non-ASCII percent-encoded. Explicit <links> are left alone. */
export function wrapAdjacentUrls(text: string): string {
  return wrapBareHosts(text).replace(URL_TOKEN, (token: string, at: number) => {
    if (token.startsWith("<")) return token;
    const cut = token.search(/[^\x00-\x7f]|>/);
    if (cut < 0 && !gluedBefore(text, at)) return token;
    const url = cut < 0 ? token : token.slice(0, cut);
    return `<${url}>${cut < 0 ? "" : token.slice(cut)}`;
  });
}

/** A scheme-less link such as `github.com/owner/repo` glued to non-ASCII text: Slack autolinks
 *  it too and swallows the CJK that follows. Matches host.tld/path only (a path is required, so
 *  plain words like `e.g.` or `v1.2` never match). */
const BARE_HOST = /(?<![\w.@/:<|-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\t\n\v\f\r <]*)/gi;

/** Wrap scheme-less host/path tokens that touch non-ASCII text as <https://…|host/path>,
 *  cut at the first non-ASCII char or `>`. Text inside explicit <links> is untouched. */
export function wrapBareHosts(text: string): string {
  return text.split(/(<[^<>]*>)/).map((part) => part.startsWith("<") && part.endsWith(">") ? part :
    part.replace(BARE_HOST, (token: string, _t: string, at: number) => {
      const cut = token.search(/[^\x00-\x7f]|>/);
      if (cut < 0 && !gluedBefore(part, at)) return token;
      const host = (cut < 0 ? token : token.slice(0, cut)).replace(/[.,;:!?)]+$/, "");
      return `<https://${host}|${host}>${token.slice(host.length)}`;
    })).join("");
}

export function guardUrlBoundaries(text: string, allow = false, warn: (message: string) => void = console.error): void {
  const urls = adjacentUrls(text);
  if (!urls.length) return;
  const message = `Ambiguous URL boundary: ${urls.map((url) => JSON.stringify(url)).join(", ")}. ` +
    "Put the URL on its own line, or wrap it as <url> / <url|label>. " +
    "Use --allow-url-adjacent to warn only.";
  if (!allow) throw new Error(message);
  warn(`Warning: ${message}`);
}
