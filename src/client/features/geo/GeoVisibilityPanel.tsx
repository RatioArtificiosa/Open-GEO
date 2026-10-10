import { useMemo } from "react";
import { EtvBoundaryChart, type EtvChartPoint } from "./EtvBoundaryChart";
import { ETV_CUTOVER_DATE } from "@/shared/etv-versioning";
import { MetricFootnote } from "./LivePanels";

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

/**
 * The cutover date, written the way a person says it.
 *
 * Formatted from `ETV_CUTOVER_DATE` rather than typed into the copy above. A
 * hardcoded date in prose is a second source of truth that outlives the constant
 * it mirrors, and this one is quoted on the homepage.
 */
const CUTOVER_LABEL = new Date(
  `${ETV_CUTOVER_DATE}T00:00:00Z`,
).toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

type GeoVisibilitySeries = {
  /** Points carrying their own formula version. */
  points: EtvChartPoint[];
  /**
   * Whether the archive holds points whose formula version was never recorded.
   *
   * **Derived by the caller, because only the caller can see the whole
   * archive.** The points handed to this panel are already the *plottable* ones
   * — `buildEtvSeriesView` in the chart drops the unattributable ones — so
   * counting the nulls here sees only the survivors and reports zero withheld
   * for a series that had three. The first version of this prop therefore
   * existed, was documented, was passed by the page, and changed nothing: a
   * prop that no code reads is the same bug as a prop no caller passes, and
   * it hides better because the type says it is wired.
   *
   * `undefined` means "the caller did not check", which falls back to
   * deriving from the points — the honest answer when nobody knows better.
   */
  hasUnstampedPoints?: boolean;
};

export function GeoVisibilityPanel({
  series,
}: {
  series: GeoVisibilitySeries;
}) {
  /**
   * Prefer the caller's count, fall back to deriving it.
   *
   * Both are reported, because they answer different questions: the derived
   * count is "these specific plotted points lack provenance", the caller's
   * flag is "the archive has points we refused to draw". A chart that shows
   * only the first reads as complete while data sits behind it.
   */
  const droppedCount = useMemo(() => {
    const derived = series.points.filter(
      (point) => point.etv === null || point.formulaVersion === null,
    ).length;
    return series.hasUnstampedPoints ? Math.max(derived, 1) : derived;
  }, [series.points, series.hasUnstampedPoints]);

  return (
    <section aria-label="Estimated organic traffic over time">
      <header className="mb-3">
        <h2 className="inline-flex items-center gap-1.5 text-base font-semibold">
          Estimated organic traffic
          {/* A model estimate, not analytics. The footnote also names the date
              the model changed, which is the thing a reader will look up. */}
          <MetricFootnote id="etv" />
        </h2>
        <p className="text-base-content/60 text-sm">
          A model estimate, not a measurement. Every value is labelled with the
          formula that produced it, because{" "}
          <span className="text-base-content/80">
            the model changes on {CUTOVER_LABEL}
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
