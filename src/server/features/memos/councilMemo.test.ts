import { describe, expect, it } from "vitest";
import { renderCouncilMemo } from "./councilMemo";

/**
 * The council memo engine (CL-508).
 *
 * The load-bearing properties: empty inputs render as explicit empty states
 * (never omitted, never zero); fixes with impact outrank fixes without;
 * surplus fixes are counted, not dropped silently; every number travels with
 * the period; spend and forecasts unmeasured read as unknown, not zero.
 */

const INPUT = {
  brand: "Acme",
  periodFrom: "2026-10-09",
  periodTo: "2026-10-16",
  citationChanges: [
    { direction: "gained" as const, subject: "docs", count: 12 },
    { direction: "lost" as const, subject: "blog", count: 3 },
  ],
  topFixes: [
    { action: "Fix A", reason: "biggest gap", impact: "high" },
    { action: "Fix B", reason: "quick win", impact: null },
    { action: "Fix C", reason: "steady", impact: "medium" },
    { action: "Fix D", reason: "later", impact: "low" },
  ],
  spendUsd: 4.2,
  forecastsScored: 2,
};

describe("renderCouncilMemo", () => {
  it("renders every section with dated numbers", () => {
    const memo = renderCouncilMemo(INPUT);
    expect(memo).toMatch(/# GEO Council Memo — Acme/);
    expect(memo).toMatch(/2026-10-09 to 2026-10-16/);
    expect(memo).toMatch(/docs gained 12 citations/);
    expect(memo).toMatch(/Net positive/);
    expect(memo).toMatch(/Vendor spend this period: \$4\.20/);
    expect(memo).toMatch(/2 kept forecast\(s\) scored/);
  });

  it("orders impact first and counts the surplus", () => {
    const memo = renderCouncilMemo(INPUT);
    // Estimated fixes lead in input order; the fourth is counted, not
    // silently dropped.
    const a = memo.indexOf("Fix A");
    const c = memo.indexOf("Fix C");
    const d = memo.indexOf("Fix D");
    expect(a).toBeLessThan(c);
    expect(c).toBeLessThan(d);
    expect(memo).toMatch(/1 further fix\(es\) below the top three/);
  });

  it("renders an unestimated fix with the reason, never as zero impact", () => {
    const memo = renderCouncilMemo({
      ...INPUT,
      topFixes: [{ action: "Fix B", reason: "quick win", impact: null }],
    });
    expect(memo).toMatch(/Fix B — quick win \(impact unestimated\)/);
  });

  it("renders empty states instead of omitting or zeroing", () => {
    const memo = renderCouncilMemo({
      brand: "Acme",
      periodFrom: "2026-10-09",
      periodTo: "2026-10-16",
      citationChanges: [],
      topFixes: [],
      spendUsd: null,
      forecastsScored: null,
    });
    expect(memo).toMatch(/unwatched, not calm/);
    expect(memo).toMatch(/empty list, not an all-clear/);
    expect(memo).toMatch(/unknown, not zero/);
    expect(memo).not.toMatch(/\$0\.00/);
  });
});
