/**
 * The two ways a trend chart lies, both tested here.
 *
 * One: normalising each line to its own peak, which makes a forgotten keyword look as big as a
 * famous one. Two: drawing an unmeasured week as a zero-height bar, which turns "the vendor had no
 * data" into "nobody searched". Both produce a chart that looks fine, which is why they are the
 * assertions rather than the layout.
 */
import { describe, expect, it } from "vitest";
import { countUnmeasured, toTrendChart } from "./trendChartModel";

const series = (
  keyword: string,
  values: Array<number | null>,
  average: number | null = null,
) => ({
  keyword,
  average,
  points: values.map((value, index) => ({
    dateFrom: `2024-0${index + 1}-01`,
    dateTo: `2024-0${index + 1}-07`,
    value,
  })),
});

describe("toTrendChart", () => {
  it("normalises every series against one shared peak, the request's", () => {
    // The vendor's own normaliser. Normalising each line to itself would draw the 10s as tall as
    // the 100s, which is the most misleading shape a trend chart can take.
    const chart = toTrendChart([
      series("famous", [100, 50]),
      series("forgotten", [10, 5]),
    ]);
    expect(chart.peak).toBe(100);
    expect(chart.series[0]?.points.map((point) => point.heightPct)).toEqual([
      100, 50,
    ]);
    expect(chart.series[1]?.points.map((point) => point.heightPct)).toEqual([
      10, 5,
    ]);
  });

  it("draws an unmeasured point as a gap, not as a floor", () => {
    // A bar of height zero is what a real zero looks like, so a gap drawn that way erases the
    // distinction the reader is entitled to.
    const chart = toTrendChart([series("acme", [80, null, 40])]);
    const points = chart.series[0]?.points ?? [];
    expect(points[0]?.unmeasured).toBe(false);
    expect(points[1]?.unmeasured).toBe(true);
    expect(points[1]?.heightPct).toBeNull();
    expect(points[1]?.value).toBeNull();
    expect(countUnmeasured(chart)).toBe(1);
  });

  it("keeps a measured but tiny value visible", () => {
    // 1 of 100 is 1%, which rounds to nothing on a 40px bar; the floor keeps it a mark rather than
    // letting it read as absence.
    const chart = toTrendChart([series("acme", [100, 1])]);
    expect(chart.series[0]?.points[1]?.heightPct).toBe(2);
    expect(chart.series[0]?.points[1]?.unmeasured).toBe(false);
  });

  it("reports no peak at all when nothing was measured", () => {
    const chart = toTrendChart([series("acme", [null, null])]);
    expect(chart.peak).toBeNull();
    expect(
      chart.series[0]?.points.every((point) => point.heightPct === null),
    ).toBe(true);
    expect(countUnmeasured(chart)).toBe(2);
  });

  it("carries the dates so the axis can label itself", () => {
    const chart = toTrendChart([series("acme", [10])]);
    expect(chart.series[0]?.points[0]?.dateFrom).toBe("2024-01-01");
    expect(chart.pointCount).toBe(1);
  });

  it("handles series of different lengths without inventing points", () => {
    const chart = toTrendChart([series("a", [10, 20, 30]), series("b", [5])]);
    expect(chart.pointCount).toBe(3);
    expect(chart.series[1]?.points).toHaveLength(1);
  });
});
