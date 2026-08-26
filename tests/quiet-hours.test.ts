// The confirm gate prints a clock, and warns when a send would land in the
// recipients' night. This exists because of a real incident (2026-08-26):
// messages went to an external partner at 00:44 and 01:12 JST.
//
// The failure mode is structural, not careless — an agent driving this CLI has
// no reason to look at a clock, and in a long session it doesn't notice the
// date rolled over. So the check has to sit on the path every send already
// takes. These tests are what stop that line from silently disappearing.
//
// The clock is injectable so we can assert real boundaries instead of whatever
// time the suite happens to run at.

import { describe, test, expect } from "./harness.ts";
import { quietHoursNotice } from "../ts/quietHours.ts";

/** A UTC instant that reads as the given wall-clock hour in Asia/Tokyo (UTC+9, no DST). */
function atJst(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 7, 26, hour - 9, minute));
}

describe("quiet-hours notice", () => {
  test("always prints a clock, even outside quiet hours", () => {
    const out = quietHoursNotice(atJst(12));
    expect(out).toBeTruthy();
    expect(out!.includes("🕐")).toBe(true);
    expect(out!.includes("Asia/Tokyo")).toBe(true);
    // Midday must NOT be flagged — otherwise the warning is noise and gets ignored.
    expect(out!.includes("QUIET HOURS")).toBe(false);
  });

  test("warns at the times the real incident happened (00:44 / 01:12 JST)", () => {
    for (const [h, m] of [
      [0, 44],
      [1, 12],
    ] as const) {
      const out = quietHoursNotice(atJst(h, m));
      expect(out!.includes("QUIET HOURS")).toBe(true);
    }
  });

  test("pins the boundaries: 22:59 quiet-free, 23:00 warns, 07:59 warns, 08:00 clear", () => {
    // The window wraps midnight, which is the easy thing to get backwards.
    expect(quietHoursNotice(atJst(22, 59))!.includes("QUIET HOURS")).toBe(false);
    expect(quietHoursNotice(atJst(23, 0))!.includes("QUIET HOURS")).toBe(true);
    expect(quietHoursNotice(atJst(3, 0))!.includes("QUIET HOURS")).toBe(true);
    expect(quietHoursNotice(atJst(7, 59))!.includes("QUIET HOURS")).toBe(true);
    expect(quietHoursNotice(atJst(8, 0))!.includes("QUIET HOURS")).toBe(false);
  });

  test("a same-day window (no midnight wrap) still works", () => {
    // The env overrides allow start < end, which takes the other branch of the
    // wrap-around test. Nothing else covers it.
    const prevS = process.env.SLACK_QUIET_START;
    const prevE = process.env.SLACK_QUIET_END;
    process.env.SLACK_QUIET_START = "11";
    process.env.SLACK_QUIET_END = "13";
    try {
      expect(quietHoursNotice(atJst(12))!.includes("QUIET HOURS")).toBe(true);
      expect(quietHoursNotice(atJst(14))!.includes("QUIET HOURS")).toBe(false);
      expect(quietHoursNotice(atJst(2))!.includes("QUIET HOURS")).toBe(false);
    } finally {
      if (prevS === undefined) delete process.env.SLACK_QUIET_START; else process.env.SLACK_QUIET_START = prevS;
      if (prevE === undefined) delete process.env.SLACK_QUIET_END; else process.env.SLACK_QUIET_END = prevE;
    }
  });

  test("a bad timezone override never breaks sending", () => {
    // Returning null means the gate prints no clock line — it must never throw,
    // or a typo'd env var would make the CLI unable to send at all.
    const prev = process.env.SLACK_QUIET_TZ;
    process.env.SLACK_QUIET_TZ = "Not/AZone";
    try {
      expect(quietHoursNotice(atJst(12))).toBe(null);
    } finally {
      if (prev === undefined) delete process.env.SLACK_QUIET_TZ;
      else process.env.SLACK_QUIET_TZ = prev;
    }
  });
});
