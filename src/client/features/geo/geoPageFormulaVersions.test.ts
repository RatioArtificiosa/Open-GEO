import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { GeoVisibilityPanel } from "./GeoVisibilityPanel";
import type { EtvPoint } from "./etv-series-view";
/**
 * The chain from the archive to the chart, closed at the call site.
 *
 * The GEO visibility chart was already correct all the way down: the repository
 * returns `etvFormulaVersion` per row, `GeoService.getEtvSeries` maps it onto
 * each point, and `GeoVisibilityPanel` accepts `hasUnstampedPoints` and renders
 * the withheld-points note. `GeoPage.tsx:302` then passed **only the points**, so
 * every value beyond the boundary was dropped on the floor — and a dropped
 * provenance note reads exactly like a complete one, because nothing is missing
 * to notice.
 *
 * That is the "correct component with an unreachable input" failure this repo has
 * now produced in three different phases (the evidence drawer, the forecast, this
 * one). The important property: **none of the existing tests could catch it**,
 * because the panel is tested, the series view is tested, the repository is
 * tested — each one against its own collaborators. What was missing was a claim
 * about the *join* between them.
 *
 * So this file asserts on the *call site's source*, not on a re-render of the
 * panel: a source assertion is the only thing that sees "the page passed points
 * but not versions", because by the time the panel renders, the decision has
 * already been made. The panel render assertions below are the positive control
 * — they establish that the panel does render the note when given the data, so
 * the source assertion is checking a wire that actually carries something.
 *
 * The negative control for this gate is in the goal notes: reintroduce the
 * one-prop call site (`series={{ points: data.etvPoints }}`) and this test fails.
 */

const REPO_ROOT = process.cwd().endsWith("\\src")
  ? process.cwd().replace(/[\\/]src[\\/]?$/, "")
  : process.cwd();

const GEO_PAGE = "src/client/features/geo/GeoPage.tsx";

function readGeoPage(): string {
  return readFileSync(join(REPO_ROOT, GEO_PAGE), "utf8");
}

function render(points: EtvPoint[], hasUnstampedPoints?: boolean): string {
  return renderToStaticMarkup(
    createElement(GeoVisibilityPanel, {
      series: { points, hasUnstampedPoints },
    }),
  );
}

const legacy = (date: string, etv: number): EtvPoint => ({
  date,
  etv,
  formulaVersion: "legacy",
});

describe("the GEO page passes the formula versions through", () => {
  it("passes hasUnstampedPoints to the panel, not just the points", async () => {
    // The bug: `series={{ points: data.etvPoints }}` drops everything else.
    // `formulaVersions` is computed in useGeoPageData:436 and was dead on
    // arrival. Now the call site must pass the derived flag.
    const html = readGeoPage();
    expect(html).toMatch(/hasUnstampedPoints\s*:/);
    expect(html).toMatch(/etvFormulaVersions/);
  });

  it("does not pass only the points to GeoVisibilityPanel", () => {
    // The negative form, and the one a reader can check by eye: a bare
    // `{ points: ... }` object is the exact shipped bug.
    const html = readGeoPage();
    expect(html).not.toMatch(
      /<GeoVisibilityPanel[^>]*series=\{\{\s*points:\s*data\.etvPoints\s*\}\}/s,
    );
  });

  it("keeps the ETV cutover constant the single source of the boundary", () => {
    // The date must not be re-typed in the page or the panel — a second
    // hardcoded date is a second thing to change on 2026-11-01.
    const source = readFileSync(join(REPO_ROOT, GEO_PAGE), "utf8");
    expect(source).not.toMatch(/2026-11-01/);
    const panel = readFileSync(
      join(REPO_ROOT, "src/client/features/geo/GeoVisibilityPanel.tsx"),
      "utf8",
    );
    expect(panel).not.toMatch(/2026-11-01/);
    const constant = readFileSync(
      join(REPO_ROOT, "src/shared/etv-versioning.ts"),
      "utf8",
    );
    expect(constant).toContain('ETV_CUTOVER_DATE = "2026-11-01"');
  });
});

describe("the panel renders the withheld-points note when given the data", () => {
  it("renders the note for a series with unstamped points", () => {
    // The positive control: the wire carries something. Without it the source
    // assertion above would be checking a prop that does nothing.
    const html = render(
      [legacy("2026-10-15", 1000)],
      /* hasUnstampedPoints */ true,
    );
    expect(html).toContain("withheld from the");
  });

  it("renders no note for a fully-stamped series", () => {
    // The other half: an honest note must appear only when points were really
    // withheld, or every chart carries a permanent apology.
    const html = render(
      [legacy("2026-10-15", 1000)],
      /* hasUnstampedPoints */ false,
    );
    expect(html).not.toContain("withheld from the");
  });
});
