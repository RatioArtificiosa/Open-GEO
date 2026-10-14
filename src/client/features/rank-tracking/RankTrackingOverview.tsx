import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import { getRankConfigTrend } from "@/serverFunctions/rank-tracking";
import {
  formatDateTick,
  TrendRangeToggle,
  useChartWidth,
} from "./RankTrackingTrendChart";
import { useChartMotion } from "@/client/lib/useChartMotion";

/**
 * The rank buckets, and the token each one reads.
 *
 * **Three of these four were raw hex**, which is the CL-816 near-miss exactly:
 * `top3` beside them read `--color-accent`, so a palette change reached one
 * bucket's series and left the other three on the old colours. The buckets then
 * claimed two different brands on one chart, and nothing failed.
 *
 * `notRanking` is the sharpest case: `#6B7280` is the *documented* contrast
 * failure in `styles/app.css` — 4.02:1 on the dark canvas, below AA — and the
 * measured replacement (`--og-text-muted`, #737B88 at 4.56:1) already exists.
 * The fix was on file and this line was still reading the old value, which is
 * what a near-miss means.
 */
const BUCKETS = [
  { key: "top3", label: "Top 3", color: "var(--color-accent, #F59E0B)" },
  {
    key: "top4to10",
    label: "4–10",
    color: "var(--color-success, #34D399)",
  },
  { key: "top11to20", label: "11–20", color: "var(--color-info, #60A5FA)" },
  {
    key: "notRanking",
    label: "Not in top 20",
    color: "var(--og-text-muted, #6B7280)",
  },
] as const;

/** Narrowed recharts tooltip payload entry (typed `any` upstream). */
interface PayloadEntry {
  dataKey?: string | number;
  value?: number | string | null;
}

export function RankTrackingOverview({
  device,
  projectId,
  configId,
}: {
  device: "desktop" | "mobile";
  projectId: string;
  configId: string;
}) {
  const [sinceDays, setSinceDays] = useState(730);
  const chartMotion = useChartMotion();

  const { data: trend, isLoading: trendLoading } = useQuery({
    queryKey: ["rankConfigTrend", projectId, configId, device, sinceDays],
    queryFn: () =>
      getRankConfigTrend({
        data: { projectId, configId, device, sinceDays },
      }),
  });

  const chartData = useMemo(
    () =>
      (trend ?? []).map((p) => ({
        checkedAt: new Date(p.checkedAt).getTime(),
        top3: p.top3,
        top4to10: p.top4to10,
        top11to20: p.top11to20,
        notRanking: p.notRanking,
      })),
    [trend],
  );

  const { containerRef, width } = useChartWidth();

  return (
    <div className="px-4 pt-4 pb-4">
      <div className="rounded-lg border border-base-300 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Position distribution</span>
          <TrendRangeToggle value={sinceDays} onChange={setSinceDays} />
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {BUCKETS.map((b) => (
            <span
              key={b.key}
              className="inline-flex items-center gap-1 text-[11px] text-base-content/60"
            >
              <span
                className="size-2 rounded-sm"
                style={{ backgroundColor: b.color }}
              />
              {b.label}
            </span>
          ))}
        </div>

        {trendLoading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="size-4 animate-spin text-base-content/50" />
          </div>
        ) : chartData.length <= 1 ? (
          <div className="rounded-lg border border-dashed border-base-300 p-8 text-center text-xs text-base-content/60">
            {chartData.length === 0
              ? "No history yet — run a check to start tracking positions over time."
              : "Only 1 check so far — the trend fills in after the next check."}
          </div>
        ) : (
          <div
            ref={containerRef}
            className="w-full min-w-0"
            style={{ height: 220 }}
          >
            {width > 0 ? (
              <AreaChart
                width={width}
                height={220}
                data={chartData}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="currentColor"
                  opacity={0.1}
                  vertical={false}
                />
                <XAxis
                  dataKey="checkedAt"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={formatDateTick}
                  tick={{ fontSize: 10, fill: "var(--trend-axis-color)" }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: "var(--trend-axis-color)" }}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                />
                <Tooltip
                  content={(props: TooltipContentProps<number, string>) => {
                    const { active, payload, label } = props;
                    if (
                      !active ||
                      !payload?.length ||
                      typeof label !== "number"
                    ) {
                      return null;
                    }
                    const byKey = new Map(
                      payload.map((p: PayloadEntry) => [
                        String(p.dataKey),
                        typeof p.value === "number" ? p.value : null,
                      ]),
                    );
                    return <DistributionTooltip label={label} byKey={byKey} />;
                  }}
                  cursor={{ stroke: "var(--trend-grid-color)" }}
                />
                {BUCKETS.map((b) => (
                  <Area
                    key={b.key}
                    type="monotone"
                    dataKey={b.key}
                    name={b.label}
                    stackId="positions"
                    stroke={b.color}
                    fill={b.color}
                    fillOpacity={0.7}
                    {...chartMotion}
                  />
                ))}
              </AreaChart>
            ) : null}
          </div>
        )}
        <p className="text-[11px] text-base-content/50">
          Google positions · DataForSEO rank tracking
        </p>
      </div>
    </div>
  );
}

function DistributionTooltip({
  label,
  byKey,
}: {
  label: number;
  byKey: Map<string, number | null>;
}) {
  return (
    <div className="rounded-md border border-base-300 bg-base-100 px-3 py-2 shadow-sm space-y-0.5">
      <p className="text-xs text-base-content/60">
        {new Date(label).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </p>
      {BUCKETS.map((b) => (
        <p key={b.key} className="text-xs flex items-center gap-1.5">
          <span
            className="size-2 rounded-sm"
            style={{ backgroundColor: b.color }}
          />
          <span className="text-base-content/60">{b.label}:</span>
          <span className="font-medium tabular-nums">
            {byKey.get(b.key) ?? "—"}
          </span>
        </p>
      ))}
    </div>
  );
}
