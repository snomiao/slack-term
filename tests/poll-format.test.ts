// The `poll` body is a wire format: `--results` / `--close` recover a poll from
// the posted message alone, so `pollParseMessage` has to be the exact inverse of
// `pollBuildText`. These tests are what stop a wording tweak from quietly making
// every in-flight poll uncountable.

import { describe, test, expect } from "./harness.ts";
import { pollBuildText, pollBuildClosedText, pollParseMessage, pollTally, applyInvalidNotice, readInvalidNotice, POLL_MARKER, POLL_MAX_CHOICES } from "../ts/poll.ts";
import { askParseMessage, askBuildText } from "../ts/ask.ts";

describe("poll body round-trips", () => {
  const cases: { name: string; question: string; body: string; choices: string[]; multi: boolean; deadline: string }[] = [
    { name: "single-choice poll", question: "<!here> 昼どこ行く?", body: "", choices: ["カレー", "そば"], multi: false, deadline: "" },
    { name: "multi-choice poll with a body", question: "参加できる日は?", body: "候補は暫定です", choices: ["月", "火", "水"], multi: true, deadline: "" },
    { name: "poll with a deadline", question: "どれ?", body: "", choices: ["A", "B"], multi: false, deadline: "2026-08-21 10:00" },
    { name: "ten choices", question: "どれ?", body: "", choices: Array.from({ length: POLL_MAX_CHOICES }, (_, i) => `c${i + 1}`), multi: true, deadline: "明日" },
    // A body line that looks like a ballot line must not become one, and a
    // choice starting with a keycap must not shift the numbering.
    { name: "keycap-looking body and choice", question: "q", body: "1️⃣ これは本文です", choices: ["2️⃣ っぽい選択肢", "ふつう"], multi: false, deadline: "" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const parsed = pollParseMessage(pollBuildText(c.question, c.body, c.choices, { multi: c.multi, deadline: c.deadline }));
      expect(parsed.kind).toBe("open");
      if (parsed.kind !== "open") return;
      expect(parsed.question).toBe(c.question);
      expect(parsed.choices).toEqual(c.choices);
      expect(parsed.multi).toBe(c.multi);
      expect(parsed.deadline).toBe(c.deadline);
    });
  }

  test("a newline inside a choice becomes a space, and still round-trips", () => {
    const parsed = pollParseMessage(pollBuildText("q", "", ["A\nB", "C"]));
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.choices).toEqual(["A B", "C"]);
  });

  test("a multi-line question keeps its line breaks", () => {
    const q = "長い質問\n2 行目";
    const parsed = pollParseMessage(pollBuildText(q, "", ["A", "B"]));
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.question).toBe(q);
  });
});

// Slack REWRITES the stored `text` of a posted message: a unicode keycap comes
// back as `:one:`. The body is built in that form for exactly this reason — a
// glyph-built ballot would never read back as what was sent. (The same rewrite
// also collapses newlines when `blocks` are attached, which is why `poll` posts
// plain. Verified against a real workspace 2026-08-20.)
describe("the ballot is written the way Slack stores it", () => {
  test("built with shortcodes, not glyphs", () => {
    const text = pollBuildText("q", "", ["A", "B"]);
    expect(text).toContain(":one: A");
    expect(text).not.toContain("1️⃣");
  });

  test("a glyph ballot is still readable, for a body hand-edited in the UI", () => {
    const text = pollBuildText("q", "", ["A", "B"]).replace(":one:", "1️⃣").replace(":two:", "2️⃣");
    const parsed = pollParseMessage(text);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.choices).toEqual(["A", "B"]);
  });
});

describe("poll refuses a ballot nobody can cast", () => {
  test("no choices", () => {
    expect(() => pollBuildText("q", "", [])).toThrow();
  });

  test("more choices than there are keycaps", () => {
    const many = Array.from({ length: POLL_MAX_CHOICES + 1 }, (_, i) => `c${i}`);
    expect(() => pollBuildText("q", "", many)).toThrow();
  });
});

describe("closed poll body round-trips", () => {
  test("tallies come back with their counts", () => {
    const tallies = [{ choice: "カレー", count: 3 }, { choice: "そば", count: 0 }, { choice: "うどん", count: 12 }];
    expect(pollParseMessage(pollBuildClosedText("昼どこ?", tallies))).toEqual({ kind: "closed", question: "昼どこ?", tallies });
  });

  test("a choice whose text ends in a count is not mistaken for one", () => {
    // The count is written BEFORE the label precisely so this case survives.
    const tallies = [{ choice: "ビール ×3", count: 1 }];
    expect(pollParseMessage(pollBuildClosedText("q", tallies))).toEqual({ kind: "closed", question: "q", tallies });
  });

  test("a 📊 body with no tally is not reported as a result", () => {
    expect(pollParseMessage(":bar_chart: *q*\n_投票終了 (計 0 票)_\n").kind).toBe("other");
  });
});

// Every rejection below is a body that LOOKS like a poll. The parser drives a
// counter, so a near-miss accepted as the real thing would tally the wrong
// lines; "not sure" has to mean "not a poll".
describe("poll rejects what it cannot read", () => {
  test("an unrelated message", () => {
    expect(pollParseMessage("*太字の普通の発言*\nよろしく").kind).toBe("other");
  });

  test("an empty message", () => {
    expect(pollParseMessage("").kind).toBe("other");
  });

  test("the ballot must start at 1️⃣", () => {
    const text = pollBuildText("q", "", ["A", "B"]).replace(":one: A\n", "");
    expect(pollParseMessage(text).kind).toBe("other");
  });

  test("the ballot must be separated from the body by a blank line", () => {
    const text = pollBuildText("q", "本文", ["A"]).replace("本文\n\n", "本文\n");
    expect(pollParseMessage(text).kind).toBe("other");
  });

  test("a question with no bold run", () => {
    const text = pollBuildText("q", "", ["A"]).replace("*q*", "q");
    expect(pollParseMessage(text).kind).toBe("other");
  });
});

// The two commands are told apart by their trailing instruction line alone, so
// this is the test that keeps `slack ask --waitFor` from resolving a live poll
// (which would edit it into a settled question) and vice versa.
describe("poll and ask are not each other", () => {
  test("ask does not read a poll", () => {
    expect(askParseMessage(pollBuildText("q", "", ["A", "B"])).kind).toBe("other");
    expect(askParseMessage(pollBuildClosedText("q", [{ choice: "A", count: 1 }])).kind).toBe("other");
  });

  test("poll does not read an ask", async () => {
    const { askBuildText, askBuildResolvedText } = await import("../ts/ask.ts");
    expect(pollParseMessage(askBuildText("q", "", ["A", "B"], [], true)).kind).toBe("other");
    expect(pollParseMessage(askBuildResolvedText("q", { answer: "はい", how: "返信" }, "")).kind).toBe("other");
  });
});

describe("poll tally", () => {
  const R = (name: string, users: string[]) => ({ name, users });

  test("counts pills, excluding the seeder", () => {
    const c = pollTally(["A", "B"], [R("one", ["UME", "U1", "U2"]), R("two", ["UME", "U3"])], new Set(["UME"]), false);
    expect(c.tallies).toEqual([{ choice: "A", count: 2 }, { choice: "B", count: 1 }]);
    expect(c.voters).toEqual([["U1", "U2"], ["U3"]]);
    expect(c.ambiguous).toEqual([]);
  });

  test("a choice nobody pressed is zero, not missing", () => {
    const c = pollTally(["A", "B"], [R("one", ["U1"])], new Set(), false);
    expect(c.tallies).toEqual([{ choice: "A", count: 1 }, { choice: "B", count: 0 }]);
  });

  test("single mode: a voter holding two pills counts for nothing", () => {
    // Reactions carry no timestamp anywhere in the Slack API, so there is no
    // latest vote to pick — the ballot is reported as ambiguous, not guessed.
    const c = pollTally(["A", "B"], [R("one", ["U1", "U2"]), R("two", ["U1"])], new Set(), false);
    expect(c.tallies).toEqual([{ choice: "A", count: 1 }, { choice: "B", count: 0 }]);
    expect(c.ambiguous).toEqual(["U1"]);
  });

  test("multi mode: two pills from one voter both count", () => {
    const c = pollTally(["A", "B"], [R("one", ["U1"]), R("two", ["U1"])], new Set(), true);
    expect(c.tallies).toEqual([{ choice: "A", count: 1 }, { choice: "B", count: 1 }]);
    expect(c.ambiguous).toEqual([]);
  });

  test("unrelated reactions on the message are not votes", () => {
    const c = pollTally(["A"], [R("one", ["U1"]), R("tada", ["U2", "U3"])], new Set(), false);
    expect(c.tallies).toEqual([{ choice: "A", count: 1 }]);
  });
});

// The notice lives in the message so the VOTER sees it, and it is rewritten
// from the current state on every collection pass. That is what makes running
// `--results` on a schedule safe: notices cannot stack up, and a stale one
// disappears by itself once the extra pill is taken back.
describe("invalid-ballot notice", () => {
  const open = () => pollBuildText("q", "", ["A", "B"]);

  test("round-trips through the open format", () => {
    const text = pollBuildText("q", "", ["A", "B"], { invalid: ["U00000001"] });
    const parsed = pollParseMessage(text);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.invalid).toEqual(["U00000001"]);
    // The ballot itself must still read back intact around the extra line.
    expect(parsed.choices).toEqual(["A", "B"]);
    expect(parsed.question).toBe("q");
  });

  test("applying it twice is the same as applying it once", () => {
    const once = applyInvalidNotice(open(), ["U00000001"]);
    expect(applyInvalidNotice(once, ["U00000001"])).toBe(once);
  });

  test("a changed set replaces the line rather than adding one", () => {
    const one = applyInvalidNotice(open(), ["U00000001"]);
    const two = applyInvalidNotice(one, ["U00000002"]);
    expect(readInvalidNotice(two)).toEqual(["U00000002"]);
    expect(two.split("\n").length).toBe(one.split("\n").length);
  });

  test("an empty set takes the line back down, restoring the original text", () => {
    expect(applyInvalidNotice(applyInvalidNotice(open(), ["U00000001"]), [])).toBe(open());
  });

  test("no notice means no edit — the caller skips the API call", () => {
    expect(applyInvalidNotice(open(), [])).toBe(open());
  });

  test("multi mode never carries one: too many pills is legal there", () => {
    const text = pollBuildText("q", "", ["A", "B"], { multi: true, invalid: ["U00000001"] });
    expect(readInvalidNotice(text)).toEqual([]);
  });
});

// Same as `ask`: identity is the marker, not the Japanese instruction.
describe("poll identity is language-independent", () => {
  test("the marker leads the body and the ballot still round-trips", () => {
    const text = pollBuildText("q", "", ["A", "B"]);
    expect(text.startsWith(":ballot_box_with_ballot: *q*")).toBe(true);
    const parsed = pollParseMessage(text);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.question).toBe("q");
    expect(parsed.choices).toEqual(["A", "B"]);
  });

  test("a pre-marker body still parses (old polls stay countable)", () => {
    const legacy = pollBuildText("q", "", ["A", "B"]).replace(":ballot_box_with_ballot: ", "");
    const parsed = pollParseMessage(legacy);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.choices).toEqual(["A", "B"]);
  });

  test("ask and poll markers keep the two apart", () => {
    expect(askParseMessage(pollBuildText("q", "", ["A", "B"])).kind).toBe("other");
    expect(pollParseMessage(askBuildText("q", "", ["A", "B"], [], true)).kind).toBe("other");
  });
});

// Slack rejected `ballot_box` with `invalid_name` — the emoji is
// `ballot_box_with_ballot` (🗳️). A marker that cannot be added as a reaction is
// not searchable, which is the only reason the marker exists.
describe("marker names are real Slack emoji", () => {
  test("poll uses ballot_box_with_ballot, not the non-existent ballot_box", () => {
    expect(POLL_MARKER).toBe("ballot_box_with_ballot");
  });
});
