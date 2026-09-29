import { describe, expect, it } from "vitest";
import { buildEtvSeriesView, type EtvPoint } from "./etv-series-view";

/**
 * What an ETV chart is allowed to claim.
 *
 * The product claim is that most tools' traffic charts break silently on
 * 2026-11-01 and ours does not. That is only true if a reader who sees a step
 * can tell whether it was traffic or methodology. These tests pin the three
 * exclusions that make the claim honest, and the fact that a clean series stays
 * clean — a warning on every chart trains people to ignore warnings.
 */

const legacy = (date: string, etv: number): EtvPoint => ({
  date,
  etv,
  formulaVersion: "legacy",
});
const modern = (date: string, etv: number): EtvPoint => ({
  date,
  etv,
  formulaVersion: "new",
});

describe("buildEtvSeriesView", () => {
  it("does not claim a mixed series when only one model is present", () => {
    // A clean single-model series still states WHICH model, so a reader knows
    // what they are looking at — but it must never accuse the series of mixing
    // them. Only the boundary rule and the mixing warning are conditional.
    const view = buildEtvSeriesView([
      legacy("2026-10-01", 1000),
      legacy("2026-10-15", 1100),
      legacy("2026-10-29", 1050),
    ]);
    expect(view.caveat).not.toMatch(/mixes ETV formulas/);
    expect(view.caveat).not.toMatch(/no recorded ETV formula version/);
    expect(view.caveat).toMatch(/legacy ETV formula/);
    expect(view.points).toHaveLength(3);
  });

  it("flags a series that mixes formulas, and names the date", () => {
    const view = buildEtvSeriesView([
      legacy("2026-10-15", 1000),
      legacy("2026-10-29", 1050),
      modern("2026-11-05", 5000),
      modern("2026-11-19", 5200),
    ]);
    expect(view.showBoundary).toBe(true);
    expect(view.caveat).toMatch(/mixes ETV formulas/);
    expect(view.caveat).toContain("2026-11-01");
    // The copy must say the step is a method change, or a reader will still
    // take it for growth.
    expect(view.caveat).toMatch(/not a change in traffic/);
  });

  it("drops a point whose formula version is unknown rather than attributing it", () => {
    // Plotting it would assert a model we do not know produced the value. This
    // is the exact failure the whole feature exists to prevent.
    const view = buildEtvSeriesView([
      legacy("2026-10-15", 1000),
      { date: "2026-10-22", etv: 9999, formulaVersion: null },
      legacy("2026-10-29", 1050),
    ]);
    expect(view.points.map((p) => p.etv)).toEqual([1000, 1050]);
    expect(view.caveat).toMatch(/no recorded ETV formula version/);
  });

  it("treats a null etv as absent data, not as zero", () => {
    // Zero would read as "traffic collapsed to nothing" — a different claim
    // from "we have no data for this date".
    const view = buildEtvSeriesView([
      { date: "2026-10-15", etv: null, formulaVersion: "legacy" },
      legacy("2026-10-22", 1000),
    ]);
    expect(view.points).toHaveLength(1);
    expect(view.points[0]?.etv).toBe(1000);
  });

  it("reports an empty series so the chart can explain itself", () => {
    const view = buildEtvSeriesView([]);
    expect(view.isEmpty).toBe(true);
    expect(view.points).toEqual([]);
    // An empty series with a caveat would be alarming noise; there is nothing
    // to caveat when nothing was recorded.
    expect(view.caveat).toBeNull();
  });

  it("treats an all-legacy series as legacy, not as mixed", () => {
    const view = buildEtvSeriesView([legacy("2026-01-01", 10)]);
    expect(view.caveat).toMatch(/legacy ETV formula/);
    expect(view.showBoundary).toBe(true);
  });
});
