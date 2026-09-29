import { describe, expect, it } from "vitest";
import {
  buildMentionsTrend,
  buildPlatformTrendRows,
  describeMentionsTrend,
  type MentionMonth,
} from "./mentions-trend";

/**
 * The mentions trend.
 *
 * The product claim this protects is narrow and checkable: a reader looking at
 * this chart must be able to tell the difference between "we did not measure
 * this month" and "we measured zero". Every test here is one of those two
 * sentences failing.
 */

const measured = (month: string, mentions: number): MentionMonth => ({
  month,
  mentions,
  aiSearchVolume: mentions * 100,
});

const gap = (month: string): MentionMonth => ({
  month,
  mentions: null,
  aiSearchVolume: null,
});

describe("buildMentionsTrend", () => {
  it("keeps a month with no figure as a gap rather than plotting it as zero", () => {
    // Plotting null as 0 would draw a cliff and say traffic collapsed, which is
    // a different claim from "we did not measure this month".
    const trend = buildMentionsTrend([
      measured("2026-01", 10),
      gap("2026-02"),
      measured("2026-03", 12),
    ]);
    expect(trend.points.map((p) => p.isGap)).toEqual([false, true, false]);
    expect(trend.points[1]?.mentions).toBeNull();
  });

  it("counts gaps separately from months with a figure", () => {
    const trend = buildMentionsTrend([
      measured("2026-01", 10),
      gap("2026-02"),
      measured("2026-03", 12),
    ]);
    expect(trend.measuredCount).toBe(2);
    expect(trend.gapCount).toBe(1);
  });

  it("computes the change over measured months only", () => {
    // If a gap were treated as zero, the change would be -5 instead of +2.
    const trend = buildMentionsTrend([
      measured("2026-01", 10),
      gap("2026-02"),
      measured("2026-03", 12),
    ]);
    expect(trend.change).toBe(2);
  });

  it("returns a null change for a single measured month", () => {
    // One point is not a change. A "0 change" here would look like a flat trend.
    const trend = buildMentionsTrend([measured("2026-01", 10), gap("2026-02")]);
    expect(trend.change).toBeNull();
  });

  it("returns a null change for an empty series rather than zero", () => {
    // Zero would render as "no change", which is a claim about a period with no
    // measurements in it.
    const trend = buildMentionsTrend([]);
    expect(trend.isEmpty).toBe(true);
    expect(trend.change).toBeNull();
    expect(trend.firstMeasuredMonth).toBeNull();
  });

  it("treats a series of only gaps as empty", () => {
    const trend = buildMentionsTrend([gap("2026-01"), gap("2026-02")]);
    expect(trend.isEmpty).toBe(true);
    expect(trend.measuredCount).toBe(0);
  });

  it("orders months chronologically regardless of input order", () => {
    // Storage already sorts, but the output must not depend on that: a caller
    // that reorders its input should not get a different chart.
    const trend = buildMentionsTrend([
      measured("2026-03", 12),
      measured("2026-01", 10),
      measured("2026-02", 11),
    ]);
    expect(trend.points.map((p) => p.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(trend.change).toBe(2);
  });

  it("sorts zero-padded months as text, which is why storage pads them", () => {
    // "2026-1" < "2025-12" as a string, so an unpadded key would put January
    // 2026 before December 2025. This test is the other half of that decision.
    const trend = buildMentionsTrend([
      measured("2026-01", 12),
      measured("2025-12", 10),
    ]);
    expect(trend.points.map((p) => p.month)).toEqual(["2025-12", "2026-01"]);
  });

  it("treats a non-finite figure as a gap rather than a number", () => {
    // NaN in a chart becomes a broken line, and Infinity becomes a spike that
    // flattens every other month.
    const trend = buildMentionsTrend([
      { month: "2026-01", mentions: Number.NaN, aiSearchVolume: null },
      measured("2026-02", 10),
    ]);
    expect(trend.points[0]?.isGap).toBe(true);
    expect(trend.measuredCount).toBe(1);
  });

  it("reports the first and last measured month, not the ends of the array", () => {
    const trend = buildMentionsTrend([
      gap("2025-12"),
      measured("2026-01", 10),
      measured("2026-03", 12),
      gap("2026-04"),
    ]);
    expect(trend.firstMeasuredMonth).toBe("2026-01");
    expect(trend.lastMeasuredMonth).toBe("2026-03");
  });
});

describe("describeMentionsTrend", () => {
  it("says plainly when there is nothing to compare", () => {
    const text = describeMentionsTrend(
      buildMentionsTrend([measured("2026-01", 10)]),
    );
    expect(text).toMatch(/Nothing to compare yet/i);
  });

  it("mentions the gap count when months are missing", () => {
    const text = describeMentionsTrend(
      buildMentionsTrend([
        measured("2026-01", 10),
        gap("2026-02"),
        measured("2026-03", 12),
      ]),
    );
    // A reader who sees "+2" and does not know a month was skipped would read
    // it as a complete picture.
    expect(text).toMatch(/no figure and are left as gaps/i);
  });

  it("names the direction and the window", () => {
    const text = describeMentionsTrend(
      buildMentionsTrend([measured("2026-01", 10), measured("2026-03", 15)]),
    );
    expect(text).toMatch(/up 5 from 2026-01 to 2026-03/);
  });
});

describe("buildPlatformTrendRows", () => {
  it("keeps one row per platform and never totals them", () => {
    const rows = buildPlatformTrendRows([
      {
        platform: "chat_gpt",
        months: [measured("2026-01", 10), measured("2026-02", 12)],
      },
      {
        platform: "google_ai_overview",
        months: [measured("2026-01", 9000), measured("2026-02", 12000)],
      },
    ]);
    expect(rows).toHaveLength(2);
    // No combined row exists, by design: the two compute demand differently and
    // a sum would be the one number this product refuses to produce.
    expect(rows.some((row) => row.platform === "combined")).toBe(false);
    expect(rows.map((row) => row.platform)).toEqual([
      "chat_gpt",
      "google_ai_overview",
    ]);
  });

  it("still produces a row for a platform with no data, so it is visibly empty", () => {
    const rows = buildPlatformTrendRows([{ platform: "chat_gpt", months: [] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toMatch(/No months with a recorded figure/i);
  });
});
