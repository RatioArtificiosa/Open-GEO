import { sortBy } from "remeda";
import { at } from "@/shared/index-reads";
import { monthSpanSpansCutover } from "@/shared/etv-versioning";
/**
 * Movement between the two months a category-metrics call asked about.
 *
 * ## Why this is computed here rather than read from `metrics_difference`
 *
 * The vendor returns a difference block, and its documentation does not pin the sign: *"calculated
 * by subtracting domain metrics as of the greater date from domain metrics as of the smaller date"*
 * leaves "greater" ambiguous between *later in time* and *larger in value*. Its own sample does not
 * settle it — an ETV rising 147.22 → 308.87 carries `+161.65` (later minus earlier), while a `pos_1`
 * that is 4 in both months carries `+1`.
 *
 * A growth figure with an uncertain sign is worse than no growth figure, and the two months are
 * unambiguous in `metrics_history`, so the direction is computed from those. `metrics_difference`
 * is not read anywhere in this product.
 *
 * Pure, and separate from the client on purpose: importing the client reaches `cloudflare:workers`
 * through the schema barrel, and this logic should be testable without any of that.
 */

type MetricsMonthBlock = {
  etv?: number | null;
  count?: number | null;
  pos_1?: number | null;
  pos_2_3?: number | null;
  pos_4_10?: number | null;
  [key: string]: unknown;
};

type MetricsMonth = {
  organic?: MetricsMonthBlock | null;
  [key: string]: unknown;
} | null;

type MetricsMovement = {
  /** The earlier of the two months, whichever order the caller asked in. */
  fromMonth: string;
  toMonth: string;
  fromEtv: number | null;
  toEtv: number | null;
  /** `toEtv - fromEtv`, or null when either month's ETV is missing. */
  etvChange: number | null;
  /**
   * Whether the two months straddle 2026-11-01, the day the vendor switches ETV models.
   *
   * **When this is true, `etvChange` is not a change in traffic** -- it is the difference
   * between two formulas, and it is non-zero even for a site whose rankings did not move.
   * The endpoint takes two *caller-supplied* dates, so a straddling window is a question a
   * caller can ask, and it must not be answered with an unlabelled number.
   */
  spansCutover: boolean;
  /**
   * Whether the later month has more estimated traffic.
   *
   * Null rather than false when either month is missing, because "no data" and "it fell" are
   * different claims and a table that renders the second for the first invents a decline.
   */
  growing: boolean | null;
};

/** `YYYYMM` keys, oldest first. Anything not matching the pattern is ignored. */
function monthKeys(history: Record<string, MetricsMonth>): string[] {
  // `sortBy` rather than `sort()`: the lib target has no `toSorted`, and the repository
  // bans in-place sorts outright.
  return sortBy(
    Object.keys(history).filter((key) => /^\d{6}$/.test(key)),
    (key) => key,
  );
}

function organicEtv(month: MetricsMonth | undefined): number | null {
  return month?.organic?.etv ?? null;
}

/**
 * Describe how one domain moved between the two months in its history.
 *
 * Returns null when the item does not carry exactly two months, because a movement with one point
 * is not a movement, and this product will not print a change it cannot source to two readings.
 */
export function describeMetricsMovement(
  history: Record<string, MetricsMonth> | null | undefined,
): MetricsMovement | null {
  if (history == null) return null;
  const keys = monthKeys(history);
  if (keys.length !== 2) return null;

  // **`at()` rather than destructuring or a `!`.** `keys.length !== 2` returns
  // first, so both months are provably present — and the failure mode if they
  // were not is the one this function exists to prevent: `undefined` used as an
  // index into `history` reads `undefined`, `organicEtv(null)` returns null, and
  // the movement would be reported as a null change instead of as an absent one.
  // A movement with one point is not a movement; one with an unread month is not
  // a movement either, and this is the place where those two collapse without
  // the narrowing.
  const fromMonth = at(keys, 0, "a two-month metrics history");
  const toMonth = at(keys, 1, "a two-month metrics history");
  const fromEtv = organicEtv(history[fromMonth]);
  const toEtv = organicEtv(history[toMonth]);
  const etvChange = fromEtv !== null && toEtv !== null ? toEtv - fromEtv : null;
  const spansCutover = monthSpanSpansCutover(fromMonth, toMonth);

  return {
    fromMonth,
    toMonth,
    fromEtv,
    toEtv,
    etvChange,
    spansCutover,
    // **A straddling movement carries no direction.** Two formulas apart, "grew" and
    // "fell" are both claims about the formula rather than about the site — so the
    // null that already means "not measurable" is also the right answer here, and a
    // consumer cannot accidentally report a growth the boundary explains.
    growing: spansCutover ? null : etvChange === null ? null : etvChange > 0,
  };
}
