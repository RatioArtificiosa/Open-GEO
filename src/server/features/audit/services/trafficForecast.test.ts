import { describe, expect, it } from "vitest";
import { forecastTraffic } from "./trafficForecast";

/**
 * The 90-day traffic forecast.
 *
 * The maths is the easy part. What the tests defend is everything around it:
 * the **2026-11-01 ETV cutover** the window straddles, **null weeks** that are
 * not zeros, and the refusal to project a direction from a history too short to
 * have one.
 *
 * `today` is injected precisely so the crossing case is testable — a forecast
 * that silently changes currency halfway across a chart is the failure this
 * whole design exists to prevent, and it cannot be caught by a test that reads
 * the clock.
 */

const BEFORE_CUTOVER = "2026-10-05";
const AFTER_CUTOVER = "2026-11-20";
const TWELVE_WEEKS = [
  100, 104, 102, 110, 108, 115, 112, 120, 118, 125, 122, 130,
];

describe("forecastTraffic", () => {
  it("projects thirteen weeks with a band that widens", () => {
    const result = forecastTraffic({
      history: TWELVE_WEEKS,
      today: AFTER_CUTOVER,
    });
    expect(result.points).toHaveLength(13);
    const first = result.points[0];
    const last = result.points[12];
    // Uncertainty compounds: a thirteen-week claim is not thirteen times more
    // certain than a one-week one, and a constant-width band would say it was.
    const firstWidth = (first?.high ?? 0) - (first?.low ?? 0);
    const lastWidth = (last?.high ?? 0) - (last?.low ?? 0);
    expect(lastWidth).toBeGreaterThan(firstWidth);
  });

  it("never projects below zero, because a negative forecast is nonsense", () => {
    const falling = [
      500, 480, 460, 440, 420, 400, 380, 360, 340, 320, 300, 280,
    ];
    const result = forecastTraffic({ history: falling, today: AFTER_CUTOVER });
    for (const point of result.points) {
      expect(point.expected).toBeGreaterThanOrEqual(0);
      expect(point.low).toBeGreaterThanOrEqual(0);
    }
  });

  it("warns when the window crosses the ETV cutover, and names both dates", () => {
    // The problem that is not the maths. A 91-day window starting 2026-10-05
    // spans 2026-11-01, so its early points are legacy ETV and its late ones are
    // the new formula — and there is no published conversion between them.
    const result = forecastTraffic({
      history: TWELVE_WEEKS,
      provenance: { formulaVersion: "legacy" },
      today: BEFORE_CUTOVER,
    });
    expect(result.basis.crossesCutover).toBe(true);
    expect(result.basis.warning).toMatch(/2026-11-01/);
    expect(result.basis.warning).toMatch(/not comparable across it/i);
    expect(result.summary).toMatch(/cutover warning/i);
  });

  it("does not warn when the whole window sits on one side", () => {
    // The first case was `2026-09-01`, which I expected not to cross — and the
    // test caught that it *does*, because 91 days later is 2026-11-30, well past
    // the cutover. That is the check working: a 13-week window starting five
    // weeks before the boundary straddles it, and only a date close enough to the
    // boundary to end before it escapes.
    const early = forecastTraffic({
      history: TWELVE_WEEKS,
      today: "2026-06-01",
    });
    expect(early.basis.crossesCutover).toBe(false);
    expect(early.basis.warning).toBeNull();

    const after = forecastTraffic({
      history: TWELVE_WEEKS,
      today: AFTER_CUTOVER,
    });
    expect(after.basis.crossesCutover).toBe(false);
    expect(after.basis.warning).toBeNull();
  });

  it("catches a window that only just clears the cutover", () => {
    // The check has to be on the *last* point, not the first. A window starting
    // 2026-10-01 begins before 2026-11-01 but ends after it, and reading only
    // the start would miss exactly the case that matters.
    const result = forecastTraffic({
      history: TWELVE_WEEKS,
      today: "2026-10-01",
    });
    expect(result.basis.crossesCutover).toBe(true);
  });

  it("stamps which ETV formula the answer rests on", () => {
    // Two forecasts computed on different formulas are different products, and a
    // dashboard showing both without saying which is a chart of two currencies.
    const legacy = forecastTraffic({
      history: TWELVE_WEEKS,
      provenance: { formulaVersion: "legacy" },
      today: AFTER_CUTOVER,
    });
    const fresh = forecastTraffic({
      history: TWELVE_WEEKS,
      provenance: { formulaVersion: "new" },
      today: AFTER_CUTOVER,
    });
    expect(legacy.basis.formulaVersion).toBe("legacy");
    expect(fresh.basis.formulaVersion).toBe("new");
    // And it defaults to the conservative answer when the caller does not know.
    const unknown = forecastTraffic({
      history: TWELVE_WEEKS,
      today: AFTER_CUTOVER,
    });
    expect(unknown.basis.formulaVersion).toBe("legacy");
  });

  it("treats a missing week as unmeasured, not as zero", () => {
    // The failure this guards: imputing 0 for a data outage invents a collapse
    // and then projects it forward for three months. The two histories differ by
    // one null, and the forecast must differ only slightly — not halve.
    const withGap = [
      100,
      104,
      null,
      110,
      108,
      115,
      112,
      120,
      118,
      125,
      122,
      130,
    ];
    const without = [
      100, 104, 106, 110, 108, 115, 112, 120, 118, 125, 122, 130,
    ];
    const a = forecastTraffic({ history: withGap, today: AFTER_CUTOVER });
    const b = forecastTraffic({ history: without, today: AFTER_CUTOVER });
    const lastA = a.points[12]?.expected ?? 0;
    const lastB = b.points[12]?.expected ?? 0;
    expect(Math.abs(lastA - lastB)).toBeLessThan(lastB * 0.1);
  });

  it("reports its coverage, including how many weeks it never measured", () => {
    const result = forecastTraffic({
      history: [100, null, 110, null, 115],
      today: AFTER_CUTOVER,
    });
    expect(result.coverage).toMatch(/5 weeks of history, 3 of them measured/i);
  });

  it("declines to project from too little history, and says that is not a zero", () => {
    // Six weeks cannot support a seasonal factor, and a trend from six points is a
    // guess. The honest output is no forecast, not a confident line.
    const result = forecastTraffic({
      history: [100, 102, 101, 103, 100, 102],
      today: AFTER_CUTOVER,
    });
    expect(result.points.every((p) => p.expected === null)).toBe(true);
    expect(result.seasonalFactorApplied).toBe(false);
    expect(result.summary).toMatch(/not a forecast of zero/i);
  });

  it("says no seasonal factor was applied rather than implying one was", () => {
    const result = forecastTraffic({
      history: [100, 102, 101, 103, 100, 102],
      today: AFTER_CUTOVER,
    });
    expect(result.coverage).toMatch(/no seasonal factor was applied/i);
  });

  it("returns no forecast at all from an empty history", () => {
    const result = forecastTraffic({ history: [], today: AFTER_CUTOVER });
    expect(result.points.every((p) => p.expected === null)).toBe(true);
    expect(result.summary).toMatch(/not enough measured history/i);
  });

  it("keeps a rising series rising and a falling one falling", () => {
    // The forecast has to be directionally right, or the band is decoration.
    const rising = forecastTraffic({
      history: TWELVE_WEEKS,
      today: AFTER_CUTOVER,
    });
    expect(rising.points[12]?.expected ?? 0).toBeGreaterThan(
      rising.points[0]?.expected ?? 0,
    );
    const falling = forecastTraffic({
      history: [300, 290, 280, 270, 260, 250, 240, 230, 220, 210, 200, 190],
      today: AFTER_CUTOVER,
    });
    expect(falling.points[12]?.expected ?? 0).toBeLessThan(
      falling.points[0]?.expected ?? 0,
    );
  });

  it("projects flat for a flat history, which is a real finding", () => {
    // Different from "we know nothing": a measured flat series is projected flat.
    const result = forecastTraffic({
      history: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
      today: AFTER_CUTOVER,
    });
    for (const point of result.points) {
      expect(point.expected).toBe(100);
    }
  });

  it("calls its band a range rather than a promise", () => {
    const result = forecastTraffic({
      history: TWELVE_WEEKS,
      today: AFTER_CUTOVER,
    });
    expect(result.summary).toMatch(/not a promise/i);
  });
});
