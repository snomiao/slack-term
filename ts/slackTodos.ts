// Slack's To-dos tab (app.slack.com/client/<team>/to-dos) — read-only helpers.
//
// Not to be confused with `slack todo` (todo.ts), which tracks tasks as
// reactions on messages. To-dos are Slack's own PERSONAL list: it replaced
// "Later" in Oct 2026, and there is no public API for it. The desktop client
// reads it through the internal `saved.list` (xoxc session token + d cookie),
// which is what `slack todos` calls — so it is per-user, and bot tokens cannot
// see it at all.
//
// A saved item points at a message: `item_id` is the channel id, `ts` the
// message ts. `todo_state` is "to_do" for a to-do and "saved" for a plain
// saved item; `state` is "in_progress" until it is checked off. Dates are
// epoch seconds, 0 when unset. The shape is undocumented, so every field is
// read defensively.

import type { Json } from "./slack.ts";

/** `--filter` values `saved.list` accepts (verified against the live API). */
export const TODO_FILTERS = ["todo", "saved", "completed", "archived"] as const;
export type TodoFilter = (typeof TODO_FILTERS)[number];

export type TodoItem = {
  channel: string;
  ts: string;
  /** Epoch seconds; 0 = no due date. */
  due: number;
  /** Epoch seconds; 0 = not completed. */
  completed: number;
  /** "to_do" | "saved" (as Slack reports it). */
  todoState: string;
  state: string;
  archived: boolean;
  itemType: string;
};

const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");
const num = (v: Json | undefined): number => {
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
};

/** The items of one `saved.list` page, normalized. Non-message items are kept
 *  (their `itemType` says what they are) but carry no channel/ts to read. */
export function parseSavedItems(resp: Json): TodoItem[] {
  const r = (resp && typeof resp === "object" && !Array.isArray(resp) ? resp : {}) as Record<string, Json>;
  const items = Array.isArray(r.saved_items) ? r.saved_items : [];
  return items
    .filter((x): x is Record<string, Json> => !!x && typeof x === "object" && !Array.isArray(x))
    .map((x) => ({
      channel: str(x.item_id),
      ts: str(x.ts),
      due: num(x.date_due),
      completed: num(x.date_completed),
      todoState: str(x.todo_state),
      state: str(x.state),
      archived: x.is_archived === true,
      itemType: str(x.item_type),
    }));
}

/** Soonest due first; items without a due date last, newest message first among them. */
export function sortTodos(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    if (a.due && b.due) return a.due - b.due;
    if (a.due !== b.due) return a.due ? -1 : 1;
    return Number(b.ts) - Number(a.ts);
  });
}

export function isDone(t: TodoItem): boolean {
  return t.completed > 0 || t.state === "completed";
}

/** The status column: a checkbox, plus the due date (and OVERDUE when past it). */
export function todoStatus(t: TodoItem, nowSec: number, fmt: (epochSec: number) => string): string {
  const box = isDone(t) ? "☑" : t.todoState === "to_do" ? "☐" : "·";
  if (!t.due) return `${box} no due date`;
  const overdue = !isDone(t) && t.due < nowSec ? "  OVERDUE" : "";
  return `${box} due ${fmt(t.due)}${overdue}`;
}

/** A message permalink built from the workspace URL — no API call per item. */
export function messagePermalink(teamUrl: string, channel: string, ts: string): string {
  return `${teamUrl.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
}
