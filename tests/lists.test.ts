// Unit tests for ts/lists.ts — CLI strings → slackLists.* schema / cell shapes.

import { describe, test, expect } from "./harness.ts";
import { buildListSchema, cellValue, completedColumn, findColumn, parseColumnSpec, parseListSchema, parseSets, type ListColumn } from "../ts/lists.ts";

describe("parseColumnSpec", () => {
  test("name:type, with a slash in the name", () => {
    expect(parseColumnSpec("媒体/項目:text")).toEqual({ name: "媒体/項目", type: "text" });
  });
  test("type defaults to text", () => {
    expect(parseColumnSpec("担当")).toEqual({ name: "担当", type: "text" });
  });
  test("select takes choices", () => {
    expect(parseColumnSpec("状態:select:todo, doing ,done")).toEqual({ name: "状態", type: "select", choices: ["todo", "doing", "done"] });
  });
  test("rejects a missing name, an unknown type, a select without choices, extra parts", () => {
    expect(() => parseColumnSpec(":text")).toThrow("needs a name");
    expect(() => parseColumnSpec("a:rainbow")).toThrow('unknown type "rainbow"');
    expect(() => parseColumnSpec("a:select")).toThrow("needs choices");
    expect(() => parseColumnSpec("a:link:x")).toThrow("only select");
  });
});

describe("buildListSchema", () => {
  test("generated keys, first column primary, select choices, user entity format", () => {
    const schema = buildListSchema([
      { name: "媒体/項目", type: "text" },
      { name: "状態", type: "select", choices: ["todo", "done"] },
      { name: "担当", type: "user" },
    ]) as Record<string, unknown>[];
    expect(schema[0]).toEqual({ key: "col1", name: "媒体/項目", type: "text", is_primary_column: true });
    expect(schema[1]).toEqual({
      key: "col2", name: "状態", type: "select",
      options: { format: "single_select", choices: [{ value: "todo", label: "todo", color: "gray" }, { value: "done", label: "done", color: "blue" }] },
    });
    expect(schema[2]).toEqual({ key: "col3", name: "担当", type: "user", options: { format: "single_entity" } });
  });
  test("needs a text first column", () => {
    expect(() => buildListSchema([])).toThrow("at least one --col");
    expect(() => buildListSchema([{ name: "x", type: "link" }])).toThrow("must be text");
  });
});

const COLS: ListColumn[] = [
  { id: "Col001", key: "col1", name: "媒体/項目", type: "text", choices: [] },
  { id: "Col002", key: "col2", name: "状態", type: "select", choices: [{ value: "todo", label: "todo" }, { value: "done", label: "Done!" }] },
  { id: "Col003", key: "todo_completed", name: "Completed", type: "todo_completed", choices: [] },
];

describe("parseListSchema / findColumn / completedColumn", () => {
  test("reads list_metadata.schema", () => {
    const cols = parseListSchema({ list_metadata: { schema: [{ id: "Col002", key: "col2", name: "状態", type: "select", options: { choices: [{ value: "todo", label: "todo" }, { value: "x" }] } }] } });
    expect(cols).toEqual([{ id: "Col002", key: "col2", name: "状態", type: "select", choices: [{ value: "todo", label: "todo" }, { value: "x", label: "x" }] }]);
  });
  test("falls back to a top-level schema, and to nothing", () => {
    expect(parseListSchema({ schema: [{ id: "C1" }] })).toEqual([{ id: "C1", key: "", name: "", type: "", choices: [] }]);
    expect(parseListSchema({})).toEqual([]);
  });
  test("finds by name, key, or id; names the columns on a miss", () => {
    expect(findColumn(COLS, "状態").id).toBe("Col002");
    expect(findColumn(COLS, "col1").id).toBe("Col001");
    expect(findColumn(COLS, "Col003").id).toBe("Col003");
    expect(() => findColumn(COLS, "nope")).toThrow("columns: 媒体/項目, 状態, Completed");
  });
  test("completedColumn finds the todo_mode column", () => {
    expect(completedColumn(COLS)?.id).toBe("Col003");
    expect(completedColumn(COLS.slice(0, 2))).toBeUndefined();
  });
});

describe("cellValue", () => {
  const col = (type: string, extra: Partial<ListColumn> = {}): ListColumn => ({ id: "C", key: "k", name: "n", type, choices: [], ...extra });
  test("text is rich_text", () => {
    expect(cellValue(col("text"), "hello 1")).toEqual({
      rich_text: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "hello 1" }] }] }],
    });
  });
  test("select maps a value or label to the option value", () => {
    expect(cellValue(COLS[1]!, "todo")).toEqual({ select: ["todo"] });
    expect(cellValue(COLS[1]!, "Done!")).toEqual({ select: ["done"] });
    expect(() => cellValue(COLS[1]!, "later")).toThrow("not an option");
  });
  test("user, link, date, number, checkbox", () => {
    expect(cellValue(col("user"), "U00000001")).toEqual({ user: ["U00000001"] });
    expect(cellValue(col("link"), "https://example.com")).toEqual({ link: [{ original_url: "https://example.com", display_as_url: true }] });
    expect(cellValue(col("date"), "2026-10-19")).toEqual({ date: ["2026-10-19"] });
    expect(cellValue(col("number"), "5")).toEqual({ number: [5] });
    expect(() => cellValue(col("number"), "five")).toThrow("not a number");
    expect(cellValue(col("checkbox"), "true")).toEqual({ checkbox: true });
    expect(cellValue(col("todo_completed"), "false")).toEqual({ checkbox: false });
    expect(() => cellValue(col("checkbox"), "yes")).toThrow("true or false");
    expect(() => cellValue(col("canvas"), "x")).toThrow("not supported");
  });
});

describe("parseSets", () => {
  test("splits on the first =", () => {
    expect(parseSets(["状態=done", "リンク=https://x.example/?a=b"])).toEqual([
      { col: "状態", value: "done" },
      { col: "リンク", value: "https://x.example/?a=b" },
    ]);
    expect(() => parseSets(["=x"])).toThrow("name=value");
  });
});
