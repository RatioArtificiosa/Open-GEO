/**
 * Metering estimators' pure core (A4 audit: every estimator prices the
 * billing shape, not the request).
 *
 * The credit gate calls these BEFORE the fetch, so they are total functions:
 * no throws, no clocks, no I/O. Unresolvable inputs fall back to a documented
 * ceiling, never to zero — an estimate that understates admits what the
 * balance cannot cover, while an overquote refuses early (loud, not silent).
 * Callers mirror the request they price; each mirror point is commented at
 * the call site in `client.ts`.
 */
import { dayKey, monthKey, parseCalendarDate } from "@/server/lib/calendarDate";

/**
 * Caller counts clamped to ≥1 item, with a fallback for absent garbage.
 *
 * `Math.floor(NaN)` is NaN and `Math.max(NaN, 1)` stays NaN, so a NaN limit
 * must never reach arithmetic — it takes the fallback, which callers set to
 * the request's own default (the `?? N` the fetcher sends). Positive infinity
 * (an unbounded ask) takes the cap when one is known, because every fetcher
 * clamps to its documented maximum — pricing the fallback instead would
 * quote 100 rows for a request the fetcher expands to 1,000 (re-review P2).
 * Negative infinity floors to 1 through the normal path.
 */
export function countUnits(
  raw: number | undefined,
  fallback: number,
  cap: number = Number.POSITIVE_INFINITY,
): number {
  if (raw === undefined || Number.isNaN(raw)) return fallback;
  if (raw === Number.POSITIVE_INFINITY) {
    return Number.isFinite(cap) ? cap : fallback;
  }
  return Math.min(cap, Math.max(Math.floor(raw), 1));
}

/** Request fee (times the clickstream multiplier when set) plus per-unit units. */
export function requestPlusUnits(
  perRequest: number,
  perUnit: number,
  units: number,
  requestMult = 1,
): number {
  return perRequest * requestMult + perUnit * units;
}

/**
 * Whole days spanned, inclusive, or null when the bounds are not real dates.
 *
 * Strict calendar parse (February 31st is not a day) and reversed ranges
 * read as null — the fetcher validates downstream, and null tells the
 * estimator to take its ceiling rather than price fiction.
 */
export function daysInclusive(dateFrom: string, dateTo: string): number | null {
  const from = parseCalendarDate(dateFrom);
  const to = parseCalendarDate(dateTo);
  if (from === null || to === null || dayKey(to) < dayKey(from)) return null;
  const ms =
    Date.UTC(to.year, to.month - 1, to.day) -
    Date.UTC(from.year, from.month - 1, from.day);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Periods in a phrase-trends window for one date_group.
 *
 * Weeks round up (a 31-day window is five weekly rows, not four — the vendor
 * bills the partial week); months count whole calendar months inclusive.
 * Null propagates: unparseable bounds take the caller's ceiling.
 */
export function trendPeriods(
  dateFrom: string,
  dateTo: string,
  group: "day" | "week" | "month",
): number | null {
  const days = daysInclusive(dateFrom, dateTo);
  if (days === null) return null;
  if (group === "day") return days;
  if (group === "week") return Math.ceil(days / 7);
  const from = parseCalendarDate(dateFrom);
  const to = parseCalendarDate(dateTo);
  if (from === null || to === null) return null;
  return monthKey(to) - monthKey(from) + 1;
}
