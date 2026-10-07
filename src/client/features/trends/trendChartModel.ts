/**
 * Turning a trend series into something drawable, honestly.
 *
 * ## The one rule this model exists for: a missing point is not a zero
 *
 * The vendor's 0 means *"not enough data"*, and `readTrendSeries` maps it to `null` — so by the
 * time a series reaches a chart, an unmeasured week and a week of no interest are already
 * different values. This model keeps them different **visually** too: an unmeasured point gets
 * `heightPct: null` and is drawn as a gap, never as a zero-height bar. A bar of height zero *is*
 * what a real zero looks like, so drawing a gap that way would erase the distinction the reader
 * just paid for.
 *
 * ## Why the scale is shared across the series in one request
 *
 * The vendor normalises every keyword in a request against **the biggest peak among them**, so the
 * 0–100 axis is one ruler for the whole batch. That is why this model takes the list of series and
 * computes a single peak rather than normalising each series to itself: an "each line to its own
 * peak" chart would make a keyword nobody searches look as tall as a keyword everybody does, which
 * is the single most misleading thing a trend chart can do.
 */

type ChartPoint = {
  dateFrom: string | null;
  dateTo: string | null;
  /** The vendor's value, or null where it reported no data. */
  value: number | null;
  /** Share of the request's peak, or null for an unmeasured point. */
  heightPct: number | null;
  /** True when the vendor had no data for this point — drawn as a gap, not as a floor. */
  unmeasured: boolean;
};

export type ChartSeries = {
  keyword: string;
  average: number | null;
  points: ChartPoint[];
};

type TrendChart = {
  series: ChartSeries[];
  /** The largest measured value across every series, which is the vendor's own normaliser. */
  peak: number | null;
  pointCount: number;
};

type SeriesLike = {
  keyword: string;
  average: number | null;
  points: Array<{
    dateFrom: string | null;
    dateTo: string | null;
    value: number | null;
  }>;
};

const PEAK_PCT = 100;
/** A measured but tiny value still gets a visible mark; only unmeasured points are gaps. */
const MIN_VISIBLE_PCT = 2;

export function toTrendChart(input: SeriesLike[]): TrendChart {
  const values = input.flatMap((entry) =>
    entry.points
      .map((point) => point.value)
      .filter((value): value is number => value !== null),
  );
  const peak = values.length > 0 ? Math.max(...values) : null;
  const pointCount = Math.max(0, ...input.map((entry) => entry.points.length));

  return {
    peak,
    pointCount,
    series: input.map((entry) => ({
      keyword: entry.keyword,
      average: entry.average,
      points: entry.points.map((point) => {
        if (point.value === null || peak === null || peak === 0) {
          return {
            dateFrom: point.dateFrom,
            dateTo: point.dateTo,
            value: point.value,
            heightPct: null,
            unmeasured: point.value === null,
          };
        }
        const share = (point.value / peak) * PEAK_PCT;
        return {
          dateFrom: point.dateFrom,
          dateTo: point.dateTo,
          value: point.value,
          heightPct: Math.max(MIN_VISIBLE_PCT, share),
          unmeasured: false,
        };
      }),
    })),
  };
}

/**
 * How many points in a chart the vendor had no data for.
 *
 * Reported beside the chart because "flat and low" and "measured in only half the weeks" look
 * alike on a small sparkline, and only one of them is a statement about interest.
 */
export function countUnmeasured(chart: TrendChart): number {
  return chart.series.reduce(
    (total, entry) =>
      total + entry.points.filter((point) => point.unmeasured).length,
    0,
  );
}
