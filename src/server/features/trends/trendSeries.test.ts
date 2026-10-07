/**
 * The two rules, and the alignment failure they sit next to.
 *
 * The vendor's `values` arrays are **positional**, and a comparison chart is exactly where a
 * misalignment is least visible and most damaging: every line is plausible, and the shape is
 * wrong. So the alignment case is tested alongside the two documented rules rather than trusted.
 */
import { describe, expect, it } from "vitest";
import { readTrendSeries, readTrendValue } from "./trendSeries";

const graph = {
  keywords: ["iphone 14", "samsung s23"],
  data: [
    { date_from: "2023-01-15", date_to: "2023-01-21", values: [33, 22] },
    { date_from: "2023-01-22", date_to: "2023-01-28", values: [29, 8] },
  ],
  averages: [22, 6],
};

describe("readTrendValue", () => {
  it("maps the vendor's 0 to null, because its documentation says 0 is 'not enough data'", () => {
    // Rendered as a line dipping to the floor, a no-data week reads as a collapse in interest.
    expect(readTrendValue(0)).toBeNull();
  });

  it("keeps every real value, including a genuine low", () => {
    expect(readTrendValue(1)).toBe(1);
    expect(readTrendValue(100)).toBe(100);
    expect(readTrendValue(null)).toBeNull();
    expect(readTrendValue(undefined)).toBeNull();
  });
});

describe("readTrendSeries", () => {
  it("returns one series per keyword, in the request's order", () => {
    const series = readTrendSeries(graph);
    expect(series.map((entry) => entry.keyword)).toEqual([
      "iphone 14",
      "samsung s23",
    ]);
    expect(series[0]?.points.map((point) => point.value)).toEqual([33, 29]);
    expect(series[1]?.points.map((point) => point.value)).toEqual([22, 8]);
  });

  it("carries the dates through, so a chart can label its own x-axis", () => {
    const series = readTrendSeries(graph);
    expect(series[0]?.points[0]).toEqual({
      dateFrom: "2023-01-15",
      dateTo: "2023-01-21",
      value: 33,
      missingData: false,
    });
  });

  it("gives a short values array null for the missing keyword instead of shifting", () => {
    // The failure this prevents: reading `values[1]` when the array has one entry yields
    // `undefined`, and a careless implementation would carry the previous keyword's number into
    // the next one's line. Every chart would look plausible and be wrong.
    const series = readTrendSeries({
      keywords: ["a", "b"],
      data: [{ values: [50] }],
      averages: [50],
    });
    expect(series[0]?.points[0]?.value).toBe(50);
    expect(series[1]?.points[0]?.value).toBeNull();
    expect(series[1]?.average).toBeNull();
  });

  it("applies the 0 rule to averages as well as points", () => {
    const series = readTrendSeries({
      keywords: ["a", "b"],
      data: [{ values: [0, 40] }],
      averages: [0, 40],
    });
    expect(series[0]?.average).toBeNull();
    expect(series[1]?.average).toBe(40);
  });

  it("returns nothing for a graph with no keywords rather than throwing", () => {
    expect(readTrendSeries({})).toEqual([]);
  });

  it("treats a Google-flagged point as unmeasured even when it carries a number", () => {
    // Google marks a missing point with `missing_data` and draws a dotted line rather than a
    // value. Showing the number would present a reading the vendor has disowned.
    const series = readTrendSeries({
      keywords: ["seo api"],
      data: [
        { values: [54], missing_data: false },
        { values: [30], missing_data: true },
        { values: [null], missing_data: false },
      ],
    });
    expect(series[0]?.points.map((point) => point.value)).toEqual([
      54,
      null,
      null,
    ]);
    expect(series[0]?.points.map((point) => point.missingData)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
