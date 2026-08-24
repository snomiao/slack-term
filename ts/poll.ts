// The `poll` message format — builder and parser in one place, for the same
// reason `ask` keeps its own pair together (see ts/ask.ts).
//
// `poll` keeps no local record either: `--results` and `--close` recover the
// question and its choices by reading the posted message back, so this body is
// a wire format and `pollParseMessage` must be the exact inverse of
// `pollBuildText`. tests/poll-format.test.ts is what holds the two in step.
//
// The instruction strings below are DELIBERATELY different from every `ask`
// instruction. That difference is the whole separation between the two
// commands: `askParseMessage` identifies an ask by its trailing instruction
// line, so a poll sharing one would be collectable by `slack ask --waitFor`,
// which would edit a live poll into a resolved question.

import { ASK_KEYCAPS, applyInvalidNotice, isInvalidNotice, readInvalidNotice } from "./ask.ts";
export { applyInvalidNotice, readInvalidNotice };

/** Ballot pills. Shared with `ask` on purpose — the keycap emoji run out at ten
 *  either way, and a poll has no text-answer path to overflow into: a choice
 *  nobody can react to is a choice nobody can vote for. Ten is a hard cap here,
 *  not a soft one. */
export const POLL_KEYCAPS = ASK_KEYCAPS;
export const POLL_MAX_CHOICES = POLL_KEYCAPS.length;

/** The marker that says "this message is a `poll`" — a shortcode, identical in
 *  every language, and seeded as a reaction so `has::ballot_box_with_ballot:`
 *  lists them all. The name is `ballot_box_with_ballot` (🗳️), NOT `ballot_box`:
 *  the short form is not a Slack emoji at all and `reactions.add` rejects it
 *  with `invalid_name` — verified against a live workspace 2026-08-24.
 *  See ASK_MARKER in ts/ask.ts for why identity moved off the instruction line. */
export const POLL_MARKER = "ballot_box_with_ballot";
export const POLL_MARKER_PREFIX = `:${POLL_MARKER}: `;

// Ordinary copy now — translate freely. Matched verbatim only to read polls
// posted before the marker existed; deleting them strands those.
const POLL_INSTRUCTION_SINGLE =
  "_下のリアクションで投票してください (1 人 1 票、押し直しで変更できます)。_";
const POLL_INSTRUCTION_MULTI =
  "_下のリアクションで投票してください (当てはまるものを *いくつでも* 押せます)。_";
const POLL_DEADLINE_PREFIX = "_締切: ";
const POLL_DEADLINE_SUFFIX = "_";

/** Prefix `close` stamps on a finished poll. `--results` keys "this one is
 *  already closed, report the recorded tally rather than re-counting" off it. */
export const POLL_CLOSED_MARKER = "bar_chart";
export const POLL_CLOSED_PREFIX = `:${POLL_CLOSED_MARKER}: `;

/** How a keycap is WRITTEN into the body. The shortcode, not the glyph: Slack
 *  normalises a unicode emoji to `:one:` in the stored `text`, so building with
 *  the glyph would mean the message never reads back as what was sent.
 *  Verified against a real workspace 2026-08-20. */
function pollPill(i: number): string {
  return `:${POLL_KEYCAPS[i]!.name}:`;
}

/** Strip the keycap prefix, or null if this line does not start with pill `i`.
 *  Both forms are accepted — the shortcode is what Slack stores today, the
 *  glyph is what a body hand-edited in the Slack UI can come back as. */
function pollStripPill(line: string, i: number): string | null {
  for (const pre of [pollPill(i), POLL_KEYCAPS[i]!.glyph]) {
    if (line.startsWith(`${pre} `)) return line.slice(pre.length + 1);
  }
  return null;
}

/** True if the line starts with ANY keycap — used only to find where the ballot
 *  block begins; which pill it is gets checked afterwards, in order. */
function pollIsPillLine(line: string): boolean {
  return POLL_KEYCAPS.some((k, i) => line.startsWith(`${pollPill(i)} `) || line.startsWith(`${k.glyph} `));
}

/** One line, always: a newline inside a choice would split it into a line the
 *  parser cannot tell from body text. */
function pollFlatten(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}

export type PollTally = { choice: string; count: number };

/** Open-poll body: the question, the numbered choices matching the seeded
 *  pills, an optional deadline, and an instruction naming the ballot rule.
 *  `pollParseMessage` is its inverse — keep the two in step. */
export type PollOpts = {
  multi?: boolean;
  /** Display only — a deadline in the body does not close anything. */
  deadline?: string;
  /** User IDs whose ballot could not be counted (single mode, several pills). */
  invalid?: string[];
};

export function pollBuildText(question: string, body: string, choices: string[], opts: PollOpts = {}): string {
  const multi = !!opts.multi;
  const deadline = opts.deadline ?? "";
  const invalid = opts.invalid ?? [];
  if (!choices.length || choices.length > POLL_MAX_CHOICES) {
    throw new Error(`poll needs 1..${POLL_MAX_CHOICES} choices, got ${choices.length}`);
  }
  const lines: string[] = [`${POLL_MARKER_PREFIX}*${question}*`];
  if (body) lines.push("", body);
  lines.push("");
  lines.push(...choices.map((s, i) => `${pollPill(i)} ${pollFlatten(s)}`));
  lines.push("");
  // The deadline sits between the choices and the instruction so the
  // instruction stays the last line — that trailing line is what identifies a
  // poll at all, and an optional line after it would break the anchor.
  if (deadline) lines.push(`${POLL_DEADLINE_PREFIX}${pollFlatten(deadline)}${POLL_DEADLINE_SUFFIX}`);
  lines.push(multi ? POLL_INSTRUCTION_MULTI : POLL_INSTRUCTION_SINGLE);
  // Never in multi mode: there is no such thing as too many pills there.
  return applyInvalidNotice(lines.join("\n"), multi ? [] : invalid);
}

/** Closed-poll body. The count goes BEFORE the label: a trailing `×3` could not
 *  be told apart from a choice whose text happens to end that way, and the
 *  tally is the one thing a closed poll exists to report. */
export function pollBuildClosedText(question: string, tallies: PollTally[]): string {
  const total = tallies.reduce((n, t) => n + t.count, 0);
  const lines: string[] = [`${POLL_CLOSED_PREFIX}*${question}*`, `_投票終了 (計 ${total} 票)_`, ""];
  lines.push(...tallies.map((t, i) => `${pollPill(i)} ×${t.count}  ${pollFlatten(t.choice)}`));
  return lines.join("\n");
}

export type PollParsed =
  | { kind: "open"; question: string; choices: string[]; multi: boolean; deadline: string; invalid: string[] }
  | { kind: "closed"; question: string; tallies: PollTally[] }
  | { kind: "other" };

/** Read a poll back out of Slack. "Is this even a poll?" is decided by the
 *  trailing instruction line (or the 📊 prefix), not by a loose heuristic —
 *  matching verbatim is what keeps an unrelated message, or an `ask`, from
 *  being counted as one. */
export function pollParseMessage(text: string): PollParsed {
  const lines = text.split("\n");

  if (text.startsWith(POLL_CLOSED_PREFIX)) {
    const question = lines[0]!.slice(POLL_CLOSED_PREFIX.length).replace(/^\*/, "").replace(/\*$/, "");
    const tallies: PollTally[] = [];
    for (let k = 0; k < POLL_KEYCAPS.length; k++) {
      const line = lines.map((l) => pollStripPill(l, k)).find((r) => r !== null && r.startsWith("×"));
      if (line === undefined) break; // choices are contiguous from 1️⃣; the first gap ends the block
      const m = /^×(\d+)  (.*)$/.exec(line!);
      if (!m) return { kind: "other" };
      tallies.push({ choice: m[2]!, count: Number(m[1]) });
    }
    // A 📊-stamped body with no tally is not a result we can report.
    if (!tallies.length) return { kind: "other" };
    return { kind: "closed", question, tallies };
  }

  const last = lines[lines.length - 1] ?? "";
  let multi: boolean;
  if (last === POLL_INSTRUCTION_SINGLE) multi = false;
  else if (last === POLL_INSTRUCTION_MULTI) multi = true;
  else return { kind: "other" };

  // The question is the leading bold run, taken up to the first line that closes
  // the `*` so a multi-line question survives instead of being truncated.
  // Strip the marker first, so a pre-marker body still parses (see ts/ask.ts).
  if (lines[0]!.startsWith(POLL_MARKER_PREFIX)) lines[0] = lines[0]!.slice(POLL_MARKER_PREFIX.length);
  if (!lines[0]!.startsWith("*")) return { kind: "other" };
  let end = 0;
  while (end < lines.length && !(lines[end]!.endsWith("*") && (end > 0 || lines[0]!.length > 1))) end++;
  if (end >= lines.length) return { kind: "other" };
  const question = lines.slice(0, end + 1).join("\n").replace(/^\*/, "").replace(/\*$/, "");

  // Walk UP from the instruction rather than down from the question: the ballot
  // is anchored to the bottom, and scanning downward would let a body line that
  // merely starts with a keycap steal a slot and shift every number after it.
  let i = lines.length - 2;
  const invalid = readInvalidNotice(text);
  if (isInvalidNotice(lines[i])) i--;
  let deadline = "";
  const dl = lines[i];
  if (dl !== undefined && dl.startsWith(POLL_DEADLINE_PREFIX) && dl.endsWith(POLL_DEADLINE_SUFFIX) && dl.length > POLL_DEADLINE_PREFIX.length + POLL_DEADLINE_SUFFIX.length) {
    deadline = dl.slice(POLL_DEADLINE_PREFIX.length, -POLL_DEADLINE_SUFFIX.length);
    i--;
  }
  if (lines[i] !== "") return { kind: "other" };
  i--;

  const raw: string[] = [];
  while (i >= 0) {
    const line = lines[i]!;
    if (!pollIsPillLine(line)) break;
    raw.unshift(line);
    i--;
  }
  // The block has to be keycaps 1..n IN ORDER, separated from the body by a
  // blank line. Order is not cosmetic: each pill's position IS the ballot the
  // counter reads, so a block starting at 2️⃣ would tally the wrong choice.
  if (!raw.length || raw.length > POLL_MAX_CHOICES) return { kind: "other" };
  const choices: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const rest = pollStripPill(raw[k]!, k);
    if (rest === null) return { kind: "other" };
    choices.push(rest);
  }
  if (lines[i] !== "") return { kind: "other" };
  if (i < end + 1) return { kind: "other" };

  return { kind: "open", question, choices, multi, deadline, invalid };
}

export type PollCount = {
  tallies: PollTally[];
  /** Who voted for each choice, index-aligned with `tallies`. */
  voters: string[][];
  /** Single-mode voters holding more than one pill, counted for nothing.
   *  Slack records no timestamp on a reaction — not in `reactions.get`, not
   *  anywhere — so there is no "latest vote" to fall back on. Guessing one
   *  would be inventing a ballot; these are reported instead. */
  ambiguous: string[];
};

/** Count a ballot. The message author is excluded by the caller and always:
 *  the pills are SEEDED by whoever posted, so their reaction sits on every
 *  choice and cannot be told apart from a vote. Someone who wants their own
 *  preference counted posts the poll `--as-bot` and votes as themselves — or
 *  just says it in the thread. */
export function pollTally(
  choices: string[],
  reactions: { name: string; users: string[] }[],
  exclude: Set<string>,
  multi: boolean,
): PollCount {
  const byName = new Map(reactions.map((r) => [r.name, r.users]));
  const picked = choices.map((_, i) =>
    (byName.get(POLL_KEYCAPS[i]!.name) ?? []).filter((u) => !exclude.has(u)),
  );

  const ambiguous: string[] = [];
  if (!multi) {
    const seen = new Map<string, number>();
    for (const users of picked) for (const u of users) seen.set(u, (seen.get(u) ?? 0) + 1);
    for (const [u, n] of seen) if (n > 1) ambiguous.push(u);
  }
  const drop = new Set(ambiguous);

  const voters = picked.map((users) => users.filter((u) => !drop.has(u)));
  return {
    tallies: choices.map((choice, i) => ({ choice, count: voters[i]!.length })),
    voters,
    ambiguous,
  };
}
