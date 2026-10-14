import { describe, expect, it } from "vitest";
import { categoryMomentum, readCategoryTrend } from "./categoryMomentum";

/**
 * Category momentum — the verdicts, and the refusals that keep them honest.
 *
 * The product sentence is "CRM is cooling; AI-visibility is accelerating", and
 * the failure this suite exists to prevent is a flat week reading as a trend.
 * Each refusal below is a way a forecast becomes confidently wrong, which is the
 * same failure family as the traffic forecast's — the tests pin both.
 */

/** A steady climb: half the points rising, no spikes, nothing to misread. */
const rising = Array.from({ length: 20 }, (_, i) => 40 + i * 2);

/**
 * A graph item, in the shape the reader's contract names.
 *
 * Module scope because it captures nothing from any suite — the repo's
 * `consistent-function-scoping` rule rejects re-creating it per test. The point
 * shape is spelled out rather than left to a `Record`, because a loose record
 * makes the nested `values` `any` and the reader's own type is what pins it.
 */
const graph = (
  data: Array<{
    values?: Array<number | null> | null;
    missing_data?: boolean | null;
  }>,
) => ({ data });
/** The mirror: a steady decline. */
const cooling = Array.from({ length: 20 }, (_, i) => 100 - i * 2);
/** Flat with wobble, the shape weekly interest reports actually have. */
const wobbling = Array.from(
  { length: 20 },
  (_, i) => 50 + (i % 2 === 0 ? 1 : -1),
);

describe("categoryMomentum", () => {
  it("calls a steady climb accelerating, and names both numbers", () => {
    const result = categoryMomentum(rising);
    expect(result.direction).toBe("accelerating");
    expect(result.basis).toBe("measured");
    expect(result.changePercent).not.toBeNull();
    expect(result.changePercent ?? 0).toBeGreaterThan(20);
    expect(result.slopePerStep ?? 0).toBeGreaterThan(0);
    expect(result.summary).toMatch(/^Accelerating:/);
    expect(result.summary).toMatch(/slope \+2 points per step/);
    // The caveat travels with the answer: the scores are one request's ruler.
    expect(result.caveat).toMatch(/relative to the biggest peak/);
  });

  it("calls a steady decline cooling", () => {
    const result = categoryMomentum(cooling);
    expect(result.direction).toBe("cooling");
    expect(result.changePercent ?? 0).toBeLessThan(-20);
    expect(result.slopePerStep ?? 0).toBeLessThan(0);
    expect(result.summary).toMatch(/^Cooling:/);
  });

  it("leaves a wobbling series steady rather than reading the last tick", () => {
    // The whole point: weekly reports wobble far more than a direction's worth,
    // and a dashboard that names every wobble teaches its readers to ignore it.
    const result = categoryMomentum(wobbling);
    expect(result.direction).toBe("steady");
    expect(result.summary).toMatch(/within the band this method calls flat/);
  });

  it("refuses a direction when the ratio is steep but the recent half is falling", () => {
    // **The negative control for the two-signal rule.** The level shifted up —
    // the recent half's median is far above the earlier one — and the recent
    // half is *already falling* (80, 80, 70, 60, 50). That is "elevated and
    // turning", not "accelerating", and a single-signal verdict cannot tell the
    // two apart. Without this test the level-shift case passes alone.
    const shifted = [
      30, 30, 30, 30, 30, 30, 30, 30, 30, 80, 70, 60, 55, 50, 45, 45, 45, 45,
    ];
    const result = categoryMomentum(shifted);
    expect(result.changePercent ?? 0).toBeGreaterThan(50);
    expect(result.direction).toBe("steady");
    expect(result.recentSlopePerStep ?? 0).toBeLessThan(0);
    expect(result.summary).toMatch(/within the band this method calls flat/);
  });

  it("cannot be moved by a spike, which is the number a mean would fake", () => {
    // The whole reason the ratio is a median: two enormous points at the end of
    // a flat window would carry a mean-based ratio far past the margin, and the
    // verdict would name a climb that is two points long.
    const spiked = [
      50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 95, 100,
    ];
    const result = categoryMomentum(spiked);
    expect(result.changePercent ?? 0).toBeLessThan(20);
    expect(result.direction).toBe("steady");
    // The spike is visible in the numbers — it is not hidden — it just cannot
    // carry the verdict on its own.
    expect(result.pointsMeasured).toBe(16);
  });

  it("reports no direction from too little history, and says why", () => {
    // A verdict from three points is arithmetic on noise. "We cannot see a
    // direction" and "steady" are different claims, and only the first is true.
    const result = categoryMomentum([10, 12, 14, 16, 18]);
    expect(result.direction).toBeNull();
    expect(result.basis).toBe("too-little-history");
    expect(result.summary).toMatch(/6 are the floor/);
  });

  it("reports no direction when nothing was measured", () => {
    const result = categoryMomentum([null, null, null, null]);
    expect(result.direction).toBeNull();
    expect(result.basis).toBe("window-not-measured");
    expect(result.summary).toMatch(/not a flat trend/);
  });

  it("reports no direction when one half has no measured point", () => {
    // The recent half is entirely unmeasured: there is nothing to compare the
    // earlier half against, and inventing a direction from one side of the
    // window is the guess this feature refuses.
    const result = categoryMomentum([
      40,
      42,
      44,
      46,
      48,
      50,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(result.direction).toBeNull();
    expect(result.basis).toBe("window-not-measured");
    expect(result.changePercent).toBeNull();
  });

  it("keeps a missing point out of the fit and out of the windows", () => {
    // A null is not a zero: imputing one turns a data outage into a collapse,
    // which would then be called a direction.
    const withGap: Array<number | null> = [...rising];
    withGap[10] = null;
    const result = categoryMomentum(withGap);
    expect(result.direction).toBe("accelerating");
    expect(result.pointsMeasured).toBe(19);
    // The gap does not flatten the slope by dragging a zero into the fit.
    expect(result.slopePerStep ?? 0).toBeGreaterThan(1);
  });
});

describe("readCategoryTrend", () => {
  it("reads the positional series a category-only request returns", () => {
    const read = readCategoryTrend(
      graph([{ values: [30] }, { values: [65] }, { values: [100] }]),
    );
    expect(read).toEqual([30, 65, 100]);
  });

  it("maps the vendor's 0 to null, because 0 is 'no data'", () => {
    // The rule is trendSeries's, reused rather than restated so one vendor rule
    // cannot be read two ways.
    const read = readCategoryTrend(
      graph([{ values: [42] }, { values: [0] }, { values: [88] }]),
    );
    expect(read).toEqual([42, null, 88]);
  });

  it("treats a flagged point as unmeasured even when it carries a number", () => {
    const read = readCategoryTrend(
      graph([
        { values: [42], missing_data: false },
        { values: [17], missing_data: true },
      ]),
    );
    expect(read).toEqual([42, null]);
  });

  it("reads an absent graph as an empty series, not a crash", () => {
    expect(readCategoryTrend({})).toEqual([]);
    expect(readCategoryTrend({ data: null })).toEqual([]);
  });
});
