// Slack Lists write helpers — pure functions that turn CLI arguments into the
// public slackLists.* API's schema / cell shapes. No I/O here; the calls live
// in ts/slack.ts and the gated commands in ts/cli.ts.

import type { Json } from "./slack.ts";

/** Column types `--col` accepts. A subset of what slackLists.create takes —
 *  the ones a cell value can be written for from a plain CLI string. */
export const LIST_COLUMN_TYPES = ["text", "select", "user", "link", "date", "number", "checkbox"] as const;
export type ListColumnType = (typeof LIST_COLUMN_TYPES)[number];

export type ListColumnSpec = { name: string; type: ListColumnType; choices?: string[] };

/** Parse a `--col` spec: `name:type` or `name:select:opt1,opt2,…`. The name
 *  may itself contain `/` (e.g. `媒体/項目`); only `:` separates. */
export function parseColumnSpec(spec: string): ListColumnSpec {
  const parts = spec.split(":");
  const name = (parts[0] ?? "").trim();
  const type = (parts[1] ?? "text").trim() as ListColumnType;
  if (!name) throw new Error(`--col needs a name: ${spec}`);
  if (!LIST_COLUMN_TYPES.includes(type)) {
    throw new Error(`--col ${spec}: unknown type "${type}" (expected one of ${LIST_COLUMN_TYPES.join(", ")})`);
  }
  if (type === "select") {
    const choices = (parts.slice(2).join(":") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!choices.length) throw new Error(`--col ${spec}: a select column needs choices, e.g. ${name}:select:todo,doing,done`);
    return { name, type, choices };
  }
  if (parts.length > 2) throw new Error(`--col ${spec}: only select columns take a third part`);
  return { name, type };
}

const SELECT_COLORS = ["gray", "blue", "green", "yellow", "red", "purple", "orange", "pink", "cyan", "indigo", "brown"];

/** Build the slackLists.create `schema`. Keys are generated (`col1`…) because
 *  Slack wants an identifier-ish key while the display name can be anything
 *  (Japanese, slashes). The first column must be text — Slack requires exactly
 *  one primary column and it must be a text column. */
export function buildListSchema(cols: ListColumnSpec[]): Json[] {
  if (!cols.length) throw new Error("at least one --col is required (the first one is the primary text column)");
  if (cols[0]!.type !== "text") throw new Error(`the first --col is the primary column and must be text, got ${cols[0]!.type}`);
  return cols.map((c, i) => {
    const col: Record<string, Json> = { key: `col${i + 1}`, name: c.name, type: c.type };
    if (i === 0) col.is_primary_column = true;
    if (c.type === "select") {
      col.options = {
        format: "single_select",
        choices: c.choices!.map((v, j) => ({ value: v, label: v, color: SELECT_COLORS[j % SELECT_COLORS.length]! })),
      };
    }
    if (c.type === "user") col.options = { format: "single_entity" };
    return col;
  });
}

/** A column as read back from the list's schema (slackLists.items.list include_list). */
export type ListColumn = { id: string; key: string; name: string; type: string; choices: { value: string; label: string }[] };

export function parseListSchema(list: Record<string, Json>): ListColumn[] {
  const meta = (list.list_metadata ?? list.metadata ?? {}) as Record<string, Json>;
  const schema = (meta.schema ?? list.schema ?? []) as Json[];
  return schema.map((c) => {
    const r = (c ?? {}) as Record<string, Json>;
    const opts = (r.options ?? {}) as Record<string, Json>;
    const choices = ((opts.choices ?? []) as Json[]).map((x) => {
      const ch = (x ?? {}) as Record<string, Json>;
      return { value: String(ch.value ?? ""), label: String(ch.label ?? ch.value ?? "") };
    });
    return { id: String(r.id ?? ""), key: String(r.key ?? ""), name: String(r.name ?? ""), type: String(r.type ?? ""), choices };
  });
}

/** Find a column by display name, key, or column id. */
export function findColumn(cols: ListColumn[], ref: string): ListColumn {
  const hit = cols.find((c) => c.name === ref) ?? cols.find((c) => c.key === ref) ?? cols.find((c) => c.id === ref);
  if (!hit) throw new Error(`no column "${ref}" in this list (columns: ${cols.map((c) => c.name || c.key).join(", ")})`);
  return hit;
}

/** The value part of a cell for one column, from a CLI string. */
export function cellValue(col: ListColumn, raw: string): Record<string, Json> {
  switch (col.type) {
    case "text":
      return { rich_text: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: raw }] }] }] };
    case "select": {
      const choice = col.choices.find((c) => c.value === raw || c.label === raw);
      if (!choice) throw new Error(`"${raw}" is not an option of ${col.name} (options: ${col.choices.map((c) => c.label).join(", ")})`);
      return { select: [choice.value] };
    }
    case "user":
      return { user: [raw] };
    case "link":
      return { link: [{ original_url: raw, display_as_url: true }] };
    case "date":
      return { date: [raw] };
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${col.name}: "${raw}" is not a number`);
      return { number: [n] };
    }
    case "checkbox":
    case "todo_completed":
      if (!["true", "false"].includes(raw)) throw new Error(`${col.name}: expected true or false, got "${raw}"`);
      return { checkbox: raw === "true" };
    default:
      throw new Error(`writing a ${col.type} column (${col.name}) from the CLI is not supported`);
  }
}

/** Parse repeatable `--set name=value` pairs (split on the FIRST `=`). */
export function parseSets(sets: string[]): { col: string; value: string }[] {
  return sets.map((s) => {
    const i = s.indexOf("=");
    if (i <= 0) throw new Error(`--set expects name=value, got: ${s}`);
    return { col: s.slice(0, i), value: s.slice(i + 1) };
  });
}

/** The todo_mode "Completed" column, if the list has one. */
export function completedColumn(cols: ListColumn[]): ListColumn | undefined {
  return cols.find((c) => c.key === "todo_completed" || c.type === "todo_completed");
}
