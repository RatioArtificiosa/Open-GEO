import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildMentionsTrend,
  describeMentionsTrend,
  type MentionMonth,
} from "./mentions-trend";
import { MetricFootnote } from "./LivePanels";

/**
 * The mentions trend panel, per platform.
 *
 * One chart per platform, never one chart for both. The panel receives the
 * months for a single platform and draws them; deciding *which* numbers may sit
 * on that chart is `buildMentionsTrend`'s job, not this file's, and the two are
 * tested independently.
 *
 * The gap handling is the point. A month with no figure produces no point at
 * all, so the line breaks rather than dropping to zero — a zero would draw a
 * cliff and say traffic collapsed, which is a different claim from "we did not
 * measure it".
 */

const PLATFORM_LABELS: Record<string, string> = {
  chat_gpt: "ChatGPT",
  google_ai_overview: "Google AI Overview",
  gemini: "Gemini",
  perplexity: "Perplexity",
};

function labelFor(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/** Recharts types the tooltip payload loosely; narrow it to the month key. */
function monthOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const month: unknown = Reflect.get(payload, "month");
  return typeof month === "string" ? month : "";
}

function formatMonth(value: string): string {
  // `YYYY-MM` → `Mon` on the axis. The year is in the tooltip and the caption,
  // because an axis reading "Jan Feb Mar" across a year boundary is a trap.
  const parsed = new Date(`${value}-01T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
}

export function MentionsTrendPanel({
  platform,
  months,
  height = 180,
}: {
  platform: string;
  months: MentionMonth[];
  height?: number;
}) {
  const trend = buildMentionsTrend(months);
  const summary = describeMentionsTrend(trend);

  if (trend.isEmpty) {
    return (
      <section className="rounded-xl border border-base-300 bg-base-100 p-4">
        <h3 className="inline-flex items-center gap-1.5 text-base font-semibold">
          {labelFor(platform)}
          <MetricFootnote id="mentions" />
        </h3>
        <p className="text-base-content/60 text-sm">
          No months with a recorded figure yet. The first patrol fills the
          series from the vendor&apos;s own history, so this fills shortly after
          the brand is added.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4">
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-base font-semibold">
          {labelFor(platform)}
          {/* Comparable across platforms, but still a count of answers rather
              than traffic — which costs one icon to say. */}
          <MetricFootnote id="mentions" />
        </h3>
        {trend.change !== null ? (
          <span
            className="text-sm font-medium"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {trend.change > 0 ? "+" : ""}
            {trend.change.toLocaleString()} mentions
          </span>
        ) : null}
      </header>

      <LineChart
        width={0}
        height={height}
        data={trend.points}
        margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
        aria-label={`${labelFor(platform)} mentions by month`}
        className="h-auto w-full"
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="currentColor"
          opacity={0.12}
        />
        <XAxis dataKey="month" tickFormatter={formatMonth} minTickGap={16} />
        <YAxis
          tickFormatter={(value: number) => value.toLocaleString()}
          width={56}
          style={{ fontVariantNumeric: "tabular-nums" }}
        />
        <Tooltip
          labelFormatter={(value) => String(value)}
          formatter={(value, _name, item) => [
            typeof value === "number" ? value.toLocaleString() : "no figure",
            // The month is spelled out here, not abbreviated on the axis, so a
            // reader can tell 2026-01 from 2025-01 without hovering twice.
            monthOf(item?.payload),
          ]}
        />
        {/* The first measured month, so a reader can see where the data begins
            rather than assuming the left edge is the start of their history. */}
        {trend.firstMeasuredMonth ? (
          <ReferenceLine
            x={trend.firstMeasuredMonth}
            stroke="currentColor"
            strokeDasharray="2 3"
            opacity={0.35}
            label={{
              value: "first measured",
              position: "insideTopLeft",
              fill: "currentColor",
              fontSize: 10,
            }}
          />
        ) : null}
        <Line
          type="monotone"
          dataKey="mentions"
          // `connectNulls` stays false: a missing month breaks the line instead
          // of drawing a straight line through a measurement we do not have.
          connectNulls={false}
          stroke="var(--color-accent, #F59E0B)"
          strokeWidth={2}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
      </LineChart>

      <p className="text-base-content/70 mt-2 text-xs">{summary}</p>
    </section>
  );
}
