// Unit tests for the To-dos tab helpers (ts/slackTodos.ts): parsing the
// undocumented saved.list shape defensively, ordering, and the status column.

import { describe, test, expect } from "./harness.ts";
import { isDone, messagePermalink, parseSavedItems, sortTodos, todoStatus, type TodoItem } from "../ts/slackTodos.ts";

const item = (over: Partial<TodoItem> = {}): TodoItem => ({
  channel: "C00000001", ts: "1700000000.000100", due: 0, completed: 0,
  todoState: "to_do", state: "in_progress", archived: false, itemType: "message", ...over,
});
const fmt = (s: number) => `T${s}`;

describe("parseSavedItems", () => {
  test("normalizes a saved.list page", () => {
    const got = parseSavedItems({
      ok: true,
      saved_items: [
        { item_id: "C00000001", item_type: "message", ts: "1700000000.000100", date_due: 1700000500, date_completed: 0,
          is_archived: false, state: "in_progress", todo_state: "to_do" },
        { item_id: "D00000001", item_type: "message", ts: "1700000001.000200", date_due: "1700000600", state: "completed",
          todo_state: "saved", is_archived: true },
      ],
    });
    expect(got).toEqual([
      item({ due: 1700000500 }),
      item({ channel: "D00000001", ts: "1700000001.000200", due: 1700000600, todoState: "saved", state: "completed", archived: true }),
    ]);
  });

  test("tolerates a missing or malformed list and odd entries", () => {
    expect(parseSavedItems({ ok: true })).toEqual([]);
    expect(parseSavedItems(null)).toEqual([]);
    expect(parseSavedItems([] as never)).toEqual([]);
    expect(parseSavedItems({ saved_items: [null, 3, ["x"], {}] } as never)).toEqual([
      { channel: "", ts: "", due: 0, completed: 0, todoState: "", state: "", archived: false, itemType: "" },
    ]);
    expect(parseSavedItems({ saved_items: [{ date_due: "soon", date_completed: Infinity }] } as never)[0]).toMatchObject({ due: 0, completed: 0 });
  });
});

describe("sortTodos", () => {
  test("soonest due first, then undated newest first; input untouched", () => {
    const a = item({ ts: "1.000001", due: 300 });
    const b = item({ ts: "2.000001", due: 100 });
    const c = item({ ts: "3.000001" });
    const d = item({ ts: "4.000001" });
    const input = [c, a, d, b];
    expect(sortTodos(input)).toEqual([b, a, d, c]);
    expect(input).toEqual([c, a, d, b]);
  });
});

describe("todoStatus / isDone", () => {
  test("a checked-off to-do reports todo_state completed", () => {
    expect(isDone(item({ todoState: "completed" }))).toBe(true);
  });

  test("open to-do, with and without a due date", () => {
    expect(todoStatus(item({ due: 500 }), 100, fmt)).toBe("☐ due T500");
    expect(todoStatus(item(), 100, fmt)).toBe("☐ no due date");
  });

  test("past due and not done is OVERDUE; done never is", () => {
    expect(todoStatus(item({ due: 50 }), 100, fmt)).toBe("☐ due T50  OVERDUE");
    expect(todoStatus(item({ due: 50, completed: 60 }), 100, fmt)).toBe("☑ due T50");
    expect(todoStatus(item({ due: 50, state: "completed" }), 100, fmt)).toBe("☑ due T50");
  });

  test("a plain saved item gets a dot, not a checkbox", () => {
    expect(todoStatus(item({ todoState: "saved" }), 100, fmt)).toBe("· no due date");
    expect(isDone(item())).toBe(false);
    expect(isDone(item({ completed: 1 }))).toBe(true);
  });
});

describe("messagePermalink", () => {
  test("builds the archive link, with or without a trailing slash", () => {
    expect(messagePermalink("https://acme.slack.com/", "C00000001", "1700000000.000100"))
      .toBe("https://acme.slack.com/archives/C00000001/p1700000000000100");
    expect(messagePermalink("https://acme.slack.com", "D00000001", "1700000000.000100"))
      .toBe("https://acme.slack.com/archives/D00000001/p1700000000000100");
  });
});
