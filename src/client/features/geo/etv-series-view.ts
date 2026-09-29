import { trendCaveat, type EtvFormulaVersion } from "@/shared/etv-versioning";

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

  const caveat = trendCaveat(data.map((point) => point.formulaVersion));

  return {
    points,
    caveat,
    // The rule is drawn only when a series actually crosses the boundary, so a
    // chart entirely on one model stays clean.
    showBoundary: caveat !== null,
    isEmpty: points.length === 0,
  };
}
