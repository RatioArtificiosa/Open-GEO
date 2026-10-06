import { useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BacklinksOverviewData } from "./backlinksPageTypes";
import {
  formatCompactDate,
  formatMonthLabel,
  formatTooltipValue,
} from "./backlinksPageUtils";

export function BacklinksTrendChart({
  data,
}: {
  data: BacklinksOverviewData["trends"];
}) {
  const { containerRef, chartWidth } = useChartWidth();

  if (data.length === 0) {
    return <EmptyChartState />;
  }

  return (
    <div>
      <div
        ref={containerRef}
        className="h-56 min-w-0"
        aria-label="Backlink trend chart"
      >
        {chartWidth > 0 ? (
          <LineChart
            width={chartWidth}
            height={224}
            data={data}
            margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="currentColor"
              opacity={0.12}
            />
            <XAxis
              dataKey="date"
              tickFormatter={formatChartTick}
              minTickGap={24}
            />
            <YAxis
              yAxisId="left"
              tickFormatter={formatAxisValue}
              width={60}
              label={{ value: "Backlinks", angle: -90, position: "insideLeft" }}
              style={{ fontVariantNumeric: "tabular-nums" }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={formatAxisValue}
              width={60}
              label={{
                value: "Referring domains",
                angle: 90,
                position: "insideRight",
              }}
              style={{ fontVariantNumeric: "tabular-nums" }}
            />
            <Tooltip
              formatter={formatTooltipValue}
              labelFormatter={formatChartLabel}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="backlinks"
              stroke="var(--color-accent, #F59E0B)"
              strokeWidth={2}
              dot={false}
              name="Backlinks"
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="referringDomains"
              stroke="#34D399"
              strokeWidth={2}
              dot={false}
              name="Referring domains"
            />
          </LineChart>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-base-content/50">
        DataForSEO backlinks · daily over the last year
      </p>
    </div>
  );
}

/** Gain and loss are the one place a status pair is the honest encoding. */
const NEW_LOST_SERIES = [
  { label: "New backlinks", color: "#34D399" },
  { label: "Lost backlinks", color: "#F87171" },
] as const;

export function BacklinksNewLostChart({
  data,
}: {
  data: BacklinksOverviewData["newLostTrends"];
}) {
  const { containerRef, chartWidth } = useChartWidth();

  if (data.length === 0) {
    return <EmptyChartState />;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
        {NEW_LOST_SERIES.map((s) => (
          <span
            key={s.label}
            className="inline-flex items-center gap-1 text-[11px] text-base-content/60"
          >
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            {s.label}
          </span>
        ))}
      </div>
      <div
        ref={containerRef}
        className="h-56 min-w-0"
        aria-label="New and lost backlinks chart"
      >
        {chartWidth > 0 ? (
          <LineChart
            width={chartWidth}
            height={224}
            data={data}
            margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="currentColor"
              opacity={0.12}
            />
            <XAxis
              dataKey="date"
              tickFormatter={formatChartTick}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={formatAxisValue}
              width={60}
              label={{ value: "Links", angle: -90, position: "insideLeft" }}
              style={{ fontVariantNumeric: "tabular-nums" }}
            />
            <Tooltip
              formatter={formatTooltipValue}
              labelFormatter={formatChartLabel}
            />
            <Line
              type="monotone"
              dataKey="lostBacklinks"
              stroke="#F87171"
              strokeWidth={2}
              dot={false}
              name="Lost backlinks"
            />
            <Line
              type="monotone"
              dataKey="newBacklinks"
              stroke="#34D399"
              strokeWidth={2}
              dot={false}
              name="New backlinks"
            />
          </LineChart>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-base-content/50">
        DataForSEO backlinks · daily over the last year
      </p>
    </div>
  );
}

function useChartWidth() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [chartWidth, setChartWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateWidth = () => {
      setChartWidth(container.clientWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  return { containerRef, chartWidth };
}

function EmptyChartState() {
  return (
    <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-base-300 text-sm text-base-content/55">
      Not enough historical data yet.
    </div>
  );
}

function formatAxisValue(value: unknown) {
  if (typeof value !== "number") return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function formatChartTick(value: unknown) {
  return typeof value === "string" ? formatMonthLabel(value) : "";
}

function formatChartLabel(value: unknown) {
  return typeof value === "string" ? formatCompactDate(value) : "";
}
