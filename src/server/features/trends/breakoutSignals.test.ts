import { describe, expect, it } from "vitest";
import { breakoutSignals, type BreakoutPoint } from "./breakoutSignals";

/**
 * The Breakout Detector's verdicts, and the blips it must refuse to name.
 *
 * The product failure this suite exists to prevent is a dashboard that calls
 * every spike a breakout: by the third one nobody believes the fourth. So the
 * negative controls below are the point of the file, not garnish.
 */

/** A dated series from a plain value list, one step per entry. */
function dated(
  values: Array<number | null>,
  start = "2026-01-05",
): BreakoutPoint[] {
  const startAt = Date.parse(`${start}T00:00:00Z`);
  return values.map((value, i) => ({
    date: new Date(startAt + i * 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    value,
  }));
}

/** Flat, then a steep sustained climb — the breakout shape. */
const breakout = [
  ...Array.from({ length: 12 }, () => 40),
  ...Array.from({ length: 13 }, (_, i) => 40 + i * 5),
  ...Array.from({ length: 15 }, () => 104),
];

/** Flat, then a two-step spike, then flat — the blip shape. */
const blip = [
  ...Array.from({ length: 26 }, () => 40),
  100,
  100,
  ...Array.from({ length: 14 }, () => 40),
];

/** A slow drift that acquires a peak without ever climbing. */
const drift = Array.from({ length: 40 }, (_, i) => 40 + i * 0.5);

describe("breakoutSignals", () => {
  it("names a steep sustained climb a breakout candidate", () => {
    const result = breakoutSignals("ai visibility", dated(breakout));
    expect(result.isBreakoutCandidate).toBe(true);
    expect(result.stillAboveBaseline).toBe(true);
    expect(result.climbRatePerStep ?? 0).toBeGreaterThanOrEqual(2);
    expect(result.peakDate).not.toBeNull();
    expect(result.summary).toMatch(/breakout candidate/);
    expect(result.summary).toMatch(/holds above its earlier level/);
    // The caveat travels with the answer: the scores are one request's ruler.
    expect(result.caveat).toMatch(/relative to the biggest peak/);
  });

  it("refuses a spike that returned, whatever its height", () => {
    // **The negative control the whole module exists for.** A two-step spike to
    // 100 is the tallest thing in the window and is not a breakout: the
    // level held for two steps, and a verdict that ignored the persistence
    // half would name it. A one-signal implementation passes the breakout case
    // above and fails here.
    const result = breakoutSignals("documentary title", dated(blip));
    expect(result.isBreakoutCandidate).toBe(false);
    expect(result.persistenceSteps).toBe(2);
    expect(result.stillAboveBaseline).toBe(false);
    expect(result.summary).toMatch(/held that level for 2 steps/);
  });

  it("refuses a peak acquired by drift", () => {
    // The other negative control: the series ends at its highest point ever and
    // is still above its baseline, so persistence alone would pass it. It never climbed
    // — half a point per step is a level change over months, not a breakout,
    // and the threshold is on the rate for exactly this shape.
    const result = breakoutSignals("slow riser", dated(drift));
    expect(result.isBreakoutCandidate).toBe(false);
    expect(result.climbRatePerStep ?? 0).toBeLessThan(2);
  });

  it("reports no year-over-year figure from a short window, and says why", () => {
    // "Up 40% on last quarter" and "up 40% year over year" are different
    // claims. A 90-day window answers the first, and reporting it under the
    // second name is the kind of confident arithmetic this product refuses.
    const result = breakoutSignals("short window", dated(breakout));
    expect(result.yoyChangePercent).toBeNull();
    expect(result.summary).toMatch(/shorter than a year plus a quarter/);
  });

  it("reports a year-over-year figure when the window holds a year", () => {
    // 65 weekly points: a flat first year at 40, then a sustained lift to 80 —
    // the recent quarter against the same quarter a year earlier is +100%.
    const values = [
      ...Array.from({ length: 52 }, () => 40),
      ...Array.from({ length: 13 }, (_, i) => 60 + i),
    ];
    const result = breakoutSignals("lifted", dated(values));
    expect(result.yoyChangePercent).not.toBeNull();
    expect(result.yoyChangePercent ?? 0).toBeGreaterThan(50);
    expect(result.summary).toMatch(/Year over year it runs \+\d+%/);
  });

  it("keeps a missing point out of every signal rather than reading it as zero", () => {
    // A null is a point the vendor did not measure. Imputing zero would drag
    // the climb rate down and fabricate a collapse in the persistence count.
    const withGap: Array<number | null> = [...breakout];
    withGap[15] = null;
    const gapped = breakoutSignals("gapped", dated(withGap));
    const clean = breakoutSignals("clean", dated(breakout));
    expect(gapped.pointsMeasured).toBe(clean.pointsMeasured - 1);
    expect(gapped.isBreakoutCandidate).toBe(true);
  });

  it("reports no breakout when nothing was measured", () => {
    const result = breakoutSignals("silent", dated([null, null, null]));
    expect(result.isBreakoutCandidate).toBe(false);
    expect(result.summary).toMatch(/not a flat result/);
  });

  it("names the peak by the caller's date", () => {
    const result = breakoutSignals("dated", dated(blip));
    // The peak is the first of the two equal maxima — the one the climb leads
    // into, so the date answers "when did it top".
    expect(result.peakDate).not.toBeNull();
    expect(dated(blip)[26]?.date).toBe(result.peakDate);
  });
});
