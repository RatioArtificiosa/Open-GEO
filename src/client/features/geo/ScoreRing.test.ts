import { describe, expect, it } from "vitest";
import { arcFor } from "./ScoreRing";
import {
  computeVisibilityScore,
  WEIGHTS,
  type ScoreInputs,
} from "./visibility-score";

/**
 * The ring's geometry and the score it wraps.
 *
 * A ring that draws a full circle at any score is the visual equivalent of a
 * confident wrong number, and it is the kind of bug no assertion about the
 * underlying score would catch. So the arc is a pure function and it is tested
 * directly.
 */

const all: ScoreInputs = {
  platform: "chat_gpt",
  mentionCoverage: 80,
  shareOfVoice: 60,
  citationAuthority: 40,
  momentum: 70,
  evidence: {},
};

describe("arcFor", () => {
  it("fills in proportion to the score", () => {
    expect(arcFor(0).dash).toBe("0 100");
    expect(arcFor(100).dash).toBe("100 0");
    // The midpoint is the only place a proportion bug would hide.
    expect(arcFor(50).dash).toBe("50 50");
  });

  it("leaves the unfilled remainder as the dash gap", () => {
    // `offset` is what rotates the arc's start; the gap is what is left over.
    const arc = arcFor(25);
    expect(arc.dash).toBe("25 75");
    expect(arc.offset).toBe(75);
  });

  it("clamps out-of-range scores rather than drawing nonsense", () => {
    expect(arcFor(-50).dash).toBe("0 100");
    expect(arcFor(500).dash).toBe("100 0");
  });

  it("handles a non-finite score without producing NaN in the DOM", () => {
    // `NaN` in a strokeDasharray renders as no circle at all, which reads as a
    // broken chart rather than a missing number.
    const arc = arcFor(Number.NaN);
    expect(arc.dash).toBe("0 100");
    expect(arc.offset).toBe(100);
  });
});

describe("the score the ring wraps", () => {
  it("agrees with the published weights", () => {
    // The ring is only honest if the number in it is the number the page
    // promises, so this ties the two together rather than trusting either.
    const score = computeVisibilityScore(all);
    // Weighted mean: (80*0.4 + 60*0.25 + 40*0.2 + 70*0.15) / (0.4+0.25+0.2+0.15)
    // = 65.5 / 1 = 65.5, and the weights summing to 1 makes the division a
    // no-op — which is exactly what the "weights sum to one" test protects.
    const weightedSum =
      all.mentionCoverage! * WEIGHTS.mentionCoverage +
      all.shareOfVoice! * WEIGHTS.shareOfVoice +
      all.citationAuthority! * WEIGHTS.citationAuthority +
      all.momentum! * WEIGHTS.momentum;
    const weightTotal = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
    const expected = weightedSum / weightTotal;
    expect(score.score).toBe(Math.round(expected));
    // And the arc is drawn to that same number.
    const { dash } = arcFor(score.score!);
    expect(dash.startsWith(String(score.score))).toBe(true);
  });
});
