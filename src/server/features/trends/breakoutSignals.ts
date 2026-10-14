import { TREND_SCALE_CAVEAT } from "@/server/features/trends/trendSeries";

/**
 * The Breakout Detector: which of these terms is actually breaking out.
 *
 * ## The problem
 *
 * A Trends chart has spikes in it. Most are one week of a documentary airing,
 * and the product that names every one a breakout is the product nobody
 * believes by the third time. A breakout has a shape: **a steep approach and a
 * sustained level** — the series climbs fast, peaks, and stays up. A blip
 * spikes and is gone inside two steps. Telling the two apart is pure maths over
 * the series the merged endpoint already returns, which is why this module
 * needs no vendor call and no schema of its own.
 *
 * ## The three signals, and why each is not enough alone
 *
 * 1. **Year-over-year change** — the recent quarter against the same quarter a
 *    year earlier. It answers "is this bigger than last year", which is the
 *    question a reader actually asks, and it needs a year of history to answer
 *    it. From a 90-day window there is no YoY figure, and the module says that
 *    rather than reporting a shorter comparison under the same name.
 * 2. **Climb rate into the peak** — the least-squares slope over the quarter of
 *    the window *preceding* the peak, in points per step. A breakout is steep
 *    on approach; a slow drift acquires a peak without ever climbing.
 * 3. **Persistence after the peak** — how many steps the series holds above its
 *    pre-peak level, or `null` when it still stands above that baseline at the window's end
 *    (which is a *stronger* result than a number, not a missing one). A spike
 *    that returns in two steps is an event; one that holds is a change.
 *
 * ## The two signals this module deliberately does not compute
 *
 * The plan's list includes regional peak offsets and related-query deltas, and
 * **neither is computable from what the merged endpoint returns**:
 *
 * - A subregion answer is a **whole-period share** per location — one number
 *   per place, not a series per place — so there is no per-region peak to be
 *   offset. Per-region history would need one request per region per window.
 * - The related-queries list is a **current snapshot** (top and rising), not a
 *   series, so there is no "before" to delta an "after" against.
 *
 * Both are named here rather than faked: a detector that invented those numbers
 * would fail in a way nobody could trace, which is the failure this module
 * exists to prevent.
 *
 * ## What a missing point means
 *
 * A `null` is a point the vendor did not measure, and it stays out of every
 * mean, every slope, and the persistence count. Zero is not a substitute — it
 * is the vendor's "no data", and imputing it would turn an outage into a
 * collapse and then into a verdict.
 */

/** A series point as the graph reader emits it, or as a caller supplies it. */
export type BreakoutPoint = {
  /** ISO date, or any ordered label. */
  date: string;
  /** The measured value, or null when the vendor did not measure the point. */
  value: number | null;
};

/** One term's breakout reading. */
export type BreakoutSignal = {
  keyword: string;
  pointsMeasured: number;
  /**
   * The recent quarter's mean above the same quarter a year earlier, as a
   * percentage. Null when the window is shorter than a year plus a quarter —
   * a shorter comparison reported under the same name would be a different
   * claim wearing the same label.
   */
  yoyChangePercent: number | null;
  /**
   * The climb rate into the peak, in points per step. Null when fewer than
   * four measured points precede the peak, which cannot support a slope.
   */
  climbRatePerStep: number | null;
  /**
   * Steps the series holds above its pre-peak level after the peak. Null when
   * it still stands above that baseline at the window's end, or when it never fell back after
   * a measurement gap; the summary distinguishes the two.
   */
  persistenceSteps: number | null;
  /** True when the series still stands above its pre-peak baseline. */
  stillAboveBaseline: boolean;
  /** The date of the window's highest measured point, when the caller supplied dates. */
  peakDate: string | null;
  /** The candidate verdict: a steep approach and a level that lasted. */
  isBreakoutCandidate: boolean;
  /** The sentence a reader sees. */
  summary: string;
  /** The caveat that must travel with the numbers. */
  caveat: string;
};

/**
 * The climb rate a candidate requires, in points per step.
 *
 * On the vendor's 0-100 scale a rate of two points per step over a twelve-week
 * approach is a doubling of the series' own level inside a quarter — visible on
 * a chart, and uncommon enough to be worth a name. A slower drift is real and
 * is reported, but it is not called a breakout.
 */
const STEEP_CLIMB_PER_STEP = 2;

/** The quarter of the window read as "recent", and the same length again as "a year". */
const QUARTER = 13;
const YEAR = 52;

/** The pre-peak level a series must hold above, as the pre-peak quarter's mean. */
function prePeakLevel(
  values: Array<number | null>,
  peakIndex: number,
): number | null {
  return meanOf(values.slice(Math.max(0, peakIndex - QUARTER), peakIndex));
}

/**
 * Read the breakout signals for one series.
 *
 * `points` is oldest-first with `value: null` for an unmeasured point and a
 * `date` the answer can name the peak by. Pure: no network, no database, no
 * clock — the window is whatever the caller passes, so the same series always
 * produces the same verdict.
 */
export function breakoutSignals(
  keyword: string,
  points: BreakoutPoint[],
): BreakoutSignal {
  const values = points.map((point) => point.value);
  const measured = values.filter(
    (value): value is number => typeof value === "number",
  );

  if (measured.length === 0) {
    return {
      keyword,
      pointsMeasured: 0,
      yoyChangePercent: null,
      climbRatePerStep: null,
      persistenceSteps: null,
      stillAboveBaseline: false,
      peakDate: null,
      isBreakoutCandidate: false,
      summary: `No measured points for "${keyword}" in this window, so there is no breakout to report. This is not a flat result.`,
      caveat: TREND_SCALE_CAVEAT,
    };
  }

  // The peak is the highest measured point, earliest on a tie: a series with
  // two points at the same maximum has one peak for reading purposes, and the
  // first is the one the climb leads into.
  const peakIndex = firstIndexOfMax(values);
  const peakDate = points[peakIndex]?.date ?? null;
  const baseline = prePeakLevel(values, peakIndex);
  const climbRate = climbRateInto(values, peakIndex);

  const yoy = yearOverYearChange(values);
  const persistence = persistenceAfter(values, peakIndex, baseline);
  const stillAboveBaseline =
    persistence === null &&
    baseline !== null &&
    isAboveBaseline(values, peakIndex, baseline);

  // **The verdict needs both halves of the shape.** A steep approach without a
  // sustained level is a blip, and a plateau acquired by drift is
  // a level, not a breakout. The threshold is a rate, not a ratio, because the
  // vendor's scale is 0-100 within one request and a ratio would move with the
  // series' own height.
  const isBreakoutCandidate =
    climbRate !== null &&
    climbRate >= STEEP_CLIMB_PER_STEP &&
    stillAboveBaseline &&
    (persistence === null || persistence >= QUARTER);

  return {
    keyword,
    pointsMeasured: measured.length,
    yoyChangePercent: yoy,
    climbRatePerStep: climbRate,
    persistenceSteps: persistence,
    stillAboveBaseline,
    peakDate,
    isBreakoutCandidate,
    summary: describe(keyword, {
      yoy,
      climbRate,
      persistence,
      stillAboveBaseline,
      peakDate,
      isBreakoutCandidate,
    }),
    caveat: TREND_SCALE_CAVEAT,
  };
}

function describe(
  keyword: string,
  input: {
    yoy: number | null;
    climbRate: number | null;
    persistence: number | null;
    stillAboveBaseline: boolean;
    peakDate: string | null;
    isBreakoutCandidate: boolean;
  },
): string {
  const {
    yoy,
    climbRate,
    persistence,
    stillAboveBaseline,
    peakDate,
    isBreakoutCandidate,
  } = input;
  const parts: string[] = [];
  if (isBreakoutCandidate) {
    parts.push(
      `"${keyword}" is a breakout candidate: it climbed into its peak and holds above its earlier level.`,
    );
  } else {
    parts.push(`"${keyword}" shows no breakout shape in this window.`);
  }
  if (climbRate !== null) {
    parts.push(
      `It climbed at ${climbRate.toFixed(2)} points per step into its peak${peakDate ? ` on ${peakDate}` : ""}.`,
    );
  }
  if (stillAboveBaseline) {
    parts.push("It still stands above its earlier level at the window's end.");
  } else if (persistence !== null) {
    parts.push(
      `It held that level for ${persistence} step${persistence === 1 ? "" : "s"} after the peak.`,
    );
  }
  if (yoy === null) {
    parts.push(
      `The window is shorter than a year plus a quarter, so there is no year-over-year figure — a shorter comparison would be a different claim wearing the same name.`,
    );
  } else {
    parts.push(
      `Year over year it runs ${yoy > 0 ? "+" : ""}${yoy.toFixed(0)}%.`,
    );
  }
  return parts.join(" ");
}

/** The first index holding the maximum measured value, or -1 for an empty series. */
function firstIndexOfMax(values: Array<number | null>): number {
  let best = -1;
  let bestValue = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value !== "number") continue;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/** The mean of the measured values in a slice, or null when none was measured. */
function meanOf(values: Array<number | null>): number | null {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (typeof value !== "number") continue;
    total += value;
    count += 1;
  }
  return count === 0 ? null : total / count;
}

/**
 * The slope over the quarter of the window preceding the peak, in points per
 * step. Null when fewer than two measured points precede the peak — a slope
 * needs a line, and a peak at step 0 has no approach to measure.
 */
function climbRateInto(
  values: Array<number | null>,
  peakIndex: number,
): number | null {
  const approach = values.slice(
    Math.max(0, peakIndex - QUARTER),
    Math.max(0, peakIndex),
  );
  const measured = approach.filter(
    (value): value is number => typeof value === "number",
  );
  if (measured.length < 2) return null;
  return slopePerStep(approach);
}

/**
 * Steps the series holds above its pre-peak baseline, **counting the peak
 * itself**.
 *
 * The count ends at the first measured point back at or below the baseline —
 * the conservative reading: a value we can defend as "held for N steps" is
 * worth more than a flattering N that survived a wobble, and the summary
 * reports the number rather than a verdict built on it. Null when the series
 * never falls back, which the caller reads as persistence, or when the baseline
 * is unknown.
 */
function persistenceAfter(
  values: Array<number | null>,
  peakIndex: number,
  baseline: number | null,
): number | null {
  if (baseline === null) return null;
  let steps = 0;
  for (let i = peakIndex; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value !== "number") continue;
    if (value <= baseline) return steps;
    steps += 1;
  }
  return null;
}

/** True when the last measured point still stands above the pre-peak baseline. */
function isAboveBaseline(
  values: Array<number | null>,
  peakIndex: number,
  baseline: number | null,
): boolean {
  if (baseline === null) return false;
  for (let i = values.length - 1; i > peakIndex; i -= 1) {
    const value = values[i];
    if (typeof value !== "number") continue;
    return value > baseline;
  }
  return false;
}

/**
 * The recent quarter's mean against the same quarter a year earlier.
 *
 * Null from a window shorter than a year plus a quarter: "up 40% on last
 * quarter" and "up 40% year over year" are different claims, and the short
 * window answers the first. The two quarters must both hold a measured point —
 * a baseline of nothing has no percentage.
 */
function yearOverYearChange(values: Array<number | null>): number | null {
  if (values.length < YEAR + QUARTER) return null;
  const recent = meanOf(values.slice(values.length - QUARTER));
  const yearAgo = meanOf(
    values.slice(values.length - YEAR - QUARTER, values.length - YEAR),
  );
  if (recent === null || yearAgo === null || yearAgo === 0) return null;
  return ((recent - yearAgo) / yearAgo) * 100;
}

/**
 * Least-squares slope over the measured points, in points per step.
 *
 * Nulls are skipped rather than zeroed — the same rule the traffic forecast and
 * the category momentum module follow, for the same reason.
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
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}
