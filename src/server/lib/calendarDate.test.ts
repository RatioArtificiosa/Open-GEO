import { describe, expect, it } from "vitest";
import { dayKey, monthKey, parseCalendarDate } from "./calendarDate";

/**
 * Strict calendar dates: shape checks accept February 31st, and a billed
 * vendor rejection for a date that never existed is the most avoidable
 * charge in the product. Every rejection shape below is pinned.
 */
describe("parseCalendarDate", () => {
  it("parses a real date", () => {
    expect(parseCalendarDate("2026-10-16")).toEqual({
      year: 2026,
      month: 10,
      day: 16,
    });
  });

  it("refuses impossible dates", () => {
    expect(parseCalendarDate("2026-02-31")).toBeNull();
    expect(parseCalendarDate("2026-13-01")).toBeNull();
    expect(parseCalendarDate("2026-00-10")).toBeNull();
    expect(parseCalendarDate("2026-04-31")).toBeNull();
    expect(parseCalendarDate("not-a-date")).toBeNull();
    expect(parseCalendarDate("2026-10-16T00:00:00")).toBeNull();
  });

  it("knows leap Februaries", () => {
    expect(parseCalendarDate("2024-02-29")).not.toBeNull();
    expect(parseCalendarDate("2026-02-29")).toBeNull();
    expect(parseCalendarDate("2000-02-29")).not.toBeNull();
    expect(parseCalendarDate("1900-02-29")).toBeNull();
  });

  it("orders days for period checks", () => {
    expect(
      dayKey(parseCalendarDate("2026-10-16") ?? { year: 0, month: 0, day: 0 }),
    ).toBe(
      dayKey(parseCalendarDate("2026-10-16") ?? { year: 0, month: 0, day: 0 }),
    );
    expect(
      dayKey(parseCalendarDate("2026-10-16") ?? { year: 0, month: 0, day: 0 }),
    ).toBeGreaterThan(
      dayKey(parseCalendarDate("2026-10-09") ?? { year: 0, month: 0, day: 0 }),
    );
  });

  it("orders months for span arithmetic", () => {
    const jan = parseCalendarDate("2026-01-15");
    const mar = parseCalendarDate("2026-03-02");
    expect(jan).not.toBeNull();
    expect(mar).not.toBeNull();
    expect(monthKey(mar ?? { year: 0, month: 0, day: 0 })).toBeGreaterThan(
      monthKey(jan ?? { year: 0, month: 0, day: 0 }),
    );
  });
});
