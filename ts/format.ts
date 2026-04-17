// Text-formatting helpers: mention/date-markup resolution, day grouping.

import { userName } from "./slack.ts";

export async function resolveMentions(
  token: string,
  text: string,
  cache: Map<string, string>,
): Promise<string> {
  let result = text;
  const ids: string[] = [];
  let search = result;
  let searchOffset = 0;
  while (true) {
    const pos = search.indexOf("<@U", searchOffset);
    if (pos === -1) break;
    const rest = search.slice(pos + 2);
    const endIdx = rest.search(/[>|]/);
    const uid = endIdx === -1 ? rest : rest.slice(0, endIdx);
    if (uid.length >= 9) ids.push(uid);
    searchOffset = pos + 1;
  }
  for (const uid of ids) {
    if (!cache.has(uid)) cache.set(uid, await userName(token, uid));
    const display = cache.get(uid) ?? uid;
    result = result.replaceAll(`<@${uid}>`, `@${display}`);
    // Handle <@UID|label> form — drop label.
    result = result.replace(new RegExp(`<@${uid}\\|[^>]*>`, "g"), `@${display}`);
  }
  return result;
}

export function resolveDateMarkup(text: string): string {
  // <!date^EPOCH^{format}|fallback>  →  formatted date (or fallback)
  return text.replace(/<!date\^(\d+)\^[^|>]*(?:\|([^>]*))?>/g, (_m, epochStr, fallback) => {
    const epoch = Number(epochStr);
    if (!Number.isFinite(epoch)) return fallback ?? "date";
    const d = new Date(epoch * 1000);
    if (Number.isNaN(d.getTime())) return fallback ?? "date";
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayName = days[d.getUTCDay()] ?? "";
    const mon = months[d.getUTCMonth()] ?? "";
    return `${dayName}, ${mon} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()}`;
  });
}

export function dayLabel(epochSec: number, now: Date = new Date()): string {
  const d = new Date(epochSec * 1000);
  const today = dateKey(now);
  const yesterday = dateKey(new Date(now.getTime() - 86400_000));
  const key = dateKey(d);
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const month = d.toLocaleDateString("en-US", { month: "short" });
  return `${weekday}, ${month} ${String(d.getDate()).padStart(2, "0")}`;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatHm(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatYmdHm(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi}`;
}
