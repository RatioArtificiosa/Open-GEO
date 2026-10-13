import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EtvBoundaryChart } from "./EtvBoundaryChart";
import type { EtvPoint } from "./etv-series-view";

/**
 * The boundary rendered, not merely computed.
 *
 * `buildEtvSeriesView` decides what the chart is allowed to claim, and its tests
 * pin those decisions. This file asks the question those cannot: **does the
 * boundary reach the DOM?** A mixed series whose caveat exists in a pure
 * function and nowhere else is the "correct component with an unreachable
 * input" failure this repository has now produced in several phases — the panel
 * was correct, the series view was correct, and the page passed the points
 * without the versions.
 *
 * So this renders the component from a `.ts` file (the repo's vitest config
 * includes `*.test.ts` only) and asserts on the markup.
 *
 * ## Why the legend exists at all, and why this test can only see it
 *
 * The visual boundary is a Recharts `ReferenceLine`, and **Recharts renders an
 * empty `div` under `renderToStaticMarkup`** — the SVG — and everything inside
 * it — is browser-only. The honest reading of that is not "the boundary cannot
 * be tested"; it is that a claim drawn only in SVG is invisible wherever SVG is
 * not rendered (server-side, print, a reader with scripts blocked). So the
 * component carries a second, DOM-native statement of the same boundary — the
 * legend under the chart, reading from the same constant the rule does — and
 * *that* is what this test asserts. The SVG rule stays browser-only; the
 * legend is its mirror where a picture is not available.
 */

const REPO_ROOT = process.cwd().endsWith("\\src")
  ? process.cwd().replace(/[\\/]src[\\/]?$/, "")
  : process.cwd();

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

function render(points: EtvPoint[]): string {
  return renderToStaticMarkup(
    createElement(EtvBoundaryChart, { data: points }),
  );
}

describe("the ETV boundary chart renders the boundary", () => {
  it("shows a visible boundary and the caveat for a series that mixes formulas", () => {
    // The exact pair the goal's acceptance names: one stored `legacy` value and
    // one fresh `new` value in one series. A step between them must read as a
    // method change, and the reader must not have to trust the line alone.
    const html = render([
      legacy("2026-10-29", 1000),
      modern("2026-11-05", 5000),
    ]);

    // The caveat: the step is named as method, not traffic, with the date.
    expect(html).toContain("mixes ETV formulas");
    expect(html).toContain("not a change in traffic");
    expect(html).toContain("2026-11-01");

    // The DOM mirror of the SVG rule — visible wherever SVG is not.
    expect(html).toContain("ETV model changed on 2026-11-01");
  });

  it("keeps a clean single-model series clean", () => {
    // The other half of the claim: a warning on every chart trains people to
    // ignore warnings, so a series that is entirely on the new model — the
    // steady state after the cutover — carries no boundary at all.
    const html = render([
      modern("2026-11-05", 5000),
      modern("2026-11-19", 5200),
    ]);
    expect(html).not.toContain("ETV model changed");
    expect(html).not.toContain("mixes ETV formulas");
    expect(html).not.toContain("last captured on");
  });

  it("marks a series whose newest value predates the change as not current", () => {
    // The stale-read rule, rendered: the reader must not take a frozen
    // pre-cutover series for a live one. On 2026-11-01 every existing series
    // is in this state, so this is the state the deadline produces.
    const html = render([legacy("2026-10-29", 1050)]);
    expect(html).toContain("last captured on 2026-10-29");
    expect(html).toContain("nothing newer has been recorded");
  });

  it("explains itself instead of drawing nothing when nothing is plottable", () => {
    const html = render([
      { date: "2026-10-15", etv: null, formulaVersion: "legacy" },
    ]);
    expect(html).toContain("No estimated traffic recorded yet");
  });

  it("reads the boundary date from the constant, never a literal", () => {
    // A second hardcoded date is a second thing to change on 2026-11-01, and
    // the one change nobody makes is the one they did not know existed.
    const source = readFileSync(
      join(REPO_ROOT, "src/client/features/geo/EtvBoundaryChart.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/2026-11-01/);
  });
});
