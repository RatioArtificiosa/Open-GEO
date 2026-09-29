import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GeoVisibilityPanel } from "./GeoVisibilityPanel";
import type { EtvPoint } from "./etv-series-view";

/**
 * The rendered GEO panel.
 *
 * This is the end of the chain that makes the product claim true: "most tools'
 * traffic charts break silently on 2026-11-01, and ours does not." A chart that
 * computes the right caveat and does not show it has not made the claim, so these
 * assertions read the *rendered output* rather than the helper that produced it.
 *
 * A `.ts` test (not `.tsx`) on purpose — the repo's vitest config includes
 * `*.test.ts` only, and a component test needs no JSX to render one via
 * `createElement`.
 */

function render(points: EtvPoint[]): string {
  return renderToStaticMarkup(
    createElement(GeoVisibilityPanel, { series: { points } }),
  );
}

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

describe("GeoVisibilityPanel", () => {
  it("labels the series as an estimate and names the model change date up front", () => {
    const html = render([legacy("2026-10-15", 1000)]);
    // Before a reader acts on a number, they learn what it is.
    expect(html).toContain("A model estimate, not a measurement");
    expect(html).toContain("1 November 2026");
  });

  it("derives the date from the shared constant, not from prose", () => {
    // A hardcoded "1 November 2026" in copy is a second source of truth that
    // outlives the constant it mirrors — and this one is quoted on the homepage.
    // Rendering the constant's own formatting is what keeps them in step.
    const source = readFileSync(
      join(process.cwd(), "src/client/features/geo/GeoVisibilityPanel.tsx"),
      "utf8",
    );
    expect(source).toContain("ETV_CUTOVER_DATE");
    expect(source).not.toMatch(/\d{1,2} November 20\d\d/);
  });

  it("draws and explains the boundary when the series crosses it", () => {
    const html = render([
      legacy("2026-10-15", 1000),
      legacy("2026-10-29", 1050),
      modern("2026-11-05", 5000),
      modern("2026-11-19", 5200),
    ]);
    // The rendered caveat is the part that can be asserted here: Recharts emits
    // an empty div under server rendering, so the SVG boundary RULE is only
    // verifiable in a browser. The claim the reader actually acts on — "this
    // step is a method change" — is plain text, and is asserted below.
    expect(html).toContain("mixes ETV formulas");
    expect(html).toContain("2026-11-01");
    expect(html).toContain("not a change in traffic");
  });

  it("does not accuse a single-model series of mixing models", () => {
    const html = render([
      legacy("2026-10-15", 1000),
      legacy("2026-10-29", 1050),
    ]);
    expect(html).not.toContain("mixes ETV formulas");
  });

  it("withholds unstamped points and says how many, rather than drawing them", () => {
    const html = render([
      legacy("2026-10-15", 1000),
      { date: "2026-10-22", etv: 9999, formulaVersion: null },
      legacy("2026-10-29", 1050),
    ]);
    // The value must not reach the output at all...
    expect(html).not.toContain("9999");
    // ...and the gap must not be silent. JSX collapses the line breaks in this
    // sentence, so the match is on the phrase rather than the whole line.
    expect(html).toContain("withheld from the");
    expect(html).toContain("show a gap than draw a value we cannot attribute");
  });

  it("explains an empty series instead of drawing an empty axis", () => {
    const html = render([]);
    expect(html).toContain("No estimated traffic recorded yet");
  });
});
