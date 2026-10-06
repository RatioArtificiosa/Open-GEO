import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ETV_CUTOVER_DATE } from "@/shared/etv-versioning";
import { buildEtvSeriesView, type EtvPoint } from "./etv-series-view";
import { useChartMotion } from "@/client/lib/useChartMotion";

/**
 * An ETV trend with the formula change drawn on it.
 *
 * This component exists to make one claim true: most tools' traffic charts
 * break silently on 2026-11-01, and ours does not. The claim is only credible
 * if the boundary is *visible* — a reader who sees a step must be able to tell
 * whether it was traffic or methodology.
 *
 * What is plotted and what is said both come from `buildEtvSeriesView`, which
 * holds the three exclusions (unknown value, unknown model, mixed series) and is
 * tested on its own. This file only draws what that function allows.
 */

export type EtvChartPoint = EtvPoint;

/** Narrow Recharts' loosely-typed tooltip payload to our point's model field. */
function isNewModel(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return Reflect.get(payload, "formulaVersion") === "new";
}

export function EtvBoundaryChart({
  data,
  label = "Estimated organic traffic",
  height = 224,
}: {
  data: EtvChartPoint[];
  label?: string;
  height?: number;
}) {
  const chartMotion = useChartMotion();
  const view = useMemo(() => buildEtvSeriesView(data), [data]);
  const { points: plotted, caveat, showBoundary, isEmpty } = view;

  if (isEmpty) {
    return (
      <p className="text-base-content/60 text-sm">
        No estimated traffic recorded yet. Once a patrol has run, the series
        appears here with the source and the model that produced each value.
      </p>
    );
  }

  return (
    <figure className="min-w-0">
      <LineChart
        width={0}
        height={height}
        data={plotted}
        margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
        aria-label={label}
        className="h-auto w-full"
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="currentColor"
          opacity={0.12}
        />
        <XAxis
          dataKey="date"
          tickFormatter={(value: string) => value.slice(0, 10)}
          minTickGap={24}
        />
        {/* Tabular figures: a value that shifts a pixel when it updates reads
            as a different value. See DESIGN.md §3.2. */}
        <YAxis
          tickFormatter={(value: number) => value.toLocaleString()}
          width={72}
          style={{ fontVariantNumeric: "tabular-nums" }}
        />
        <Tooltip
          labelFormatter={(value) => String(value).slice(0, 10)}
          // Recharts types the formatter's value as possibly-undefined, so the
          // narrowing is explicit rather than assumed.
          formatter={(value, _name, item) => [
            typeof value === "number"
              ? value.toLocaleString()
              : String(value ?? ""),
            // The model is in the tooltip, so a reader can check a point rather
            // than trusting the aggregate caveat. Recharts types the payload
            // loosely, so the read is narrowed explicitly.
            isNewModel(item?.payload)
              ? "ETV (new model)"
              : "ETV (legacy model)",
          ]}
        />
        {/* The boundary is drawn only when a series actually crosses it, so a
            chart entirely on one model stays clean. */}
        {showBoundary ? (
          <ReferenceLine
            x={ETV_CUTOVER_DATE}
            stroke="var(--color-accent, #F59E0B)"
            strokeDasharray="4 3"
            strokeWidth={1.5}
            label={{
              value: "ETV model changed",
              position: "insideTopRight",
              fill: "currentColor",
              fontSize: 11,
            }}
          />
        ) : null}
        <Line
          type="monotone"
          dataKey="etv"
          stroke="var(--color-accent, #F59E0B)"
          strokeWidth={2}
          dot={false}
          {...chartMotion}
        />
      </LineChart>
      {caveat ? (
        <figcaption className="text-base-content/70 mt-2 text-xs">
          {caveat}
        </figcaption>
      ) : null}
    </figure>
  );
}
