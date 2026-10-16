/**
 * Strict calendar dates (`yyyy-mm-dd`), shared by every validator that takes
 * one from a caller.
 *
 * A shape check (`/^\d{4}-\d{2}-\d{2}$/`) accepts `2026-02-31` and lets a
 * reversed range reach the vendor, where a rejection can arrive as a billed
 * task the envelope reader reports as an internal error. So this module
 * checks the calendar: month 1–12, day valid for the month including leap
 * Februaries, and callers compare the parsed values for ordering. Pure over
 * strings — no clock, no locale.
 */

export type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * Parse a strict calendar date, or null when the value is not one.
 *
 * Null covers every failure shape — wrong format, month 13, February 31st —
 * because the caller's message names what it received, and one null keeps
 * that message in one place rather than in every validator.
 */
export function parseCalendarDate(value: string): CalendarDate | null {
  const match = SHAPE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Month key for span arithmetic: later dates sort after earlier ones. */
export function monthKey(date: CalendarDate): number {
  return date.year * 12 + date.month;
}

/**
 * Day key for ordering dates: later dates sort after earlier ones.
 * `yyyymmdd` as a number preserves chronology without a clock.
 */
export function dayKey(date: CalendarDate): number {
  return date.year * 10000 + date.month * 100 + date.day;
}
