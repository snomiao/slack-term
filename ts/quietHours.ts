/** Quiet hours in the recipients' timezone: sending here makes a human's phone
 *  buzz while they're asleep. Default JST because this workspace is in Japan;
 *  override with SLACK_QUIET_TZ / SLACK_QUIET_START / SLACK_QUIET_END.
 *
 *  WHY this lives in the confirm gate rather than in a doc: an agent driving
 *  this CLI has no reason to look at a clock — the moment work finishes IS the
 *  moment it sends, and in a long session it doesn't notice the date rolled
 *  over. A rule that must be remembered gets forgotten; a line printed on the
 *  path every send already takes does not. (Real incident 2026-08-26: messages
 *  sent to an external partner at 00:44 and 01:12 JST.)
 *
 *  Deliberately a WARNING, not a block: pager-duty style P1 outage notices
 *  legitimately go out at 3am, and this CLI cannot tell those apart. Blocking
 *  would train people to bypass the gate entirely. */
export function quietHoursNotice(now: Date = new Date()): string | null {
  const tz = process.env.SLACK_QUIET_TZ ?? "Asia/Tokyo";
  const start = Number(process.env.SLACK_QUIET_START ?? 23); // inclusive
  const end = Number(process.env.SLACK_QUIET_END ?? 8); // exclusive
  let hour: number;
  let stamp: string;
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    stamp = fmt.format(now);
    hour = Number(
      fmt.formatToParts(now).find((p) => p.type === "hour")?.value ?? "12",
    );
  } catch {
    return null; // bad TZ override — never let the clock break sending
  }
  const quiet = start > end ? hour >= start || hour < end : hour >= start && hour < end;
  const label = `🕐 ${stamp} (${tz})`;
  if (!quiet) return label;
  return `${label}\n⚠ QUIET HOURS (${start}:00-${end}:00) — this will buzz a phone. Send only for a production incident; otherwise hold it until morning.`;
}
