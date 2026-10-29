import { describe, test, expect } from "./harness.ts";
import { messageExtras } from "../ts/msgExtras.ts";

describe("messageExtras: nothing a message carries is dropped silently", () => {
  test("plain text message: no extras", () => {
    expect(messageExtras({ ts: "1", text: "hi", blocks: [{ type: "rich_text", elements: [] }] })).toEqual([]);
  });

  test("a forwarded message: author, link and its quoted text", () => {
    const out = messageExtras({
      ts: "1", text: "fix it",
      attachments: [{
        is_share: true, is_msg_unfurl: true, author_name: "alice",
        from_url: "https://acme.slack.com/archives/C00000001/p1700000000000100",
        text: "use a transparent background\nnot white",
      }],
    });
    expect(out).toEqual([
      "↪ forwarded message from @alice  https://acme.slack.com/archives/C00000001/p1700000000000100",
      "  > use a transparent background",
      "  > not white",
    ]);
  });

  test("files: name, type, size, id", () => {
    expect(messageExtras({ ts: "1", files: [{ id: "F00000001", name: "chart.png", filetype: "png", size: 2048 }] }))
      .toEqual(["📎 chart.png  (png, 2.0 KB)  [F00000001]"]);
  });

  test("a link preview and a bot attachment", () => {
    const out = messageExtras({
      ts: "1",
      attachments: [
        { original_url: "https://example.com/a", title: "Example A", service_name: "Example" },
        { fallback: "Build #12 failed", color: "danger" },
      ],
    });
    expect(out).toEqual(["🔗 Example A — https://example.com/a", "📎 attachment: Build #12 failed"]);
  });

  test("blocks other than rich_text are counted by kind", () => {
    const out = messageExtras({ ts: "1", blocks: [{ type: "rich_text" }, { type: "section" }, { type: "section" }, { type: "actions" }] });
    expect(out).toEqual(["▦ 3 more blocks (section×2, actions) — see --json blocks"]);
  });
});
