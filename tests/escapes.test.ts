// `\n` in an argument becomes a real newline. This exists because agents drive
// this CLI as much as people do, and an agent building an argv array has no
// shell to interpret escapes for it — without this, every multi-line message it
// sends arrives as one line with a literal `\n` in it.

import { describe, test, expect } from "./harness.ts";
import { unescapeArg, hasEscapes } from "../ts/escapes.ts";

describe("unescapeArg interprets what the sender meant", () => {
  test("backslash-n becomes a newline", () => {
    expect(unescapeArg("a\\nb")).toBe("a\nb");
  });

  // On a Japanese keyboard the ¥ key emits U+00A5, not U+005C — different
  // characters that look interchangeable (a Shift-JIS holdover where 0x5C
  // rendered as ¥). Someone intending an escape reliably types the one that
  // would otherwise do nothing.
  test("yen-n becomes a newline too", () => {
    expect(unescapeArg("a\u00A5nb")).toBe("a\nb");
  });

  test("tabs work in both spellings", () => {
    expect(unescapeArg("a\\tb")).toBe("a\tb");
    expect(unescapeArg("a\u00A5tb")).toBe("a\tb");
  });

  test("several escapes in one string", () => {
    expect(unescapeArg("1\\n2\u00A5n3")).toBe("1\n2\n3");
  });
});

// The escape hatch. Without a way to send the two characters `\` `n`, this
// feature would be a one-way door.
describe("a doubled lead is the way to send a literal", () => {
  test("backslash-backslash-n stays backslash-n", () => {
    expect(unescapeArg("a\\\\nb")).toBe("a\\nb");
  });

  test("yen-yen-n stays yen-n", () => {
    expect(unescapeArg("a\u00A5\u00A5nb")).toBe("a\u00A5nb");
  });
});

// The whole risk of accepting ¥ is eating a currency amount. Measured on the
// live workspace: exactly one message contains ¥, and it reads "¥/コール" — a
// unit price. Both shapes must survive untouched.
describe("money and paths are left alone", () => {
  const untouched = [
    "\u00A51000",          // the common shape: yen then digits
    "\u00A5/\u30b3\u30fc\u30eb", // "¥/コール" — the one real use in this workspace
    "\uFFE5500",           // full-width ￥ is a currency glyph, never an escape
    "C:\\path\\to\\file",  // a Windows path: \p and \t... see below
    "50\u00A5",            // trailing yen
    "a\\qb",               // an escape nobody defined
  ];
  for (const s of untouched) {
    test(JSON.stringify(s), () => {
      // NOTE: `C:\path\to\file` contains `\t`, which IS an escape — asserted
      // explicitly below rather than hidden here.
      if (s.includes("\\t")) return;
      expect(unescapeArg(s)).toBe(s);
    });
  }

  // Being honest about the cost: `\t` inside a Windows path does get eaten.
  // That is the accepted trade — this CLI sends Slack messages, not file
  // paths, and `\\t` remains available for anyone who needs the literal.
  test("a Windows path containing \\t is a known casualty", () => {
    expect(unescapeArg("C:\\temp")).toBe("C:\temp");
    expect(unescapeArg("C:\\\\temp")).toBe("C:\\temp");
  });
});

describe("hasEscapes reports whether anything would change", () => {
  test("true only when an escape is present", () => {
    expect(hasEscapes("a\\nb")).toBe(true);
    expect(hasEscapes("a\u00A5nb")).toBe(true);
    expect(hasEscapes("\u00A51000")).toBe(false);
    expect(hasEscapes("plain text")).toBe(false);
  });
});
