/** Bare Unicode URL text has an ambiguous boundary for Slack's autolinker.
 * Explicit Slack links delimit the URL, including intentional Unicode paths.
 * ASCII whitespace (especially newlines) is a safe boundary; Unicode spaces
 * should be made explicit too. Do not rewrite the message or its newlines. */
export function adjacentUrls(text: string): string[] {
  const tokens = text.matchAll(/<https?:\/\/[^\s<>|]+(?:\|[^<>\r\n]*)?>|https?:\/\/[^\t\n\v\f\r <]+/gi);
  return [...tokens]
    .map(([token]) => token)
    .filter((token) => !token.startsWith("<") && (/[^\x00-\x7f]/.test(token) || token.includes(">")));
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
