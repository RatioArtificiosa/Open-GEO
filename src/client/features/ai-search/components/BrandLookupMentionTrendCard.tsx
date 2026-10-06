import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCount } from "@/client/features/ai-search/platformLabels";
import type { BrandLookupResult } from "@/types/schemas/ai-search";
import { useChartMotion } from "@/client/lib/useChartMotion";

type Props = {
  result: BrandLookupResult;
};

export function BrandLookupMentionTrendCard({ result }: Props) {
  const chartMotion = useChartMotion();
  const chartData = useMemo(
    () =>
      result.monthlyVolume.map((entry) => ({
        label: `${entry.year}-${String(entry.month).padStart(2, "0")}`,
        // A month with no recorded volume is a gap, not a zero. Drawing it at
        // zero says search collapsed, which is a different claim from "we did
        // not measure it". DESIGN.md §6.
        volume: entry.volume ?? null,
      })),
    [result.monthlyVolume],
  );

  if (chartData.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center px-6 text-center text-sm text-base-content/60">
        No monthly volumes yet. The vendor reports them per prompting mention,
        so this fills once a prompt that mentions the brand carries a history.
      </div>
    );
  }

  return (
    <div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 12, right: 12, bottom: 4, left: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="currentColor"
              opacity={0.12}
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--trend-axis-color)" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--trend-axis-color)" }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              style={{ fontVariantNumeric: "tabular-nums" }}
            />
            <Tooltip
              content={<MentionTooltip />}
              cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
            />
            <Line
              type="monotone"
              dataKey="volume"
              stroke="var(--color-accent, #F59E0B)"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              {...chartMotion}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {/* §5.3.3 — an unlabelled estimate is a measurement, and that is a lie. */}
      <p className="mt-2 text-[11px] text-base-content/50">
        ≈ Monthly search volume of the prompts that mentioned the brand — the
        vendor&rsquo;s estimate, not a measured count.
      </p>
    </div>
  );
}

function MentionTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number | null }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const value = payload[0].value;
  return (
    <div className="rounded-md border border-base-300 bg-base-100 px-3 py-2 shadow-sm">
      <p className="text-xs text-base-content/60">{label}</p>
      <p className="text-sm font-medium tabular-nums">
        {value === null
          ? "no figure"
          : `${formatCount(value)} monthly searches`}
      </p>
    </div>
  );
}
