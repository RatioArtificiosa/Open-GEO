import { useMemo } from "react";
import { EtvBoundaryChart, type EtvChartPoint } from "./EtvBoundaryChart";

/**
 * The GEO visibility panel.
 *
 * Renders the ETV series through `EtvBoundaryChart`, which is where the
 * formula-change rule lives. This file only supplies the points and the framing
 * copy — every honesty decision about what may be plotted or claimed is in
 * `buildEtvSeriesView`, tested independently.
 *
 * The framing line matters as much as the chart: a reader who sees traffic
 * attributed to them needs to know these are *estimates from a model*, not
 * measurements, before they act on the number.
 */

type GeoVisibilitySeries = {
  /** Points carrying their own formula version. */
  points: EtvChartPoint[];
  /** Whether any points were dropped for missing provenance. */
  hasUnstampedPoints?: boolean;
};

export function GeoVisibilityPanel({
  series,
}: {
  series: GeoVisibilitySeries;
}) {
  const droppedCount = useMemo(
    () =>
      series.points.filter(
        (point) => point.etv === null || point.formulaVersion === null,
      ).length,
    [series.points],
  );

  return (
    <section aria-label="Estimated organic traffic over time">
      <header className="mb-3">
        <h2 className="text-base font-semibold">Estimated organic traffic</h2>
        <p className="text-base-content/60 text-sm">
          A model estimate, not a measurement. Every value is labelled with the
          formula that produced it, because{" "}
          <span className="text-base-content/80">
            the model changes on 1 November 2026
          </span>
          .
        </p>
      </header>

      <EtvBoundaryChart data={series.points} />

      {droppedCount > 0 ? (
        <p className="text-base-content/60 mt-2 text-xs">
          {droppedCount} point{droppedCount === 1 ? "" : "s"} withheld from the
          chart because the formula version was not recorded. We would rather
          show a gap than draw a value we cannot attribute.
        </p>
      ) : null}
    </section>
  );
}
