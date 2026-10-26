import { describe, test, expect } from "./harness.ts";
import { attachmentLines, parseAttachments } from "../ts/attachments.ts";

const iso = (ts: string) => `T${ts}`;

describe("parseAttachments", () => {
  test("no attachments → empty", () => {
    expect(parseAttachments({ text: "hi" })).toEqual([]);
    expect(parseAttachments({ attachments: "nope" })).toEqual([]);
  });

  test("a forwarded message (is_share)", () => {
    const [a] = parseAttachments({ attachments: [{
      is_share: true, author_id: "U00000002", author_name: "bob", channel_id: "C00000001",
      ts: "1700000000.000100", text: "hello", fallback: "[fwd] hello", from_url: "https://acme.slack.com/archives/C00000001/p1700000000000100",
    }] });
    expect(a).toEqual({
      shared: true, unfurl: false, author_id: "U00000002", author_name: "bob", channel_id: "C00000001",
      ts: "1700000000.000100", title: null, text: "hello", permalink: "https://acme.slack.com/archives/C00000001/p1700000000000100",
    });
  });

  test("an older share carries its text in message_blocks", () => {
    const [a] = parseAttachments({ attachments: [{
      message_blocks: [{ channel: "C00000001", ts: "1700000000.000100", message: { user: "U00000002", text: "from blocks" } }],
    }] });
    expect(a).toMatchObject({ shared: true, author_id: "U00000002", channel_id: "C00000001", ts: "1700000000.000100", text: "from blocks" });
  });

  test("a bot attachment and a link unfurl", () => {
    const [bot, link, bare] = parseAttachments({ attachments: [
      { title: "Build #12", title_link: "https://ci.example/12", pretext: "passed" },
      { original_url: "https://example.com/", title: "Example", text: "blurb" },
      "junk",
    ] });
    expect(bot).toMatchObject({ shared: false, unfurl: false, title: "Build #12", text: "passed", permalink: "https://ci.example/12" });
    expect(link).toMatchObject({ unfurl: true, permalink: "https://example.com/" });
    expect(bare).toMatchObject({ shared: false, unfurl: false, text: "", title: null, permalink: null });
  });
});

describe("attachmentLines", () => {
  test("renders a share with author, channel, ts, quoted body and link", () => {
    const atts = parseAttachments({ attachments: [{
      is_share: true, author_name: "bob", channel_id: "C00000001", ts: "1.2", text: "line one\nline two\n", from_url: "https://x/1",
    }] });
    expect(attachmentLines(atts, iso)).toBe(
      "\n   ↪ shared message from @bob in <#C00000001> · T1.2\n     │ line one\n     │ line two\n     https://x/1",
    );
  });

  test("falls back to the author id; omits missing parts", () => {
    const atts = parseAttachments({ attachments: [{ is_share: true, author_id: "U00000002", text: "x" }] });
    expect(attachmentLines(atts, iso)).toBe("\n   ↪ shared message from @U00000002\n     │ x");
    expect(attachmentLines(parseAttachments({ attachments: [{ is_share: true, fallback: "y" }] }), iso))
      .toBe("\n   ↪ shared message\n     │ y");
  });

  test("bot attachments get a title line; unfurls and empty ones are skipped", () => {
    const atts = parseAttachments({ attachments: [
      { title: "Build #12" },
      { text: "untitled" },
      { original_url: "https://example.com/", title: "Example", text: "blurb" },
      {},
    ] });
    expect(attachmentLines(atts, iso)).toBe("\n   ▸ Build #12\n   ▸ attachment\n     │ untitled");
  });
});
