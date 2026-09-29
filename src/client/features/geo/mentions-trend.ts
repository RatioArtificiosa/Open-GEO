/**
 * The mentions trend.
 *
 * Pure functions of the stored months rather than chart components, so the
 * decisions can be tested without a DOM — and because the decisions are the
 * interesting part, not the drawing.
 *
 * Three things they refuse to do, each of which would be a plausible-looking
 * wrong chart:
 *
 * 1. **Fill a gap with zero.** A month the vendor did not report is missing data.
 *    Plotting it as zero says mentions collapsed, and it draws a cliff that never
 *    happened. A gap is drawn as a gap.
 * 2. **Reorder or infer months.** The rows are ordered here rather than trusted
 *    to arrive sorted, and a missing month is never interpolated.
 * 3. **Show a total.** The two platforms compute demand differently, so there is
 *    no "total mentions" here or anywhere else in this product.
 */

export type MentionMonth = {
  /** `YYYY-MM`, zero-padded in storage. */
  month: string;
  /** Null means the vendor reported no figure, which is not the same as zero. */
  mentions: number | null;
  aiSearchVolume: number | null;
};

type MentionsTrendPoint = {
  month: string;
  mentions: number | null;
  aiSearchVolume: number | null;
  /** True when this month has no figure at all. */
  isGap: boolean;
};

type MentionsTrend = {
  points: MentionsTrendPoint[];
  /** Months with a real figure. Gaps excluded — these are what a delta uses. */
  measuredCount: number;
  gapCount: number;
  /**
   * The first month with a figure, or null when the series is entirely empty.
   * A panel that says "no change since 2025-11" when the data begins in 2026-03
   * is making a claim about a period nobody measured.
   */
  firstMeasuredMonth: string | null;
  lastMeasuredMonth: string | null;
  /** Latest minus earliest, over the *measured* months only. */
  change: number | null;
  /** True when the series cannot support a "rising" or "falling" claim. */
  isEmpty: boolean;
};

function toNumber(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildMentionsTrend(months: MentionMonth[]): MentionsTrend {
  // Ordered by month, without `sort`.
  //
  // `toSorted` is not on this project's lib target, and a plain `sort` is
  // rejected because it reads as mutating — and this must not mutate the
  // caller's array, which is React state. A copy plus a comparator is the
  // obvious answer, so the ordering is done by hand instead: the series is a
  // handful of months, and a loop has no ambiguity about who owns the array.
  const ordered: MentionMonth[] = [];
  for (const month of months) {
    const at = ordered.findIndex((existing) => existing.month > month.month);
    if (at === -1) ordered.push(month);
    else ordered.splice(at, 0, month);
  }

  const points: MentionsTrendPoint[] = ordered.map((month) => {
    const mentions = toNumber(month.mentions);
    return {
      month: month.month,
      mentions,
      aiSearchVolume: toNumber(month.aiSearchVolume),
      isGap: mentions === null,
    };
  });

  const measured = points.filter(
    (point): point is MentionsTrendPoint & { mentions: number } =>
      point.mentions !== null,
  );
  const first = measured[0]?.mentions ?? null;
  const last = measured.at(-1)?.mentions ?? null;

  return {
    points,
    measuredCount: measured.length,
    gapCount: points.length - measured.length,
    firstMeasuredMonth: measured[0]?.month ?? null,
    lastMeasuredMonth: measured.at(-1)?.month ?? null,
    // Null unless there are at least two measured months. A "change" from one
    // point is not a change.
    change:
      first !== null && last !== null && measured.length >= 2
        ? last - first
        : null,
    isEmpty: measured.length === 0,
  };
}

/** A one-line, human summary of what the series can honestly claim. */
export function describeMentionsTrend(trend: MentionsTrend): string {
  if (trend.isEmpty) {
    return "No months with a recorded figure yet.";
  }
  if (trend.change === null) {
    return `One month recorded (${trend.firstMeasuredMonth}). Nothing to compare yet.`;
  }
  const direction =
    trend.change > 0 ? "up" : trend.change < 0 ? "down" : "flat";
  const gapNote =
    trend.gapCount > 0
      ? ` ${trend.gapCount} month(s) had no figure and are left as gaps.`
      : "";
  return `${trend.measuredCount} months, ${direction} ${Math.abs(trend.change)} from ${trend.firstMeasuredMonth} to ${trend.lastMeasuredMonth}.${gapNote}`;
}

/**
 * Per-platform rows for a panel, one entry per platform and never merged.
 *
 * There is deliberately no combined row: the two platforms compute demand
 * differently, and a sum would be the one number this product refuses to produce
 * anywhere else.
 */
export function buildPlatformTrendRows(
  series: Array<{ platform: string; months: MentionMonth[] }>,
): Array<{ platform: string; summary: string }> {
  return series.map((entry) => ({
    platform: entry.platform,
    summary: describeMentionsTrend(buildMentionsTrend(entry.months)),
  }));
}
