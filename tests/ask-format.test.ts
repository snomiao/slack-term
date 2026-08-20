// The `ask` body is a wire format: `--waitFor` recovers a question from the
// posted message alone, so `askParseMessage` has to be the exact inverse of
// `askBuildText`. These tests are what stop a wording tweak from quietly making
// every in-flight question uncollectable.

import { describe, test, expect } from "vitest";
import { askBuildText, askBuildResolvedText, askParseMessage, ASK_KEYCAPS } from "../ts/ask.ts";

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
