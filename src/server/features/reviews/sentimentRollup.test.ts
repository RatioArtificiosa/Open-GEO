import { describe, expect, it } from "vitest";
import { rollupReviewSentiment } from "./sentimentRollup";

/**
 * Sentiment rollup: aggregate-only means aggregate-only (CL-504).
 *
 * The module never sees a name, a URL, or a review text — the inputs are
 * platform, value, and max. Every assertion below is about what the average
 * refuses: unrated rows, out-of-scale values, and cross-scale raw averaging.
 * A 4.2 averaged with a 4.2 from different denominators is refused, not
 * rendered — the row's own semantic, enforced by keeping denominators
 * per platform.
 */

describe("rollupReviewSentiment", () => {
  it("averages per platform on a 0-5 scale with the denominator beside it", () => {
    const rollup = rollupReviewSentiment([
      { platform: "trustpilot", value: 5, max: 5 },
      { platform: "trustpilot", value: 4, max: 5 },
      { platform: "tripadvisor", value: 3, max: 5 },
    ]);
    const trustpilot = rollup.platforms.find(
      (p) => p.platform === "trustpilot",
    );
    expect(trustpilot?.reviews).toBe(2);
    expect(trustpilot?.averageOn5).toBeCloseTo(4.5, 5);
    expect(trustpilot?.distribution).toEqual([0, 0, 0, 1, 1]);
    expect(rollup.totalReviews).toBe(3);
    expect(rollup.unrated).toBe(0);
  });

  it("normalizes by each row's own max instead of averaging raw", () => {
    const rollup = rollupReviewSentiment([
      { platform: "x", value: 80, max: 100 },
      { platform: "x", value: 4, max: 5 },
    ]);
    // 80/100 and 4/5 are both 4.0 on a five-scale — averaged as equals.
    const x = rollup.platforms.find((p) => p.platform === "x");
    expect(x?.averageOn5).toBeCloseTo(4.0, 5);
  });

  it("counts unrated and out-of-scale rows aloud instead of averaging them", () => {
    const rollup = rollupReviewSentiment([
      { platform: "trustpilot", value: null, max: 5 },
      { platform: "trustpilot", value: 9, max: 5 },
      { platform: "trustpilot", value: 5, max: 5 },
    ]);
    const trustpilot = rollup.platforms.find(
      (p) => p.platform === "trustpilot",
    );
    expect(trustpilot?.reviews).toBe(3);
    expect(trustpilot?.averageOn5).toBeCloseTo(5.0, 5);
    expect(rollup.unrated).toBe(2);
  });

  it("reports null average, not zero, for a platform with no rated rows", () => {
    const rollup = rollupReviewSentiment([
      { platform: "tripadvisor", value: null, max: 5 },
    ]);
    expect(rollup.platforms[0]?.averageOn5).toBeNull();
    expect(rollup.platforms[0]?.reviews).toBe(1);
  });
});
