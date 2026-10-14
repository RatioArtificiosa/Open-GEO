import { TREND_SCALE_CAVEAT } from "@/server/features/trends/trendSeries";
import { at } from "@/shared/index-reads";

/**
 * Category momentum: is an industry's interest rising, cooling, or steady?
 *
 * ## What this is for
 *
 * `google_trends/explore` accepts a `category_code` with **no keywords** — the
 * September change — so a whole industry's trend can be read before anyone knows
 * which keywords to track. The product sentence this module exists to make true
 * is *"CRM is cooling; AI-visibility is accelerating"*, and the failure it exists
 * to refuse is a spike reading as a trend.
 *
 * ## Why the level shift is a median ratio
 *
 * A mean is the number a spike fakes. Two enormous points at the end of an
 * otherwise flat window move the recent half's mean far above the earlier one —
 * exactly the shape a mean-based verdict would call a climb — while leaving its
 * median where it was. **The level shift is therefore a median ratio**, and a
 * two-point spike cannot move it. This is the whole reason the module does not
 * simply compare averages, which is the first thing anyone writes.
 *
 * ## Why a level shift is not enough
 *
 * A level that shifted up and is already falling is not acceleration. The
 * verdict therefore needs the recent half's **own** direction as well: a
 * least-squares slope over the recent half's measured points, whose sign must
 * agree with the ratio's. The two are the cheapest honest pair this method has —
 * the level says how far the shift went, the recent slope says which way it is
 * going now — and CL-716's Breakout Detector is where the rest of the noise
 * question is answered.
 *
 * ## What the numbers are allowed to mean
 *
 * Scores inside one request are normalised to that request's own peak
 * ({@link TREND_SCALE_CAVEAT}), so **a category can be compared with its own
 * past and never with another category's level**. Two categories' *momentum* is
 * comparable, because each is measured against its own history; two categories'
 * *scores* are two rulers. The caveat travels with every answer rather than
 * being left to a caller to rediscover.
 *
 * ## What a missing point means
 *
 * A `null` is a point the vendor did not measure, and it stays out of the
 * medians, out of both slopes, and out of the counts. Imputing zero would turn a
 * data outage into a collapse and then call it a direction — the same failure
 * the traffic forecast refuses, for the same reason.
 */

/**
 * The verdict, in the words a reader acts on.
 *
 * Not exported: nothing outside this module needs to name it, and a consumer
 * reaches it as `CategoryMomentum["direction"]` when it does. An export no
 * other file uses is a name that drifts from the thing it names.
 */
type CategoryDirection = "accelerating" | "steady" | "cooling";

/** A category's momentum over one window. */
export type CategoryMomentum = {
  /** Null when the window cannot support a verdict — never guessed. */
  direction: CategoryDirection | null;
  /**
   * The recent half's **median** above the earlier half's, as a percentage: 25
   * means a quarter higher now, -12 means an eighth lower. A median, so a spike
   * cannot move it. Null when either half has no measured point, or when the
   * earlier half's median is zero and the ratio has no denominator.
   */
  changePercent: number | null;
  /** Least-squares slope over the whole window, in score points per step. */
  slopePerStep: number | null;
  /**
   * Least-squares slope over the **recent half only** — the second signal. The
   * verdict is called only when this points the same way as the ratio.
   */
  recentSlopePerStep: number | null;
  /** How many measured points the verdict rests on. */
  pointsMeasured: number;
  /** The sentence a reader sees. Never a bare number. */
  summary: string;
  /** Why there is no direction, when there is none. */
  basis: "measured" | "too-little-history" | "window-not-measured";
  /** The caveat that must travel with the numbers, from the one place it lives. */
  caveat: string;
};

/**
 * The margin a direction requires, as a percentage of the earlier half's median.
 *
 * A fifth. Below it the difference is within the band this method calls flat:
 * weekly interest reports wobble by more than that with no event behind them,
 * and calling every wobble a direction is how a dashboard teaches its readers to
 * ignore it.
 */
const STEEP_PERCENT = 20;

/**
 * The floor on measured points.
 *
 * Six, with at least one measured in each half. A verdict from fewer points is
 * arithmetic performed on noise, and the honest answer then is "we cannot see a
 * direction", which is a different claim from "steady".
 */
const MIN_POINTS_FOR_VERDICT = 6;

/**
 * Read a category's trend from a graph item.
 *
 * A category-only request returns **one series**, and the graph item is keyed by
 * keyword: with no keyword the series is positional — index 0. That reading is
 * the documented capability of that change, and it is **unverified against a live
 * response**, because the account cannot make one (`40104`, every daily rate
 * limit zero). The extraction is therefore small, pure and named: when the live
 * call happens, this is the one function a correction lands in, and nowhere
 * else.
 *
 * The vendor's `0` is "no data" and a flagged point is unmeasured even when it
 * carries a number — both rules are `trendSeries`'s, and are reused here rather
 * than restated so one vendor rule cannot be read two ways.
 */
export function readCategoryTrend(graph: {
  data?: Array<{
    values?: Array<number | null> | null;
    missing_data?: boolean | null;
  }> | null;
}): Array<number | null> {
  return (graph.data ?? []).map((point) => {
    if (point.missing_data === true) return null;
    const raw = point.values?.[0];
    if (raw == null) return null;
    return raw === 0 ? null : raw;
  });
}

/**
 * The momentum verdict for one window.
 *
 * `values` is oldest-first, with `null` for a point the vendor did not measure.
 * Nothing here needs the network or the database, so the whole decision is a
 * test away.
 */
export function categoryMomentum(
  values: Array<number | null>,
): CategoryMomentum {
  const measured = values.filter(
    (value): value is number => typeof value === "number",
  );

  if (measured.length === 0) {
    return {
      direction: null,
      changePercent: null,
      slopePerStep: null,
      recentSlopePerStep: null,
      pointsMeasured: 0,
      summary:
        "No measured points in this window, so there is no direction to report. This is not a flat trend.",
      basis: "window-not-measured",
      caveat: TREND_SCALE_CAVEAT,
    };
  }

  const slope = slopePerStep(values);

  if (values.length < MIN_POINTS_FOR_VERDICT) {
    return {
      direction: null,
      changePercent: null,
      slopePerStep: slope,
      recentSlopePerStep: null,
      pointsMeasured: measured.length,
      summary: `Only ${measured.length} measured point${measured.length === 1 ? "" : "s"} in this window, and ${MIN_POINTS_FOR_VERDICT} are the floor for a direction. This window is too short to call rising, cooling, or flat.`,
      basis: "too-little-history",
      caveat: TREND_SCALE_CAVEAT,
    };
  }

  // The halves are positions in the series, not quantiles of the values: a split
  // at the midpoint of the window is a fact about the window, so two categories
  // with the same window are split the same way and their verdicts are
  // comparable even though their scores never are.
  const half = Math.floor(values.length / 2);
  const earlierMedian = medianOf(values.slice(0, half));
  const recentMedian = medianOf(values.slice(half));

  if (earlierMedian === null || recentMedian === null) {
    return {
      direction: null,
      changePercent: null,
      slopePerStep: slope,
      recentSlopePerStep: null,
      pointsMeasured: measured.length,
      summary:
        "One half of the window has no measured point, so there is nothing to compare the other half against. This is not a flat trend.",
      basis: "window-not-measured",
      caveat: TREND_SCALE_CAVEAT,
    };
  }

  // A zero denominator has no ratio, and inventing one (0 is already mapped to
  // null upstream, so this guards a caller passing raw values) would report a
  // percentage from nothing.
  const changePercent =
    earlierMedian === 0
      ? null
      : ((recentMedian - earlierMedian) / earlierMedian) * 100;

  const recentSlope = slopePerStep(values.slice(half));

  // **Both signals, or neither.** The median ratio says how far the level
  // shifted; the recent half's own slope says which way it is going now. A
  // shifted level that is already falling is "shifted", not "accelerating",
  // and only a second signal can tell the two apart.
  let direction: CategoryDirection = "steady";
  if (changePercent !== null && Math.abs(changePercent) >= STEEP_PERCENT) {
    const rising = changePercent > 0;
    if (rising === recentSlope > 0) {
      direction = rising ? "accelerating" : "cooling";
    }
  }

  return {
    direction,
    changePercent,
    slopePerStep: slope,
    recentSlopePerStep: recentSlope,
    pointsMeasured: measured.length,
    summary: describe(direction, {
      changePercent,
      recentSlope,
      pointsMeasured: measured.length,
    }),
    basis: "measured",
    caveat: TREND_SCALE_CAVEAT,
  };
}

/**
 * The sentence a reader sees.
 *
 * The direction comes first because that is what a reader acts on; the numbers
 * follow it rather than leading, so nobody has to read arithmetic to learn
 * whether an industry is rising.
 */
function describe(
  direction: CategoryDirection,
  input: {
    changePercent: number | null;
    recentSlope: number;
    pointsMeasured: number;
  },
): string {
  const { changePercent, recentSlope, pointsMeasured } = input;
  const basis = `measured on ${pointsMeasured} point${pointsMeasured === 1 ? "" : "s"}`;
  if (changePercent === null) {
    return `Steady over this window (${basis}), with no comparable earlier half to measure against.`;
  }
  const rounded = Math.round(changePercent);
  const relative = `${rounded > 0 ? "+" : ""}${rounded}%`;
  const lead =
    direction === "steady"
      ? "Steady"
      : direction === "accelerating"
        ? "Accelerating"
        : "Cooling";
  const tail =
    direction === "steady" ? " — within the band this method calls flat" : "";
  return `${lead}: the recent half of the window runs ${relative} against the earlier half (${basis}, recent slope ${formatSlope(recentSlope)})${tail}.`;
}

function formatSlope(slope: number): string {
  const rounded = Math.round(slope * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${rounded} points per step`;
}

/** The median of the measured values in a slice, or null when none was measured. */
function medianOf(values: Array<number | null>): number | null {
  // **`toSorted`, not `sort`.** This repo bans `Array#sort()` (it mutates), and
  // the median must not disturb the caller's series — the slope is computed from
  // the same array and a sorted version would report a different trend.
  // **Filtered into a local, then sorted in place.** The repo's `lib` is ES2022
  // so there is no `toSorted` to reach for, and `unicorn/no-array-sort` fires on
  // a `.sort()` whose receiver is a fresh expression — which is why the filter
  // lands in a named local first, exactly as `serp-location-search` sorts its
  // own built array. `values` itself is never touched: the slope below reads the
  // caller's series in its original order.
  const measured: number[] = [];
  for (const value of values) {
    if (typeof value === "number") measured.push(value);
  }
  measured.sort((a, b) => a - b);
  if (measured.length === 0) return null;
  // An even count averages the two middle values, the standard reading; the
  // alternative (taking the lower) is a different estimator, and either is fine
  // as long as it is the same one for every category compared.
  //
  // The middles are read through `at` rather than a bare index with an
  // `as number`: the repo bans that cast, and `at` fails loudly with the index
  // and the length instead of coercing a missing value into `NaN`.
  if (measured.length % 2 === 1) {
    return at(
      measured,
      Math.floor(measured.length / 2),
      "the median of an odd slice",
    );
  }
  const middle = Math.floor(measured.length / 2);
  const lower = at(measured, middle - 1, "the lower middle of an even slice");
  const upper = at(measured, middle, "the upper middle of an even slice");
  return (lower + upper) / 2;
}

/**
 * Least-squares slope over the measured points, in score points per step.
 *
 * Nulls are skipped rather than zeroed — a point the vendor did not measure is
 * not a point at the floor, and the fit that included it would report the
 * outage as the trend.
 */
function slopePerStep(values: Array<number | null>): number {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < values.length; i += 1) {
    const y = values[i];
    if (typeof y !== "number") continue;
    points.push({ x: i, y });
  }
  if (points.length < 2) return 0;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const denominator = n * sumXX - sumX * sumX;
  // Every measured point at the same position (a one-step series): no slope is
  // determinable, and 0 is the honest reading of "we cannot see a direction".
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}
