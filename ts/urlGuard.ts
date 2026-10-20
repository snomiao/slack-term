/** Bare Unicode URL text has an ambiguous boundary for Slack's autolinker.
 * Explicit Slack links delimit the URL, including intentional Unicode paths.
 * ASCII whitespace (especially newlines) is a safe boundary; Unicode spaces
 * should be made explicit too. Do not rewrite the message or its newlines. */
const URL_TOKEN = /<https?:\/\/[^\s<>|]+(?:\|[^<>\r\n]*)?>|https?:\/\/[^\t\n\v\f\r <]+/gi;

/** A bare URL glued to the text before it — `《題名》https://…`, `（説明）https://…` — is
 *  not linked by Slack either: the autolinker wants a boundary on both sides. */
const gluedBefore = (text: string, at: number): boolean => at > 0 && /[^\x00-\x7f]/.test(text[at - 1]!);

export function adjacentUrls(text: string): string[] {
  return [...text.matchAll(URL_TOKEN)]
    .filter(({ 0: token, index }) => !token.startsWith("<") &&
      (/[^\x00-\x7f]/.test(token) || token.includes(">") || gluedBefore(text, index)))
    .map(([token]) => token);
}

/** For text that cannot be bounced back to its author (an agent's relay reply): wrap each
 *  bare URL that touches non-ASCII text as <url>, ending it at the first non-ASCII char or
 *  `>` — real URLs carry non-ASCII percent-encoded. Explicit <links> are left alone. */
export function wrapAdjacentUrls(text: string): string {
  return text.replace(URL_TOKEN, (token: string, at: number) => {
    if (token.startsWith("<")) return token;
    const cut = token.search(/[^\x00-\x7f]|>/);
    if (cut < 0 && !gluedBefore(text, at)) return token;
    const url = cut < 0 ? token : token.slice(0, cut);
    return `<${url}>${cut < 0 ? "" : token.slice(cut)}`;
  });
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
