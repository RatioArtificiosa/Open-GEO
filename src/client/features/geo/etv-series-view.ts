import {
  trendCaveat,
  ETV_CUTOVER_DATE,
  type EtvFormulaVersion,
} from "@/shared/etv-versioning";

/**
 * How an ETV series is allowed to be drawn.
 *
 * Split out of the chart component so it can be tested without a DOM: the repo's
 * vitest config includes `*.test.ts` only, and more importantly these are
 * decisions about what a chart is *allowed to claim*, which deserves tests
 * independent of how it is drawn.
 */

export type EtvPoint = {
  /** ISO date. */
  date: string;
  etv: number | null;
  /** Which model produced `etv`. `null` means we do not know. */
  formulaVersion: EtvFormulaVersion | null;
  /**
   * Which Labs endpoint produced the point, when the caller knows it. Carried
   * through to {@link trendCaveat} so an unstamped value names what produced it
   * instead of apologising in general — "some values" is not something a reader
   * can act on, "`keywords_for_categories`" is.
   */
  endpoint?: string;
};

type EtvSeriesView = {
  /** Points safe to plot: a known value from a known model. */
  points: Array<{
    date: string;
    etv: number;
    formulaVersion: EtvFormulaVersion;
  }>;
  /**
   * Copy the chart MUST show, or null when the series needs no caveat. Not a
   * tooltip hint: a step nobody notices is the failure this exists to prevent.
   */
  caveat: string | null;
  /** Whether to draw the boundary rule. */
  showBoundary: boolean;
  /** True when nothing is plottable, so the chart can explain itself. */
  isEmpty: boolean;
  /**
   * True when the **newest** value in the series predates the vendor's formula
   * change — the chart is showing history with nothing newer behind it.
   *
   * This is the stale-read rule, and it exists for the scenario the deadline
   * makes real: on 2026-11-01 every existing series is in this state, because
   * the newest value any of them holds was captured before the flip. A capture
   * that stops for a month (a paused schedule, a zeroed rate limit — both
   * things this project has) leaves the chart looking current while showing a
   * pre-change number. The flag refuses that reading: what is refused is the
   * *claim of currency*, not the chart itself, because a history chart is still
   * true history.
   */
  predatesFormulaChange: boolean;
  /** The newest date in the series, so a stale claim can name it. */
  newestPointDate: string | null;
};

/**
 * Decide what to plot and what to say.
 *
 * Three exclusions, each of which would otherwise be a lie:
 *
 * 1. A point with `etv: null` is **absent data**, not zero. Plotting it as 0
 *    would claim traffic collapsed.
 * 2. A point with `formulaVersion: null` is **unknown provenance**, and is
 *    dropped rather than attributed. Drawing it would assert a model we do not
 *    know produced it.
 * 3. A single-model series shows no boundary. Warning on every chart trains
 *    people to ignore warnings.
 *
 * Plus the stale-read rule: a series whose newest capture predates the formula
 * change says so, naming the last capture date, because the step that arrives
 * when capturing resumes is the formula and not the traffic.
 */
export function buildEtvSeriesView(data: EtvPoint[]): EtvSeriesView {
  const points = data.flatMap((point) =>
    point.etv !== null && point.formulaVersion !== null
      ? [
          {
            date: point.date,
            etv: point.etv,
            formulaVersion: point.formulaVersion,
          },
        ]
      : [],
  );

  const caveat = trendCaveat(
    data.map((point) => ({
      formulaVersion: point.formulaVersion,
      endpoint: point.endpoint,
    })),
  );

  // ISO `YYYY-MM-DD` sorts lexicographically, so the newest date is the max
  // string — no clock, no timezone, and no second place a date is parsed.
  const newestPointDate = data.reduce<string | null>(
    (newest, point) =>
      newest === null || point.date > newest ? point.date : newest,
    null,
  );
  // **The newest capture, not the newest plottable one.** The staleness claim is
  // about when we last *saw* data, which an unplottable point also knows; using
  // only plottable points would let an unreadable value hide how old the series
  // is, which is the opposite of the rule's purpose. An empty series claims
  // nothing — there is no capture to be stale.
  const predatesFormulaChange =
    newestPointDate !== null && newestPointDate < ETV_CUTOVER_DATE;

  return {
    points,
    // The stale sentence is **appended to** the formula caveat rather than
    // replacing it: "which model" and "how old" are different facts, and a
    // reader needs both. When the formula caveat is null (a fully known,
    // single-model series — the exact case the deadline turns stale), the stale
    // sentence stands alone.
    caveat: predatesFormulaChange
      ? [
          caveat,
          `This series was last captured on ${newestPointDate}, before DataForSEO changed the ETV model on ${ETV_CUTOVER_DATE} — its newest value is a legacy-model number, and nothing newer has been recorded.`,
        ]
          .filter((sentence): sentence is string => sentence !== null)
          .join(" ")
      : caveat,
    // The rule is drawn only when a series actually crosses the boundary, so a
    // chart entirely on one model stays clean.
    showBoundary: caveat !== null,
    isEmpty: points.length === 0,
    predatesFormulaChange,
    newestPointDate,
  };
}
