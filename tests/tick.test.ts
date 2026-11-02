import { describe, expect, test } from "./harness.ts";
import { keepLanePrefix, tickText } from "../ts/tick.ts";

describe("tickText", () => {
  const list = "[design] plan\n⬜ 1. build\n⬜ 2. test\n✅ 3. spec";
  test("ticks item n only", () => {
    expect(tickText(list, 2)).toEqual({ kind: "ticked", n: 2, text: "[design] plan\n⬜ 1. build\n✅ 2. test\n✅ 3. spec" });
  });
  test("keeps the shortcode spelling Slack stored", () => {
    expect(tickText(":white_large_square: 1. a", 1)).toEqual({ kind: "ticked", n: 1, text: ":white_check_mark: 1. a" });
  });
  test("the variation-selector box too", () => expect(tickText("⬜️ 1. a").kind).toBe("ticked"));
  test("already ticked", () => expect(tickText(list, 3)).toEqual({ kind: "already", n: 3 }));
  test("no n with several open: ambiguous", () => expect(tickText(list)).toEqual({ kind: "ambiguous", open: [1, 2] }));
  test("no n with one open: that one", () => expect(tickText("⬜ 4. x\n✅ 5. y")).toEqual({ kind: "ticked", n: 4, text: "✅ 4. x\n✅ 5. y" }));
  test("no n, nothing open but done items: already", () => expect(tickText("✅ 1. x").kind).toBe("already"));
  test("no checklist at all", () => expect(tickText("hello")).toEqual({ kind: "none" }));
  test("a number that is not an item", () => expect(tickText(list, 9)).toEqual({ kind: "missing", n: 9 }));
  test("a 12. is not item 1", () => expect(tickText("⬜ 12. x\n⬜ 1. y", 1)).toEqual({ kind: "ticked", n: 1, text: "⬜ 12. x\n✅ 1. y" }));
});

describe("keepLanePrefix", () => {
  test("keeps the original's tag when the new text drops it", () => expect(keepLanePrefix("[design] old", "new", "[design]")).toBe("[design] new"));
  test("keeps [lane@host] as posted", () => expect(keepLanePrefix("[design@host1] old", "[design] new", "[design]")).toBe("[design@host1] new"));
  test("another lane's message: untouched", () => expect(keepLanePrefix("[shr] old", "new", "[design]")).toBe("new"));
  test("no scope prefix: untouched", () => expect(keepLanePrefix("[design] old", "new", undefined)).toBe("new"));
});
