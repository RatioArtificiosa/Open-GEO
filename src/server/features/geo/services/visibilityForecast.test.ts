import { describe, expect, it } from "vitest";
import {
  forecastVisibility,
  MIN_PROMPTS_FOR_DIRECTION,
  type VisibilityObservation,
} from "./visibilityForecast";

/**
 * Forecasting AI visibility.
 *
 * Weighted towards the *refusals*, because that is where this kind of feature
 * goes wrong. A visibility number with a small sample is not a weak number, it is
 * a **misleading** one: 2 mentions out of 4 prompts reads as 50% and means almost
 * nothing, and a dashboard that renders it beside a 400-prompt figure has put two
 * incompatible sentences in the same column.
 */
function obs(
  platform: string,
  date: string,
  asks: number,
  mentions: number,
): VisibilityObservation {
  return { platform, date, promptsAsked: asks, mentions };
}

describe("forecastVisibility", () => {
  it("reports nothing, rather than a rate, when no prompt was asked", () => {
    // A rate over zero prompts is not zero. It is an absence, and rendering it as
    // 0% puts a brand in a chart at the bottom of the scale for the reason
    // that nobody measured.
    const result = forecastVisibility([obs("chat_gpt", "2026-10-01", 0, 0)]);

    expect(result.current[0]?.rate).toBeNull();
    expect(result.current[0]?.confidence).toBe("none");
    expect(result.current[0]?.basedOn).toBe(0);
  });

  it("separates platforms rather than pooling them", () => {
    // The platform-card rule from CL-132, in a new place: a 90% rate on ChatGPT
    // and a 10% rate on Gemini are two facts, and their mean is a number about
    // neither.
    const result = forecastVisibility([
      obs("chat_gpt", "2026-10-01", 100, 90),
      obs("gemini", "2026-10-01", 100, 10),
    ]);

    const chat = result.current.find((c) => c.platform === "chat_gpt");
    const gemini = result.current.find((c) => c.platform === "gemini");
    expect(chat?.rate).toBeCloseTo(0.9, 5);
    expect(gemini?.rate).toBeCloseTo(0.1, 5);
    // And there is no combined figure anywhere in the payload.
    expect(result.current).toHaveLength(2);
  });

  it("uses the latest observation, not the sum across days", () => {
    // Summing would answer "how many times were we ever mentioned" on a panel
    // that says "what share of prompts mention us". Two different questions with
    // a denominator in sight, and only one of them is what the label claims.
    const result = forecastVisibility([
      obs("chat_gpt", "2026-09-01", 100, 90),
      obs("chat_gpt", "2026-10-01", 100, 10),
    ]);

    expect(result.current[0]?.rate).toBeCloseTo(0.1, 5);
  });

  it("gives a small sample a much wider band than a large one", () => {
    // **The load-bearing property.** The same rate over ten prompts and over
    // four hundred is the same sentence and a completely different fact.
    const small = forecastVisibility([obs("chat_gpt", "2026-10-01", 10, 2)]);
    const large = forecastVisibility([obs("chat_gpt", "2026-10-01", 400, 80)]);

    const smallWidth =
      (small.current[0]?.high ?? 0) - (small.current[0]?.low ?? 0);
    const largeWidth =
      (large.current[0]?.high ?? 0) - (large.current[0]?.low ?? 0);

    expect(smallWidth).toBeGreaterThan(largeWidth * 2);
    // And the confidence reflects it, so a caller cannot ignore the band.
    expect(small.current[0]?.confidence).toBe("low");
    expect(large.current[0]?.confidence).toBe("high");
  });

  it("widens the band as the sample shrinks, monotonically", () => {
    const widths = [5, 10, 25, 100, 400].map((n) => {
      const r = forecastVisibility([obs("chat_gpt", "2026-10-01", n, 1)]);
      return (r.current[0]?.high ?? 0) - (r.current[0]?.low ?? 0);
    });

    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i] ?? 1).toBeLessThan(widths[i - 1] ?? 0);
    }
  });

  it("keeps the band inside 0-1 at the extremes", () => {
    // A proportion of 0 or 1 is the case where a naive interval leaves [0,1] or
    // goes outside it, and a chart that draws below zero is a visible bug.
    for (const [asks, mentions] of [
      [5, 0],
      [5, 5],
      [400, 0],
      [400, 400],
    ] as const) {
      const r = forecastVisibility([
        obs("chat_gpt", "2026-10-01", asks, mentions),
      ]);
      expect(r.current[0]?.low ?? -1).toBeGreaterThanOrEqual(0);
      expect(r.current[0]?.high ?? 2).toBeLessThanOrEqual(1);
    }
  });

  it("declines to give a direction from too little history", () => {
    // A line through six points of noise has a slope, an interval and an R², and
    // none of the three make it real. Saying so is the feature.
    const history = [
      obs("chat_gpt", "2026-09-01", 20, 4),
      obs("chat_gpt", "2026-09-08", 20, 5),
      obs("chat_gpt", "2026-09-15", 20, 4),
    ];
    const result = forecastVisibility(history);

    expect(result.direction.perWeek).toBeNull();
    expect(result.direction.confidence).toBe("none");
    expect(result.direction.reading).toMatch(/sampling noise/i);
    expect(MIN_PROMPTS_FOR_DIRECTION).toBeGreaterThan(3);
  });

  it("says nothing has been measured when there is no history at all", () => {
    const result = forecastVisibility([]);

    expect(result.direction.perWeek).toBeNull();
    expect(result.direction.reading).toMatch(/nothing has been measured/i);
  });

  it("gives a direction once there is enough history, in a sentence", () => {
    // Nine **weeks**, not nine days. The first version of this test used six
    // consecutive dates, which is six weeks, and asserted a direction — so it
    // failed, correctly, against the floor it was written to check. Six weeks of
    // history genuinely should not produce a slope.
    const history = [
      obs("chat_gpt", "2026-07-27", 50, 10),
      obs("chat_gpt", "2026-08-03", 50, 11),
      obs("chat_gpt", "2026-08-10", 50, 12),
      obs("chat_gpt", "2026-08-17", 50, 14),
      obs("chat_gpt", "2026-08-24", 50, 15),
      obs("chat_gpt", "2026-08-31", 50, 16),
      obs("chat_gpt", "2026-09-07", 50, 18),
      obs("chat_gpt", "2026-09-14", 50, 19),
      obs("chat_gpt", "2026-09-21", 50, 20),
    ];
    const result = forecastVisibility(history);

    expect(result.direction.perWeek).not.toBeNull();
    // A number alone is the failure; the reading is the product.
    expect(result.direction.reading).toMatch(/not a prediction/i);
    expect(result.direction.reading).toMatch(/prompts we ask/i);
  });

  it("does not count two runs on one day as two weeks", () => {
    // The bug this floor was exposed by. The patrol runs more than once a week,
    // so counting *dates* would let a project patrolled daily reach the
    // "eight weeks" floor in four days — and be told it had eight weeks of
    // evidence behind a direction.
    const sameDay: VisibilityObservation[] = [];
    for (let day = 1; day <= 5; day++) {
      sameDay.push(obs("chat_gpt", `2026-09-0${day}`, 50, 10 + day));
    }
    // Five consecutive days is one week.
    const result = forecastVisibility(sameDay);
    expect(result.direction.perWeek).toBeNull();
    expect(result.direction.basedOnWeeks).toBe(1);
  });

  it("always carries what it does not claim", () => {
    // So a caller cannot render the rate without the caveat, because the caveat
    // is what stops someone acting on a sample of twelve as a market share.
    const result = forecastVisibility([obs("chat_gpt", "2026-10-01", 20, 4)]);
    expect(result.doesNotClaim).toMatch(/not a market share/i);
    expect(result.doesNotClaim).toMatch(/not a ranking/i);
  });
});
