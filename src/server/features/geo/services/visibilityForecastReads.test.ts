import { describe, expect, it } from "vitest";
import {
  forecastVisibility,
  type VisibilityObservation,
} from "./visibilityForecast";

/**
 * The stored-series case, and the refusal it forces.
 *
 * **The archive has a numerator and no denominator.** It records how often a
 * brand was mentioned and does not record how many prompts were asked, because
 * the patrol iterates a prompt set and never wrote the count down.
 *
 * That is the whole shape of this test file: the forecast is asked about a series
 * it cannot use, and it must return a **reason** rather than a number computed
 * from a guessed sample. Everything here is about what the code refuses to do.
 */
describe("forecasting a stored series", () => {
  it("declines a month whose sample size is unknown", () => {
    // A rate is mentions / asked. With no `asked`, the only way to produce one
    // is to guess the denominator — and a guessed denominator **narrows the
    // band**, making a weakly-measured month look like a well-measured one.
    // That is the exact inversion this feature exists to prevent.
    //
    // **This is the shape the archive actually has**, which is why the
    // observation type accepts `null`. The first version of this test cast
    // `null` to `number` to satisfy the compiler, and in doing so recorded the
    // wrong thing: the cast said a stored month has a sample size of some
    // unspecified number, when in truth it has none. Widening the type was the
    // fix; the cast was the bug it was hiding.
    const result = forecastVisibility([
      {
        platform: "chat_gpt",
        date: "2026-10-01",
        promptsAsked: null,
        mentions: 4,
      },
    ]);

    expect(result.current[0]?.rate).toBeNull();
    expect(result.current[0]?.confidence).toBe("none");
    expect(result.current[0]?.basedOn).toBe(0);
  });

  it("would produce a rate the moment a sample is recorded", () => {
    // The point of the refusal is that it is *reversible*, not a dead end. The
    // same code with a sample gives a number, which is what makes adding the
    // column worth doing rather than a redesign.
    const withSample: VisibilityObservation = {
      platform: "chat_gpt",
      date: "2026-10-01",
      promptsAsked: 40,
      mentions: 4,
    };
    const result = forecastVisibility([withSample]);
    expect(result.current[0]?.rate).toBeCloseTo(0.1, 5);
  });

  it("carries a sentence a dashboard can show, not an exception", () => {
    // "We have mentions for six months and cannot turn them into a share" is
    // useful to a reader. A thrown error would leave the panel blank with no
    // explanation, which is the same as not having built the feature.
    const result = forecastVisibility([]);
    expect(result.current).toEqual([]);
    expect(result.direction.perWeek).toBeNull();
    expect(result.doesNotClaim).toMatch(/not a market share/i);
  });
});
