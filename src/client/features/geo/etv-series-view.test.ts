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

describe("what the view says about the endpoint behind an unstamped value", () => {
  it("passes the endpoint through so the caveat names it", () => {
    // The general caveat — "some values" — is the one this replaces: the
    // endpoint arrives on the point (the series read carries it at the top
    // level, and the page joins it onto every point), so the caveat can name
    // the producer and a reader knows which number to distrust.
    const view = buildEtvSeriesView([
      legacy("2026-10-15", 1000),
      {
        date: "2026-10-22",
        etv: 9999,
        formulaVersion: null,
        endpoint: "keywords_for_categories",
      },
    ]);
    expect(view.points.map((p) => p.etv)).toEqual([1000]);
    expect(view.caveat).toContain("`keywords_for_categories`");
  });
});

describe("the stale-read rule", () => {
  it("flags a series whose newest capture predates the formula change", () => {
    // The scenario the deadline makes real: on 2026-11-01 every existing
    // series is in this state, because the newest value any of them holds was
    // captured before the flip. Without the rule the chart reads as current
    // while its newest number is a legacy-model number.
    const view = buildEtvSeriesView([
      legacy("2026-10-15", 1000),
      legacy("2026-10-29", 1050),
    ]);
    expect(view.predatesFormulaChange).toBe(true);
    expect(view.newestPointDate).toBe("2026-10-29");
    // The claim names the last capture date, because "stale" without a date
    // is a feeling; "last captured on 2026-10-29" is a fact a reader can act on.
    expect(view.caveat).toContain("last captured on 2026-10-29");
    expect(view.caveat).toContain("legacy-model number");
  });

  it("stands alone when the formula caveat is null", () => {
    // A fully known single-model series has no formula caveat at all — that is
    // the clean case — and the stale sentence is the only thing it carries. If
    // it were dropped there, a clean pre-cutover series would read as current.
    const view = buildEtvSeriesView([modern("2026-10-29", 1050)]);
    expect(view.caveat).not.toMatch(/All values use the legacy/);
    expect(view.caveat).toContain("last captured on 2026-10-29");
  });

  it("does not flag a series that holds a capture from on or after the change", () => {
    // The moment a post-cutover value exists, the series is not stale even
    // though its early points predate the change — the other rule (the mixing
    // caveat) covers those.
    const view = buildEtvSeriesView([
      legacy("2026-10-29", 1050),
      modern("2026-11-05", 5000),
    ]);
    expect(view.predatesFormulaChange).toBe(false);
    expect(view.newestPointDate).toBe("2026-11-05");
    expect(view.caveat).not.toMatch(/last captured on/);
  });

  it("measures staleness from the newest capture, not the newest plottable point", () => {
    // An unplottable value (unknown provenance) still knows when we last saw
    // data. Reading staleness off the plottable points only would let an
    // unreadable newest value hide how old the series is — the opposite of the
    // rule's purpose.
    const view = buildEtvSeriesView([
      legacy("2026-10-15", 1000),
      {
        date: "2026-11-10",
        etv: 4000,
        formulaVersion: null,
        endpoint: "keyword_overview",
      },
    ]);
    expect(view.predatesFormulaChange).toBe(false);
    expect(view.newestPointDate).toBe("2026-11-10");
  });

  it("claims nothing for an empty series", () => {
    // There is no capture to be stale, and a caveat on an empty chart is noise.
    const view = buildEtvSeriesView([]);
    expect(view.predatesFormulaChange).toBe(false);
    expect(view.newestPointDate).toBeNull();
    expect(view.caveat).toBeNull();
  });
});
