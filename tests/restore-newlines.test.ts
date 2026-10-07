// The repair readers apply to messages Slack stored flattened, and the fixture
// builder (tests/slack-markdown.ts) that gives them Slack-shaped blocks. The
// builder's expected shapes are what Slack's own markdown block produced for
// the same input (fitted against 247 messages this CLI sent; the samples here
// are synthetic stand-ins with the same structure).

import { describe, test, expect } from "./harness.ts";
import { markdownToRichText } from "./slack-markdown.ts";
import { restoreNewlines, repairMessageText } from "../ts/newlines.ts";
import { askBuildText, askParseMessage } from "../ts/ask.ts";

type B = Record<string, unknown>;
const T = (text: string, style?: B): B => (style ? { type: "text", text, style } : { type: "text", text });
const SEC = (...elements: B[]): B => ({ type: "rich_text_section", elements });
const rich = (md: string): B[] => {
  const blocks = markdownToRichText(md);
  if (!blocks) throw new Error(`no rich_text for ${JSON.stringify(md)}`);
  return blocks as B[];
};
/** All the `\n` the blocks render — the count `.text` has to keep. */
function blockNewlines(blocks: unknown): number {
  let n = 0;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === "object") {
      const o = x as B;
      if (o.type === "text" && typeof o.text === "string") n += o.text.split("\n").length - 1;
      Object.values(o).forEach(walk);
    }
  };
  walk(blocks);
  return n;
}

describe("fixture builder: markdownToRichText — paragraphs keep their line breaks", () => {
  test("a multi-line message is one section whose text carries every \\n", () => {
    const md = "[slack-term-nl] 换行测试\n第一行\n第二行\n\n第三行";
    expect(rich(md)).toEqual([{ type: "rich_text", elements: [SEC(T(md))] }]);
    expect(blockNewlines(rich(md))).toBe(4);
  });
  test("trailing spaces at a line end are dropped, as Slack does", () => {
    expect(rich("a  \nb ")).toEqual([{ type: "rich_text", elements: [SEC(T("a\nb"))] }]);
  });
});

describe("fixture builder: markdownToRichText — lists", () => {
  test("`-` and `•` bullets; a blank line before the list ends the paragraph with \\n\\n", () => {
    expect(rich("intro\n\n- one\n- two")).toEqual([{ type: "rich_text", elements: [
      SEC(T("intro\n\n")),
      { type: "rich_text_list", style: "bullet", indent: 0, elements: [SEC(T("one")), SEC(T("two"))] },
    ] }]);
    expect(rich("intro\n• one\n• two")).toEqual([{ type: "rich_text", elements: [
      SEC(T("intro")),
      { type: "rich_text_list", style: "bullet", indent: 0, elements: [SEC(T("one")), SEC(T("two"))] },
    ] }]);
  });
  test("ordered lists: a list that starts past 1 carries the offset; a nested list splits the run", () => {
    expect(rich("1. a\n   - x\n   - y\n2. b")).toEqual([{ type: "rich_text", elements: [
      { type: "rich_text_list", style: "ordered", indent: 0, elements: [SEC(T("a"))] },
      { type: "rich_text_list", style: "bullet", indent: 1, elements: [SEC(T("x")), SEC(T("y"))] },
      { type: "rich_text_list", style: "ordered", indent: 0, elements: [SEC(T("b"))] },
    ] }]);
    expect(rich("- a\n\n4. d")).toEqual([{ type: "rich_text", elements: [
      { type: "rich_text_list", style: "bullet", indent: 0, elements: [SEC(T("a"))] },
      SEC(T("\n")),
      { type: "rich_text_list", style: "ordered", indent: 0, offset: 3, elements: [SEC(T("d"))] },
    ] }]);
  });
  test("an unindented line right after an item continues it (lazy continuation)", () => {
    expect(rich("- a\nmore")).toEqual([{ type: "rich_text", elements: [
      { type: "rich_text_list", style: "bullet", indent: 0, elements: [SEC(T("a\nmore"))] },
    ] }]);
  });
  test("a paragraph after a list across a blank line starts with \\n", () => {
    expect(rich("- a\n\nafter")).toEqual([{ type: "rich_text", elements: [
      { type: "rich_text_list", style: "bullet", indent: 0, elements: [SEC(T("a"))] },
      SEC(T("\nafter")),
    ] }]);
  });
  test("an INDENTED marker inside a paragraph stays text, as in Slack", () => {
    expect(rich("head\n   - x")).toEqual([{ type: "rich_text", elements: [SEC(T("head\n- x"))] }]);
  });
});

describe("fixture builder: markdownToRichText — inline", () => {
  test("`*x*`/`_x_` italic, `**x**` bold, `~~x~~` strike, `code`", () => {
    expect(rich("*i* _j_ **b** ~~s~~ `c`")).toEqual([{ type: "rich_text", elements: [SEC(
      T("i", { italic: true }), T(" "), T("j", { italic: true }), T(" "), T("b", { bold: true }), T(" "),
      T("s", { strike: true }), T(" "), T("c", { code: true }),
    )] }]);
  });
  test("a lone `*` is literal (`*.invalid`)", () => {
    expect(rich("宛先は *.invalid です")).toEqual([{ type: "rich_text", elements: [SEC(T("宛先は *.invalid です"))] }]);
  });
  test("Slack escapes: mentions, channels, broadcasts, labelled and bare links", () => {
    expect(rich("<@U00000001> <#C00000001|general> <!here> <https://acme.slack.com/x|label> <https://acme.slack.com/y>")).toEqual([{ type: "rich_text", elements: [SEC(
      { type: "user", user_id: "U00000001" }, T(" "),
      { type: "channel", channel_id: "C00000001" }, T(" "),
      { type: "broadcast", range: "here" }, T(" "),
      { type: "link", url: "https://acme.slack.com/x", text: "label" }, T(" "),
      { type: "link", url: "https://acme.slack.com/y" },
    )] }]);
  });
  test("bare URLs after whitespace become links; trailing punctuation stays out; glued ones stay text", () => {
    expect(rich("see https://acme.slack.com/a. ok")).toEqual([{ type: "rich_text", elements: [SEC(
      T("see "), { type: "link", url: "https://acme.slack.com/a" }, T(". ok"),
    )] }]);
    expect(rich("预览：https://acme.slack.com/a")).toEqual([{ type: "rich_text", elements: [SEC(T("预览：https://acme.slack.com/a"))] }]);
  });
  test("emails after whitespace become mailto links", () => {
    expect(rich("to alice@acme.example.com now")).toEqual([{ type: "rich_text", elements: [SEC(
      T("to "), { type: "link", url: "mailto:alice@acme.example.com" }, T(" now"),
    )] }]);
  });
  test("`:emoji:` shortcodes; a colon pair inside a word (`a:ref:b`) is text", () => {
    expect(rich(":tada: done")).toEqual([{ type: "rich_text", elements: [SEC({ type: "emoji", name: "tada" }, T(" done"))] }]);
    expect(rich("repo:acme/x:ref:refs/heads/main")).toEqual([{ type: "rich_text", elements: [SEC(T("repo:acme/x:ref:refs/heads/main"))] }]);
  });
  test("`[label](url)` with a real URL is a link; `[lane](free text)` is not", () => {
    expect(rich("[docs](https://acme.slack.com/d)")).toEqual([{ type: "rich_text", elements: [SEC({ type: "link", url: "https://acme.slack.com/d", text: "docs" })] }]);
    expect(rich("[lane](agent post)")).toEqual([{ type: "rich_text", elements: [SEC(T("[lane](agent post)"))] }]);
  });
  test("entities decode to the characters they stand for", () => {
    expect(rich("a &amp; b &lt;c&gt;")).toEqual([{ type: "rich_text", elements: [SEC(T("a & b <c>"))] }]);
  });
});

describe("fixture builder: markdownToRichText — code, quotes, dividers, and what falls back", () => {
  test("a fenced block is preformatted, its lines kept", () => {
    expect(rich("run:\n```\nls -la\npwd\n```")).toEqual([{ type: "rich_text", elements: [
      SEC(T("run:")), { type: "rich_text_preformatted", elements: [T("ls -la\npwd")] },
    ] }]);
  });
  test("`>` lines are a quote", () => {
    expect(rich("> quoted\n> more")).toEqual([{ type: "rich_text", elements: [{ type: "rich_text_quote", elements: [T("quoted\nmore")] }] }]);
  });
  test("`---` is a divider between rich_text blocks", () => {
    expect(rich("a\n\n---\nb")).toEqual([
      { type: "rich_text", elements: [SEC(T("a"))] }, { type: "divider" }, { type: "rich_text", elements: [SEC(T("b"))] },
    ]);
  });
  test("headings, setext underlines and tables are not modelled → null", () => {
    expect(markdownToRichText("# Title\nbody")).toBeNull();
    expect(markdownToRichText("Title\n=====")).toBeNull();
    expect(markdownToRichText("| a | b |\n|---|---|\n| 1 | 2 |")).toBeNull();
  });
});

// What Slack stored for a message sent with a `markdown` block: the source with
// every newline turned into one space, plus its blocks (which kept the breaks).
const flatten = (md: string) => md.replace(/\n/g, " ");

describe("restoreNewlines — old flattened messages read back with their breaks", () => {
  const samples = [
    "[slack-term-nl] 换行测试\n第一行\n第二行\n\n第三行",
    "intro\n\n- one\n- two\n\nafter",
    "1. a\n   - x\n   - y\n2. b",
    "*見出し*\n• 項目 `code`\n• <https://acme.slack.com/x|ラベル の 説明>\n\n<@U00000001> 確認お願いします",
    "run:\n```\nls -la\npwd\n```\ndone",
    "a & b\n<c> d",
  ];
  for (const md of samples) {
    test(`round-trips ${JSON.stringify(md.slice(0, 30))}`, () => {
      const stored = flatten(md).replace(/&/g, "&amp;").replace(/<c>/g, "&lt;c&gt;");
      const want = md.replace(/&/g, "&amp;").replace(/<c>/g, "&lt;c&gt;");
      expect(restoreNewlines(stored, rich(md) as never)).toBe(want);
    });
  }
  test("a flattened blockquote gets its quote lines back, escaped or raw", () => {
    const blocks = rich("> first\n> second") as never;
    expect(restoreNewlines("&gt; first &gt; second", blocks)).toBe("&gt; first\n&gt; second");
    expect(restoreNewlines("> first > second", blocks)).toBe("> first\n> second");
  });
  test("a label with spaces inside <url|label> is not split", () => {
    const md = "<https://acme.slack.com/x|a b c>\nnext";
    expect(restoreNewlines(flatten(md), rich(md) as never)).toBe(md);
  });
  test("the live 2026-10-07 test DM: sent with rich_text blocks, stored flattened all the same", () => {
    const stored = "[slack-term-nl] Test des retours à la ligne Ligne 1 : texte simple Ligne 2 : **gras** - élément un - élément deux";
    const blocks = [{ type: "rich_text", elements: [
      SEC(T("[slack-term-nl] Test des retours à la ligne\nLigne 1 : texte simple\nLigne 2 : "), T("gras", { bold: true })),
      { type: "rich_text_list", style: "bullet", indent: 0, elements: [SEC(T("élément un")), SEC(T("élément deux"))] },
    ] }];
    expect(restoreNewlines(stored, blocks as never)).toBe("[slack-term-nl] Test des retours à la ligne\nLigne 1 : texte simple\nLigne 2 : **gras**\n- élément un\n- élément deux");
  });
  test("only ever turns spaces into newlines", () => {
    for (const md of samples) {
      const stored = flatten(md);
      expect(restoreNewlines(stored, rich(md) as never).replace(/\n/g, " ")).toBe(stored);
    }
  });
  test("leaves a text alone that already has line breaks, has no blocks, or cannot be aligned", () => {
    const md = "a\nb";
    expect(restoreNewlines(md, rich(md) as never)).toBe(md);
    expect(restoreNewlines("a b", undefined)).toBe("a b");
    expect(restoreNewlines("a b", [] as never)).toBe("a b");
    expect(restoreNewlines("x y", rich("a\nb") as never)).toBe("x y");
  });
  test("a single-line message stays as it is", () => {
    expect(restoreNewlines("just one line", rich("just one line") as never)).toBe("just one line");
  });
  test("a flattened ask parses again once repaired", () => {
    const ask = askBuildText("<@U00000BOB> どっち?", "背景: リリース前\n推奨: B", ["A", "B"], [], false);
    expect(askParseMessage(flatten(ask)).kind).toBe("other");
    const msg = { type: "message", text: flatten(ask), blocks: rich(ask) };
    repairMessageText(msg as never);
    expect(msg.text).toBe(ask);
    expect(askParseMessage(msg.text).kind).toBe("open");
  });
});
