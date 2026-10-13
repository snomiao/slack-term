import { describe, expect, test } from "./harness.ts";
import { adjacentUrls, guardUrlBoundaries, linkifyRichText, urlBoundaryIssues } from "../ts/urlGuard.ts";

describe("URL boundaries", () => {
  for (const suffix of ["内容", "）", "」", "。", "、", ">", ">*", "\u00a0内容", "\u3000内容"]) {
    test(`rejects ambiguous suffix ${JSON.stringify(suffix)}`, () => {
      const url = `https://example.com/path/${suffix}`;
      expect(adjacentUrls(url)).toEqual([url]);
      expect(() => guardUrlBoundaries(url)).toThrow("Put the URL on its own line");
    });
  }
  for (const text of [
    "https://example.com/path/\n内容", "https://example.com/path/\r\n内容",
    "https://example.com/path/ 内容", "https://example.com/path/\t内容",
    "<https://example.com/path/>内容", "<https://example.com/path/|説明>内容",
    "<https://example.com/日本語>", "https://example.com/%E5%B1%B1?a=1&b=2#part",
    "HTTP://example.com/path/\n内容",
  ]) {
    test(`accepts explicit boundary ${JSON.stringify(text)}`, () => {
      expect(adjacentUrls(text)).toEqual([]);
      expect(() => guardUrlBoundaries(text)).not.toThrow();
    });
  }
  test("an explicit link does not hide a later ambiguous URL", () => {
    expect(adjacentUrls("<https://example.com/|説明> https://example.com/内容"))
      .toEqual(["https://example.com/内容"]);
  });
  test("override emits a warning naming the URL", () => {
    const warnings: string[] = [];
    guardUrlBoundaries("http://example.com/内容", true, (s) => warnings.push(s));
    expect(warnings[0]).toContain("Warning: Ambiguous URL boundary");
    expect(warnings[0]).toContain("http://example.com/内容");
  });

  // Glued on the LEFT: Slack does not autolink it at all — the URL is stored in
  // a plain `text` element and shows as dead text (full-width colon case).
  for (const prefix of ["説明：", "説明:", "（", "「", "内容", "x", "\u3000", "\u00a0", "→"]) {
    test(`rejects URL glued to preceding ${JSON.stringify(prefix)}`, () => {
      const text = `① ${prefix}https://acme.slack.com/archives/C00000001/p1700000000000100`;
      expect(urlBoundaryIssues(text)).toEqual([{
        url: "https://acme.slack.com/archives/C00000001/p1700000000000100", side: "before", char: [...prefix].at(-1)!,
      }]);
      expect(() => guardUrlBoundaries(text)).toThrow("Put an ASCII space (or a newline) before the URL");
    });
  }
  for (const text of [
    "説明: https://example.com/x", "説明：\nhttps://example.com/x", "https://example.com/x",
    "(https://example.com/x)", "*https://example.com/x*", "_https://example.com/x_", "~https://example.com/x~",
    "説明：<https://example.com/x>", "説明：<https://example.com/x|リンク>",
  ]) {
    test(`accepts URL with a safe left boundary ${JSON.stringify(text)}`, () => {
      expect(adjacentUrls(text)).toEqual([]);
    });
  }
  for (const text of [
    "説明：`https://example.com/x`", "`https://example.com/内容`",
    "説明：\n```\ncurl https://example.com/内容\n説明：https://example.com/x\n```",
  ]) {
    test(`ignores URLs inside code ${JSON.stringify(text)}`, () => {
      expect(adjacentUrls(text)).toEqual([]);
      expect(() => guardUrlBoundaries(text)).not.toThrow();
    });
  }
  test("a URL glued to the end of a code span is still caught", () => {
    expect(urlBoundaryIssues("`x`https://example.com/")).toEqual([{ url: "https://example.com/", side: "before", char: "`" }]);
  });
  test("an escaped backtick does not open a code span", () => {
    expect(adjacentUrls("\\`説明：https://example.com/x \\`")).toEqual(["https://example.com/x"]);
  });
  test("a double-backtick span containing a single backtick is masked whole", () => {
    expect(adjacentUrls("``echo ` 説明：https://example.com/x``")).toEqual([]);
  });
  test("an unclosed backtick is literal and hides nothing", () => {
    expect(adjacentUrls("`説明：https://example.com/x")).toEqual(["https://example.com/x"]);
  });
  test("a ~~~ fence and an unterminated ``` fence are masked", () => {
    expect(adjacentUrls("~~~\n説明：https://example.com/x\n~~~")).toEqual([]);
    expect(adjacentUrls("```\n説明：https://example.com/x")).toEqual([]);
  });
  test("text after a closed fence is still checked", () => {
    expect(adjacentUrls("```\nx\n```\n説明：https://example.com/x")).toEqual(["https://example.com/x"]);
  });
  test("a markdown [label](url) link is explicit and accepted", () => {
    expect(adjacentUrls("説明：[https://example.com/x](https://example.com/x)")).toEqual([]);
    expect(adjacentUrls("[docs](https://example.com/内容)")).toEqual([]);
  });
  test("a URL glued on BOTH sides reports both", () => {
    expect(urlBoundaryIssues("説明：https://example.com/日本語")).toEqual([
      { url: "https://example.com/日本語", side: "before", char: "：" },
      { url: "https://example.com/日本語", side: "after", char: "日" },
    ]);
    expect(adjacentUrls("説明：https://example.com/日本語")).toEqual(["https://example.com/日本語"]);
  });
  test("```x``` on one line is an inline span, not a fence that hides what follows", () => {
    expect(adjacentUrls("```x```\n説明：https://example.com/x")).toEqual(["https://example.com/x"]);
  });
  test("a CRLF-closed fence ends where it should", () => {
    expect(adjacentUrls("```\r\nx\r\n```\r\n説明：https://example.com/x")).toEqual(["https://example.com/x"]);
  });
  test("an escaped \\] does not close a link label", () => {
    expect(adjacentUrls("[説明：https://example.com/x\\](foo)")).toEqual(["https://example.com/x\\](foo)"]);
  });
  test("markdown: false (drafts) masks nothing", () => {
    expect(adjacentUrls("`説明：https://example.com/x`")).toEqual([]);
    expect(urlBoundaryIssues("[docs](https://example.com/日本語)", { markdown: false }).map((i) => i.side)).toEqual(["after"]);
    expect(() => guardUrlBoundaries("[docs](https://example.com/日本語)", false, undefined, { sides: ["after"], markdown: false }))
      .toThrow("Ambiguous URL boundary");
    expect(() => guardUrlBoundaries("説明：https://example.com/日本語", false, undefined, { sides: ["after"], markdown: false }))
      .toThrow("runs into");
  });
  test("code masking does not hide a glued URL outside the span", () => {
    expect(adjacentUrls("`code` 説明：https://example.com/x")).toEqual(["https://example.com/x"]);
  });
  test("the error names the glued character and says the link will be dead", () => {
    expect(() => guardUrlBoundaries("説明：https://example.com/x")).toThrow(/glued to "：" before it — Slack will NOT make it a link/);
  });
});

describe("linkifyRichText (drafts)", () => {
  test("a URL glued to CJK punctuation becomes a real link element", () => {
    expect(linkifyRichText("説明：https://example.com/x 以上")).toEqual([
      { type: "text", text: "説明：" },
      { type: "link", url: "https://example.com/x" },
      { type: "text", text: " 以上" },
    ]);
  });
  test("a bare URL stops at the first non-ASCII character", () => {
    expect(linkifyRichText("https://example.com/path/内容")).toEqual([
      { type: "link", url: "https://example.com/path/" },
      { type: "text", text: "内容" },
    ]);
  });
  test("trailing punctuation and an unbalanced paren stay outside the link", () => {
    expect(linkifyRichText("(see https://example.com/a_(b).)")).toEqual([
      { type: "text", text: "(see " },
      { type: "link", url: "https://example.com/a_(b)" },
      { type: "text", text: ".)" },
    ]);
  });
  test("explicit <url> and <url|label> keep their label", () => {
    expect(linkifyRichText("<https://example.com/日本語> と <https://example.com/x|説明>")).toEqual([
      { type: "link", url: "https://example.com/日本語" },
      { type: "text", text: " と " },
      { type: "link", url: "https://example.com/x", text: "説明" },
    ]);
  });
  test("text without URLs is a single text element", () => {
    expect(linkifyRichText("hello 世界")).toEqual([{ type: "text", text: "hello 世界" }]);
  });
});
