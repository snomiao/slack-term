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
 *  WHOSE clock: the recipient's, when we can learn it — "is it the middle of
 *  the night" is a fact about the person whose phone buzzes, not about the
 *  sender. `recipientTz` carries that when the caller could resolve it.
 *
 *  When it is UNKNOWN we still judge, using the sender's zone, and say plainly
 *  that we did. That is the whole design decision here, and the tempting
 *  alternatives are both worse:
 *
 *    - Silently falling back to the default zone LOOKS clean and reads as if
 *      we knew the recipient's time. It lies.
 *    - Declining to judge at all is honest, but it hands the decision back to
 *      an agent that has no reason to look at a clock — which is the exact
 *      failure this exists to prevent. Measured against the real incident,
 *      that option is the ONLY one of the three that stays silent at 00:44.
 *
 *  So: warn, and label the basis. Unknown is not the rare case — Slack Connect
 *  counterparts have no `tz` field at all (measured 2026-08-26 on every
 *  external user in this workspace, including the person the 00:44 message
 *  actually went to). Falling silent there would reinstate the incident.
 *
 *  Deliberately a WARNING, not a block: pager-duty style P1 outage notices
 *  legitimately go out at 3am, and this CLI cannot tell those apart. Blocking
 *  would train people to bypass the gate entirely. */
export function quietHoursNotice(now: Date = new Date(), recipientTz?: string | null): string | null {
  const fallbackTz = process.env.SLACK_QUIET_TZ ?? "Asia/Tokyo";
  // An unusable recipient zone is treated as unknown, not as a reason to fail:
  // the sender's zone still gives a defensible answer, and the label says so.
  const known = !!recipientTz && isUsableTz(recipientTz);
  const tz = known ? recipientTz! : fallbackTz;
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
  // Name the basis, always. A reader who cannot tell whose clock this is cannot
  // judge how much to trust it.
  const basis = known ? `${tz}, recipient` : `${tz}, sender — recipient's timezone unknown`;
  const label = `🕐 ${stamp} (${basis})`;
  if (!quiet) return label;
  const caveat = known ? "" : " Their local time may differ.";
  return `${label}\n⚠ QUIET HOURS (${start}:00-${end}:00) — this will buzz a phone.${caveat} Send only for a production incident; otherwise hold it until morning.`;
}

/** Does Intl accept this zone? A bad value must degrade to "unknown", never throw. */
function isUsableTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
