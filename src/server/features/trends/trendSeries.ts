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
  /** Null when the vendor reported 0, or flagged the point as having no data. */
  value: number | null;
  /** True when the vendor explicitly flagged this point, which Google Trends does. */
  missingData: boolean;
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

/**
 * The caveat that matters once two indexes exist.
 *
 * DataForSEO Trends and Google Trends both score 0-100, and neither score is a share of anything
 * absolute: each is the keyword's peak measured **inside its own index and its own request**. So a
 * 90 from one and a 90 from the other are not the same quantity, and drawing them on one axis
 * would invent a comparison that neither vendor makes. This is shipped as a constant for the same
 * reason as the scale caveat: two surfaces must not describe one limitation two ways.
 */
export const CROSS_SOURCE_TREND_CAVEAT =
  "Each index scores a keyword against its own peak, so a 90 here and a 90 there are different quantities. Compare sources by shape, never by number.";

type GraphLike = {
  keywords?: string[] | null;
  data?: Array<{
    date_from?: string | null;
    date_to?: string | null;
    values?: Array<number | null> | null;
    /**
     * Google Trends marks a point it had no data for with this flag, and draws it as a dotted
     * line. DataForSEO Trends has no such field — it signals the same thing with a `0` — so this
     * reader honours whichever signal a vendor actually sends.
     */
    missing_data?: boolean | null;
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
      // Either signal means "no data", and a flagged point is unmeasured even when it carries a
      // number: the vendor draws a dotted line rather than a value, so showing the number would
      // present a reading it has disowned.
      value:
        point.missing_data === true
          ? null
          : readTrendValue(point.values?.[index]),
      missingData: point.missing_data === true,
    })),
    average: readTrendValue(graph.averages?.[index]),
  }));
}
