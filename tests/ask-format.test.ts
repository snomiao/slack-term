// The `ask` body is a wire format: `--waitFor` recovers a question from the
// posted message alone, so `askParseMessage` has to be the exact inverse of
// `askBuildText`. These tests are what stop a wording tweak from quietly making
// every in-flight question uncollectable.

import { describe, test, expect } from "./harness.ts";
import { askBuildText, askBuildResolvedText, askParseMessage, applyInvalidNotice, readInvalidNotice, ASK_KEYCAPS } from "../ts/ask.ts";

describe("ask body round-trips", () => {
  const cases: { name: string; question: string; body: string; reactable: string[]; overflow: string[]; threadOnly: boolean }[] = [
    { name: "channel question with choices", question: "<@U00000001> deploy してよい?", body: "", reactable: ["はい", "まって"], overflow: [], threadOnly: true },
    { name: "DM question with choices and a body", question: "どっち?", body: "状況: リリース前\n推奨: A", reactable: ["A", "B"], overflow: [], threadOnly: false },
    { name: "free-text question", question: "<!here> どう思う?", body: "", reactable: [], overflow: [], threadOnly: true },
    { name: "ten choices plus overflow", question: "どれ?", body: "", reactable: Array.from({ length: 10 }, (_, i) => `c${i + 1}`), overflow: ["c11", "c12"], threadOnly: false },
    // A choice that itself starts with a keycap must not shift the numbering,
    // and a body line that looks like a choice must not become one.
    { name: "choice text containing a keycap", question: "q", body: "1️⃣ これは本文です", reactable: ["2️⃣ っぽい選択肢", "ふつう"], overflow: [], threadOnly: true },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const text = askBuildText(c.question, c.body, c.reactable, c.overflow, c.threadOnly);
      const parsed = askParseMessage(text);
      expect(parsed.kind).toBe("open");
      if (parsed.kind !== "open") return;
      expect(parsed.question).toBe(c.question);
      expect(parsed.reactable).toEqual(c.reactable);
      expect(parsed.overflow).toEqual(c.overflow);
      expect(parsed.threadOnly).toBe(c.threadOnly);
    });
  }
});

describe("ask flattens what would break the format", () => {
  test("a newline inside a choice becomes a space, and still round-trips", () => {
    const text = askBuildText("q", "", ["A\nB", "C"], [], false);
    const parsed = askParseMessage(text);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.reactable).toEqual(["A B", "C"]);
  });
});

describe("ask resolved body round-trips", () => {
  test("a single-line answer comes back verbatim", () => {
    const text = askBuildResolvedText("q", { answer: "はい", how: "リアクション 1️⃣" }, "Bob");
    const parsed = askParseMessage(text);
    expect(parsed).toEqual({ kind: "resolved", question: "q", answer: "はい" });
  });

  test("a multi-line answer keeps its line breaks", () => {
    // Every line is quoted precisely so this case survives; an unquoted tail
    // would be indistinguishable from the surrounding text on the way back.
    const answer = "A でいく\n理由: 期日";
    const parsed = askParseMessage(askBuildResolvedText("q", { answer, how: "返信", who: "U1" }, ""));
    expect(parsed).toEqual({ kind: "resolved", question: "q", answer });
  });
});

describe("ask rejects what it cannot read", () => {
  test("an unrelated message is not an ask", () => {
    expect(askParseMessage("*太字の普通の発言*\nよろしく").kind).toBe("other");
  });

  test("the instruction line alone does not make one", () => {
    expect(askParseMessage("ふつうの発言").kind).toBe("other");
  });

  test("a ✅ body with no quoted answer is not reported as answered", () => {
    expect(askParseMessage(":white_check_mark: *q*\n_回答済み_\n").kind).toBe("other");
  });

  test("an empty message is not an ask", () => {
    expect(askParseMessage("").kind).toBe("other");
  });
});

// Every rejection below is a body that LOOKS like an ask. The parser drives a
// poller, so a near-miss accepted as the real thing would poll the wrong lines
// forever (or answer with a body line); "not sure" has to mean "not an ask".
describe("ask rejects near-misses", () => {
  const INSTR_REACT_DM = askBuildText("q", "", ["A"], [], false).split("\n").pop()!;
  const INSTR_TEXT_DM = askBuildText("q", "", [], [], false).split("\n").pop()!;

  test("a free-text question in a DM round-trips too", () => {
    const parsed = askParseMessage(askBuildText("q", "本文", [], [], false));
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.threadOnly).toBe(false);
    expect(parsed.reactable).toEqual([]);
  });

  test("the instruction promises pills but the body has none", () => {
    expect(askParseMessage(`*q*\n\n${INSTR_REACT_DM}`).kind).toBe("other");
  });

  test("the choice block is not separated from the body by a blank line", () => {
    expect(askParseMessage(`*q*\n本文\n1️⃣ A\n\n${INSTR_REACT_DM}`).kind).toBe("other");
  });

  test("the choice block starts at a keycap other than 1️⃣", () => {
    expect(askParseMessage(`*q*\n\n2️⃣ B\n\n${INSTR_REACT_DM}`).kind).toBe("other");
  });

  test("no blank line before the instruction", () => {
    expect(askParseMessage(`*q*\n\n1️⃣ A\n${INSTR_REACT_DM}`).kind).toBe("other");
  });

  test("choices with nothing above them are not a question", () => {
    expect(askParseMessage(`1️⃣ A\n\n${INSTR_REACT_DM}`).kind).toBe("other");
  });

  test("a question that never closes its bold run", () => {
    expect(askParseMessage(`*q\n\n${INSTR_TEXT_DM}`).kind).toBe("other");
  });

  test("an overflow list that does not start at 11", () => {
    const note = askBuildText("q", "", ["A"], ["x"], false).split("\n").at(-4)!;
    const caps = ASK_KEYCAPS.map((k) => `${k.glyph} c`).join("\n");
    expect(askParseMessage(`*q*\n\n${caps}\n\n(12) x\n${note}\n\n${INSTR_REACT_DM}`).kind).toBe("other");
  });

  test("a keycap on a line of its own is still a (blank) choice", () => {
    const parsed = askParseMessage(`*q*\n\n1️⃣\n\n${INSTR_REACT_DM}`);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.reactable).toEqual([""]);
  });
});

// `ask` refuses to guess between two pressed pills, and says so IN THE QUESTION
// rather than in a thread reply — the reply would be a permanent record of a
// situation that gets fixed seconds later, and `--waitFor` reruns would stack
// copies of it. The question must still parse with the notice attached, or the
// next collection pass could not read it back at all.
describe("ask carries the invalid-ballot notice without losing the question", () => {
  const cases: [string, string[], string[], boolean][] = [
    ["with choices", ["A", "B"], [], true],
    ["with overflow", Array.from({ length: 10 }, (_, i) => `c${i + 1}`), ["c11"], false],
  ];
  for (const [name, reactable, overflow, threadOnly] of cases) {
    test(name, () => {
      const base = askBuildText("q", "本文", reactable, overflow, threadOnly);
      const noticed = applyInvalidNotice(base, ["U00000001", "U00000002"]);
      expect(readInvalidNotice(noticed)).toEqual(["U00000001", "U00000002"]);
      const parsed = askParseMessage(noticed);
      expect(parsed.kind).toBe("open");
      if (parsed.kind !== "open") return;
      expect(parsed.question).toBe("q");
      expect(parsed.reactable).toEqual(reactable);
      expect(parsed.overflow).toEqual(overflow);
      expect(parsed.threadOnly).toBe(threadOnly);
      // And it comes back off cleanly once the extra reaction is removed.
      expect(applyInvalidNotice(noticed, [])).toBe(base);
    });
  }
});

// Format identity lives in the MARKER, not in the Japanese instruction line.
// That is what makes the copy translatable: reword the instruction in any
// language and the message is still recognisably an `ask`. The old instruction
// strings stay matchable so questions posted before the marker existed remain
// collectable — deleting that fallback would strand them.
// Slack NORMALISES a unicode keycap in the stored text: post `1️⃣` and
// conversations.history returns `:one:`. A parser that only accepts the glyph
// therefore cannot read back a question the tool posted itself — which is
// exactly what happened in real use (2026-08-31): four questions were answered
// by pressing pills and `--waitFor` rejected all four as "not an ask" for ~20
// minutes, so the answers were silently uncollected.
// The check that would have caught the original bug on its own: what we POST
// must be byte-identical to what Slack STORES, so that reading it back needs no
// normalisation. The old code built with `1️⃣`, Slack stored `:one:`, and the
// difference was invisible until a real question failed to collect.
describe("the posted body is already in Slack's stored form", () => {
  test("choices are written as shortcodes, never as glyphs", () => {
    const text = askBuildText("q", "", ["A", "B"], [], true);
    expect(text).toContain(":one: A");
    expect(text).toContain(":two: B");
    // A glyph here means the stored text will differ from the sent text.
    expect(text).not.toContain("1️⃣");
    expect(text).not.toContain("2️⃣");
  });

  test("round-trip: build -> (Slack stores verbatim) -> parse", () => {
    const built = askBuildText("q", "本文", ["A", "B", "C"], [], false);
    // No normalisation step in between — that is the point.
    const parsed = askParseMessage(built);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.reactable).toEqual(["A", "B", "C"]);
  });
});

describe("ask reads back the shortcode pills Slack actually stores", () => {
  /** What conversations.history returns for a body built with glyphs. */
  const asStored = (t: string) =>
    t.replace(/1️⃣/g, ":one:").replace(/2️⃣/g, ":two:").replace(/3️⃣/g, ":three:");

  test("a stored (shortcode) body parses, choices intact", () => {
    const parsed = askParseMessage(asStored(askBuildText("q", "", ["A", "B", "C"], [], true)));
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.reactable).toEqual(["A", "B", "C"]);
    expect(parsed.question).toBe("q");
  });

  test("the glyph spelling still parses (a body hand-edited in the Slack UI)", () => {
    const parsed = askParseMessage(askBuildText("q", "", ["A", "B"], [], true));
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.reactable).toEqual(["A", "B"]);
  });

  test("a body with the real shape that failed: mentions, blank lines, 3 choices", () => {
    // Mirrors the reported message — a tagged question, several body
    // paragraphs, then the pills. The walk-up has to cross all of it.
    const body = "背景の段落。\n\n二つ目の段落。";
    const parsed = askParseMessage(asStored(
      askBuildText("<@U00000001> どうする?", body, ["加える", "一緒に加える", "まだ"], [], false),
    ));
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.reactable).toEqual(["加える", "一緒に加える", "まだ"]);
  });
});

describe("ask identity is language-independent", () => {
  test("the marker leads the body and the question still round-trips", () => {
    const text = askBuildText("q", "", ["A", "B"], [], true);
    expect(text.startsWith(":question: *q*")).toBe(true);
    const parsed = askParseMessage(text);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.question).toBe("q");
    expect(parsed.reactable).toEqual(["A", "B"]);
  });

  test("a pre-marker body still parses (old questions stay collectable)", () => {
    // Exactly what `ask` used to post: no marker, identified by the trailing
    // instruction alone.
    const legacy = askBuildText("q", "", ["A", "B"], [], true).replace(":question: ", "");
    const parsed = askParseMessage(legacy);
    expect(parsed.kind).toBe("open");
    if (parsed.kind !== "open") return;
    expect(parsed.question).toBe("q");
    expect(parsed.reactable).toEqual(["A", "B"]);
  });

  test("resolved wins over open, so a settled question is never re-polled", () => {
    const resolved = askBuildResolvedText("q", { answer: "はい", how: "返信" }, "");
    expect(askParseMessage(resolved).kind).toBe("resolved");
  });
});
