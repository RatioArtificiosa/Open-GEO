import { describe, expect, it } from "vitest";
import { projectVisibilityPace, PACE_HORIZON_DAYS } from "./visibilityPace";

/**
 * The "at this pace, X% in N days" sentence, and every case it refuses to print.
 *
 * The projection is a linear extension of a measured slope — a claim about
 * arithmetic, not about the model — so the refusals below matter more than the
 * numbers: a sentence printed without a measured pace is a promise about a
 * competitor's release schedule wearing a number.
 */

describe("projectVisibilityPace", () => {
  it("prints the arrival date when the pace reaches the target inside the band", () => {
    const result = projectVisibilityPace({
      platform: "chat_gpt",
      rateNow: 0.2,
      perWeek: 0.01,
      basedOnWeeks: 16,
    });

    expect(result.weeksToTarget).toBeCloseTo(10, 5);
    expect(result.shareAfterHorizon).toBeCloseTo(0.2 + 0.01 * 13, 5);
    // The condition is in the sentence: "at that pace", not "will".
    expect(result.summary).toMatch(
      /At that pace it reaches 30% of prompts in about 10 weeks \(70 days\)/,
    );
    expect(result.summary).toMatch(/moving \+1 points per week/);
    expect(result.doesNotClaim).toMatch(/not a prediction/);
  });

  it("says when the arrival is beyond the band rather than rounding it in", () => {
    const result = projectVisibilityPace({
      platform: "chat_gpt",
      rateNow: 0.1,
      perWeek: 0.002,
      basedOnWeeks: 16,
    });

    expect(result.weeksToTarget).toBeCloseTo(100, 5);
    expect(result.summary).toMatch(/beyond the 90-day band this speaks over/);
    // And it still reports what the band itself implies, so the sentence is not
    // a bare refusal.
    expect(result.summary).toMatch(/Within the band it implies 13%/);
  });

  it("refuses an arrival date when the history is under the floor", () => {
    // The floor is the forecast module's own, imported so the refusal and the
    // measurement cannot disagree about where a slope becomes real. Six weeks of
    // a rising share is exactly the shape a permissive answer would project.
    const result = projectVisibilityPace({
      platform: "perplexity",
      rateNow: 0.1,
      perWeek: 0.01,
      basedOnWeeks: 6,
    });

    expect(result.weeksToTarget).toBeNull();
    expect(result.summary).toMatch(
      /Only 6 weeks of history, and 8 are the floor/,
    );
  });

  it("refuses an arrival date from a flat or falling share", () => {
    // A countdown to something that moves away is worse than no countdown.
    const falling = projectVisibilityPace({
      platform: "chat_gpt",
      rateNow: 0.2,
      perWeek: -0.005,
      basedOnWeeks: 16,
    });
    expect(falling.weeksToTarget).toBeNull();
    expect(falling.summary).toMatch(/no arrival date to give/);

    const flat = projectVisibilityPace({
      platform: "chat_gpt",
      rateNow: 0.2,
      perWeek: 0,
      basedOnWeeks: 16,
    });
    expect(flat.weeksToTarget).toBeNull();
    expect(flat.summary).toMatch(/no arrival date to give/);
  });

  it("reports a share already past the target instead of projecting backwards", () => {
    const result = projectVisibilityPace({
      platform: "claude",
      rateNow: 0.42,
      perWeek: 0.01,
      basedOnWeeks: 20,
    });
    expect(result.weeksToTarget).toBeNull();
    expect(result.summary).toMatch(/already past that share/);
  });

  it("caps the horizon at every prompt measured, and says that is a ceiling", () => {
    // A projection that prints past 100% is a number about a model of the world
    // rather than about the measured slope.
    const result = projectVisibilityPace({
      platform: "chat_gpt",
      rateNow: 0.9,
      perWeek: 0.02,
      basedOnWeeks: 16,
    });

    expect(result.shareAfterHorizon).toBe(1);
    expect(result.summary).toMatch(/a ceiling rather than a forecast/);
  });

  it("declines to extend a pace whose level has no denominator", () => {
    // The level comes from the run's denominator; without one there is nothing
    // to extend from, whatever the slope says.
    const result = projectVisibilityPace({
      platform: "gemini",
      rateNow: null,
      perWeek: 0.01,
      basedOnWeeks: 16,
    });

    expect(result.weeksToTarget).toBeNull();
    expect(result.summary).toMatch(/nothing to extend it from/);
  });

  it("says nothing has been measured when no week has one", () => {
    const result = projectVisibilityPace({
      platform: "chat_gpt",
      rateNow: null,
      perWeek: null,
      basedOnWeeks: 0,
    });
    expect(result.summary).toMatch(/Nothing has been measured yet/);
  });

  it("speaks over the stated horizon, not a hardcoded one", () => {
    const result = projectVisibilityPace({
      platform: "chat_gpt",
      rateNow: 0.2,
      perWeek: 0.01,
      basedOnWeeks: 16,
      horizonDays: 30,
    });
    expect(PACE_HORIZON_DAYS).toBe(90);
    expect(result.horizonDays).toBe(30);
    // Four weeks in a 30-day band: the arrival sits outside it, and the
    // sentence says which band it is speaking over.
    expect(result.summary).toMatch(/beyond the 30-day band/);
    expect(result.summary).toMatch(/Within the band it implies 24%/);
  });
});
