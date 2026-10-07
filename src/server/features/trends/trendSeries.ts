/**
 * Reading a DataForSEO Trends graph, and the two rules that make it safe to show.
 *
 * ## Rule one: a `0` is the vendor's own "no data", so it is `null` here
 *
 * The reference is explicit: *"A score of 0 means there was not enough data for this term."* That
 * is the repository's `0`-is-not-`null` rule arriving from the vendor's documentation, and it is
 * the rare case where mapping to `null` is the faithful reading rather than a lossy one — the
 * vendor has already decided that 0 carries no measurement. Rendered as a line dipping to the
 * floor, a no-data week would read as a collapse in interest.
 *
 * ## Rule two: the numbers are relative to the peak **within one request**
 *
 * *"If you specify more than one keyword, the values will be averaged to the highest value across
 * all specified keywords"* — so the 0–100 scale is normalised against the biggest peak in the
 * batch. Asking for `[acme]` and asking for `[acme, rival]` produce **different scores for acme**,
 * and neither is wrong. A view that put two requests' numbers on one axis would be comparing two
 * different rulers, which is why this module names the caveat instead of leaving it to a caller to
 * rediscover.
 *
 * Pure, and separate from the client, so neither rule needs a network or a database to test.
 */

type TrendPoint = {
  dateFrom: string | null;
  dateTo: string | null;
  /** Null when the vendor reported 0, which its documentation defines as "not enough data". */
  value: number | null;
};

type TrendSeries = {
  keyword: string;
  points: TrendPoint[];
  /** The vendor's whole-range average, under the same 0 rule. */
  average: number | null;
};

/** A vendor value, with its documented 0 mapped to null. */
export function readTrendValue(
  value: number | null | undefined,
): number | null {
  if (value == null) return null;
  return value === 0 ? null : value;
}

/**
 * The caveat this endpoint's numbers require, in one sentence, for any surface that shows them.
 *
 * Kept here rather than in a component so two views cannot describe the same limitation two
 * different ways — the same reason the volume-reconciliation verdicts live in a shared model.
 */
export const TREND_SCALE_CAVEAT =
  "Scores are relative to the biggest peak in this request, so numbers from two different requests are not comparable.";

type GraphLike = {
  keywords?: string[] | null;
  data?: Array<{
    date_from?: string | null;
    date_to?: string | null;
    values?: number[] | null;
  }> | null;
  averages?: number[] | null;
};

/**
 * One series per keyword, aligned by index.
 *
 * **A short `values` array yields `null` for the missing keyword rather than shifting the rest.**
 * The vendor's arrays are positional, so reading past the end is how a series silently becomes
 * another keyword's data — the most damaging possible failure for a comparison chart, and one that
 * a length check prevents outright.
 */
export function readTrendSeries(graph: GraphLike): TrendSeries[] {
  const keywords = graph.keywords ?? [];
  const points = graph.data ?? [];

  return keywords.map((keyword, index) => ({
    keyword,
    points: points.map((point) => ({
      dateFrom: point.date_from ?? null,
      dateTo: point.date_to ?? null,
      value: readTrendValue(point.values?.[index]),
    })),
    average: readTrendValue(graph.averages?.[index]),
  }));
}
