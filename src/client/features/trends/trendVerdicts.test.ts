import { describe, expect, it } from "vitest";
import type { ChartSeries } from "./trendChartModel";
import { trendVerdictsFor } from "./trendVerdicts";

/**
 * Verdicts over the charted lines (CL-722/716 surfaces).
 *
 * The engines are tested on their own; this file pins the *join* — the chart
 * model hands the engines the values they were promised (nulls for gaps,
 * oldest-first), and the verdicts a reader sees rest on the lines drawn
 * above them rather than on a second request for the same window.
 */

const series = (
  keyword: string,
  values: Array<number | null>,
): ChartSeries => ({
  keyword,
  average: null,
  points: values.map((value, index) => ({
    dateFrom: `2026-01-${String(index + 1).padStart(2, "0")}`,
    dateTo: null,
    value,
    heightPct: value === null ? null : value,
    unmeasured: value === null,
  })),
});

describe("trendVerdictsFor", () => {
  it("calls a sustained climb accelerating with a breakout candidate", () => {
    const climb = Array.from({ length: 30 }, (_, i) =>
      Math.round(20 + i * 2.5),
    );
    const [verdict] = trendVerdictsFor([series("standing desk", climb)]);
    expect(verdict?.keyword).toBe("standing desk");
    expect(verdict?.momentum.direction).toBe("accelerating");
    expect(verdict?.momentum.basis).toBe("measured");
    expect(verdict?.breakout.pointsMeasured).toBe(30);
  });

  it("reads a flat line as steady, not as a breakout", () => {
    const flat = Array.from({ length: 30 }, () => 50);
    const [verdict] = trendVerdictsFor([series("stapler", flat)]);
    expect(verdict?.momentum.direction).toBe("steady");
    expect(verdict?.breakout.isBreakoutCandidate).toBe(false);
  });

  it("reports a lone spike as the event it is, with its persistence visible", () => {
    const spike = Array.from({ length: 30 }, (_, i) => (i === 15 ? 100 : 20));
    const [verdict] = trendVerdictsFor([series("fidget", spike)]);
    // A mean would read the spike's window as a climb; the median must not.
    expect(verdict?.momentum.direction).not.toBe("accelerating");
    // The tallest thing in its window, reported as the event it is.
    expect(verdict?.breakout.peakDate).toBe("2026-01-16");
    expect(verdict?.breakout.isBreakoutCandidate).toBe(false);
  });

  it("declines honestly on windows too short for a verdict", () => {
    const short = [10, 12, 11];
    const [verdict] = trendVerdictsFor([series("new thing", short)]);
    expect(verdict?.momentum.direction).toBeNull();
    expect(verdict?.momentum.basis).toBe("too-little-history");
    // Breakout needs a year plus a quarter for its YoY half.
    expect(verdict?.breakout.yoyChangePercent).toBeNull();
  });

  it("keeps unmeasured points out of both engines", () => {
    const gappy = [40, null, 42, null, 44, 46, 48, 50, 52, 54];
    const [verdict] = trendVerdictsFor([series("gappy", gappy)]);
    expect(verdict?.momentum.pointsMeasured).toBe(8);
    expect(verdict?.breakout.pointsMeasured).toBe(8);
  });
});
