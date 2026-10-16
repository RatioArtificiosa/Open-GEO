import {
  type BreakoutSignal,
  breakoutSignals,
} from "@/server/features/trends/breakoutSignals";
import type { CategoryMomentum } from "@/server/features/trends/categoryMomentum";
import { categoryMomentum } from "@/server/features/trends/categoryMomentum";
import type { ChartSeries } from "./trendChartModel";

/**
 * Momentum + breakout verdicts over a charted series (CL-722/716 surfaces).
 *
 * Both engines are pure over oldest-first values with nulls for unmeasured
 * points — the math does not care whether the series is a category or a
 * keyword, so the verdicts read the very lines the chart draws rather than
 * billing a second request for the same window. Short windows decline
 * honestly: breakout needs a year plus a quarter for its YoY half, momentum
 * needs six measured points, and either engine says so in its summary.
 */

export type TrendVerdict = {
  keyword: string;
  momentum: CategoryMomentum;
  breakout: BreakoutSignal;
};

export function trendVerdictsFor(series: ChartSeries[]): TrendVerdict[] {
  return series.map((entry) => {
    const values = entry.points.map((point) =>
      point.unmeasured ? null : point.value,
    );
    return {
      keyword: entry.keyword,
      momentum: categoryMomentum(values),
      breakout: breakoutSignals(
        entry.keyword,
        entry.points.map((point, index) => ({
          date: point.dateFrom ?? `step ${index + 1}`,
          value: point.unmeasured ? null : point.value,
        })),
      ),
    };
  });
}
