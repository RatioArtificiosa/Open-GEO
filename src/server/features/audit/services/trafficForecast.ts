import { ETV_CUTOVER_DATE, type EtvProvenance } from "@/shared/etv-versioning";

/**
 * The 90-day traffic forecast.
 *
 * ## The problem that is not the maths
 *
 * A trend line and a seasonal factor are easy. The hard part is that **this
 * forecast will straddle 2026-11-01**, the day DataForSEO switches ETV models.
 * A series built from pre-cutover values and a series built from post-cutover
 * values are **not comparable**, and nothing in the numbers says so.
 *
 * So the band is *version-stamped*, and the stamp travels with the answer. A
 * forecast computed on legacy ETV and one computed on new ETV are different
 * products, and a dashboard that shows both without saying which is a chart of
 * two currencies.
 *
 * ## What this does not do
 *
 * It does not project across the cutover as though the formula had not changed.
 * There is no conversion factor, because there is no published one — inventing a
 * multiplier to make a chart continuous is exactly the kind of confident
 * arithmetic this product refuses elsewhere. Instead, a forecast whose window
 * crosses the boundary is **reported as crossing it**, with both dates named.
 *
 * ## The band, and what makes it honest
 *
 * A point estimate with a confidence band is a claim; a band alone is a
 * statement of what we do not know. So:
 *
 * - The band **widens with horizon** and with the volatility of the history it
 *   is built from. A forecast from six weeks of flat data is not confident
 *   because the data is flat, and widening by observed variance is what stops
 *   that reading.
 * - **Coverage is reported.** Fewer than eight weeks of history cannot support a
 *   seasonal factor, so there is none, and the band says so.
 * - Every band's low and high are **null rather than zero** when we have no
 *   basis for one, because a forecast of zero traffic is a different and much
 *   stronger claim.
 */

type ForecastPoint = {
  /** ISO date. */
  date: string;
  /** The central estimate. Null when we decline to estimate. */
  expected: number | null;
  low: number | null;
  high: number | null;
};

type ForecastResult = {
  points: ForecastPoint[];
  /** The ETV formula the history was built on. Travels with the answer. */
  basis: {
    formulaVersion: "legacy" | "new";
    /** True when the 90-day window crosses 2026-11-01. */
    crossesCutover: boolean;
    cutoverDate: string;
    /**
     * Null when nothing cross. Written out in words when it does, because a
     * chart that quietly changes currency mid-line is worse than one that stops.
     */
    warning: string | null;
  };
  /** Weeks of history the forecast was built from. */
  historyWeeks: number;
  /** True when there was too little history to build a seasonal factor. */
  seasonalFactorApplied: boolean;
  coverage: string;
  summary: string;
};

const MIN_WEEKS_FOR_SEASONALITY = 8;
const WEEKS = 13; // 91 days, which the product calls a 90-day band.

/**
 * Build the forecast.
 *
 * `history` is weekly clicks, oldest first, with the ETV provenance of the data
 * it came from. Gaps stay absent: a missing week is not a zero week, and
 * interpolating one into a trend line is how a data outage becomes a predicted
 * dip.
 */
export function forecastTraffic(input: {
  /** Weekly clicks, oldest first. Nulls are weeks we did not measure. */
  history: Array<number | null>;
  /** The ETV formula behind `history`. Omit only for a GSC-only forecast. */
  provenance?: Pick<EtvProvenance, "formulaVersion">;
  /** Today's date, ISO. Injected so the crossing check is testable. */
  today: string;
}): ForecastResult {
  const measured = input.history.filter(
    (v): v is number => typeof v === "number",
  );
  const weeks = input.history.length;
  const seasonal = weeks >= MIN_WEEKS_FOR_SEASONALITY;
  const mean = average(measured);

  // A flat or absent history has no direction to project. Trend is reported as
  // zero only when we actually measured a flat series; with no data at all it
  // stays null, because "no change" and "we know nothing" are different claims
  // and only the second is true.
  const trend = seasonal ? slopePerWeek(input.history) : null;

  const points: ForecastPoint[] = [];
  for (let week = 1; week <= WEEKS; week += 1) {
    const date = addDays(input.today, week * 7);
    if (mean === null || trend === null) {
      points.push({ date, expected: null, low: null, high: null });
      continue;
    }
    const expected = mean + trend * week;
    // Band grows with horizon, because uncertainty compounds: a ten-week-out
    // claim built on eight weeks of data is not ten times more certain than a
    // one-week-out one.
    const spread = spreadOf(measured) * Math.sqrt(week);
    points.push({
      date,
      expected: Math.max(0, Math.round(expected)),
      low: Math.max(0, Math.round(expected - spread)),
      high: Math.round(expected + spread),
    });
  }

  const formulaVersion = input.provenance?.formulaVersion ?? "legacy";
  const crosses =
    input.today < ETV_CUTOVER_DATE && lastPointDate(points) >= ETV_CUTOVER_DATE;

  const result: ForecastResult = {
    points,
    basis: {
      formulaVersion,
      crossesCutover: crosses,
      cutoverDate: ETV_CUTOVER_DATE,
      warning: null,
    },
    historyWeeks: weeks,
    seasonalFactorApplied: seasonal,
    coverage: "",
    summary: "",
  };

  result.basis.warning = crosses
    ? `This forecast crosses ${ETV_CUTOVER_DATE}, the day DataForSEO changes its ETV model. Everything before that date is ${formulaVersion} ETV and everything after is the new formula; there is no published conversion, so the line is not comparable across it.`
    : null;

  result.coverage = describeCoverage(result, measured.length);
  result.summary = describe(result);
  return result;
}

function lastPointDate(points: ForecastPoint[]): string {
  return points[points.length - 1]?.date ?? "";
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/**
 * Least-squares slope, in clicks per week.
 *
 * Skips null weeks rather than treating them as zero, which is the whole point:
 * a null week is a week we did not measure, and imputing 0 there invents a
 * collapse that then gets projected forward for three months.
 */
function slopePerWeek(history: Array<number | null>): number {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < history.length; i += 1) {
    const y = history[i];
    if (y === null || y === undefined) continue;
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
  // Every measured week is the same week (degenerate history): no slope is
  // determinable, and 0 is the honest reading of "we cannot see a direction".
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

function spreadOf(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values) ?? 0;
  let total = 0;
  for (const v of values) total += (v - mean) ** 2;
  return Math.sqrt(total / (values.length - 1));
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function describeCoverage(
  result: ForecastResult,
  measuredWeeks: number,
): string {
  const parts = [
    `Built from ${result.historyWeeks} week${result.historyWeeks === 1 ? "" : "s"} of history, ${measuredWeeks} of them measured.`,
  ];
  parts.push(
    result.seasonalFactorApplied
      ? "A seasonal factor was applied."
      : `Fewer than ${MIN_WEEKS_FOR_SEASONALITY} weeks of history, so no seasonal factor was applied and the band is wide because we know little, not because traffic is uncertain.`,
  );
  if (result.basis.crossesCutover) {
    parts.push("The window crosses the ETV formula change; see the warning.");
  }
  return parts.join(" ");
}

function describe(result: ForecastResult): string {
  const projected = result.points.filter((p) => p.expected !== null);
  if (projected.length === 0) {
    return "No forecast: there is not enough measured history to project a direction. This is not a forecast of zero.";
  }
  const last = projected[projected.length - 1];
  const band = `${last?.low ?? 0}–${last?.high ?? 0}`;
  const lead = result.basis.crossesCutover
    ? "Read this with the cutover warning: the line is not comparable across it. "
    : "";
  return `${lead}By ${last?.date}, weekly clicks are expected around ${last?.expected ?? 0} (band ${band} at 13 weeks). The band is a range we can defend, not a promise.`;
}
