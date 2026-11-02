// The choice-question hint on send/reply: a message that asks
// "(yes/no)?" or lists (a)/(b) options is better posted with `slack ask`, so
// the reader taps an answer instead of typing one. Hint only — never blocks.
// The patterns are per-language packs (locales/*.json `choice_patterns`), all
// of them applied: the question is spotted in any language.
import { choicePatterns } from "./locales.ts";

/** Text with what cannot be part of the question removed: code, URLs,
 *  Slack's <…> tokens (links, mentions) — `?a=1` in a link is not a question. */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<[^>\s]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/** The language pack whose pattern matched, or undefined. Line by line, so a
 *  pattern anchored at the end of a line sees each question. */
export function choiceQuestionLang(text: string): string | undefined {
  const pats = choicePatterns();
  for (const line of prose(text).split("\n")) {
    for (const p of pats) if (p.re.test(line)) return p.lang;
  }
  return undefined;
}

export function choiceHint(target: string): string {
  return `hint: this looks like a choice question — use  slack ask '${target}' "<question>" <choice>…  so the reader can tap an answer instead of typing it`;
}
