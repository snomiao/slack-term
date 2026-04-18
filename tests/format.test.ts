import { describe, test, expect } from "vitest";
import { resolveDateMarkup, dayLabel, formatHm, formatYmdHm } from "../ts/format.ts";

describe("resolveDateMarkup", () => {
  test("replaces <!date^...> with formatted date", () => {
    const out = resolveDateMarkup("meeting at <!date^1700000000^{date_pretty}|fallback>");
    expect(out).toMatch(/^meeting at \w+, \w{3} \d{2}, \d{4}$/);
  });

  test("leaves unrelated text untouched", () => {
    expect(resolveDateMarkup("hello world")).toBe("hello world");
  });
});

describe("dayLabel", () => {
  const now = new Date("2026-04-18T12:00:00Z");

  test("returns Today for same day", () => {
    const epoch = now.getTime() / 1000;
    expect(dayLabel(epoch, now)).toBe("Today");
  });

  test("returns Yesterday for prior day", () => {
    const epoch = (now.getTime() - 86400_000) / 1000;
    expect(dayLabel(epoch, now)).toBe("Yesterday");
  });

  test("returns weekday+date for older dates", () => {
    const epoch = (now.getTime() - 5 * 86400_000) / 1000;
    expect(dayLabel(epoch, now)).toMatch(/^\w+, \w{3} \d{2}$/);
  });
});

describe("formatHm / formatYmdHm", () => {
  test("formatHm pads hours and minutes", () => {
    const epoch = new Date("2026-04-18T03:07:00").getTime() / 1000;
    expect(formatHm(epoch)).toBe("03:07");
  });

  test("formatYmdHm returns yyyy-mm-dd HH:MM", () => {
    const epoch = new Date("2026-04-18T03:07:00").getTime() / 1000;
    expect(formatYmdHm(epoch)).toBe("2026-04-18 03:07");
  });
});
