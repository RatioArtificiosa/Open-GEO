import { beforeEach, describe, expect, it } from "vitest";
import {
  callTool,
  forecastForStoredSeries,
  listTargets,
  textOf,
} from "./geo-tools-test-support";

/**
The forecast's honesty contract.

The shipped CL-501 family refuses to forecast *upward* — an exponential fitted
to twelve points is a promise about a competitor's release schedule — and this
suite pins what it says instead: the sample size first, the direction with its
floor, the arrival date only as a conditional extension of a measured slope, and
the refusals in the order a reader needs them.
 */

const { getGeoVisibilityForecastTool } =
  await import("@/server/mcp/tools/geo-read-tools");

/**
 * A forecast as the reader returns it.
 *
 * Built in one place because every case below tunes the same two facts — the
 * rate and the window it rests on — and a fixture copied per test is a fixture
 * that drifts until one case asserts a shape the reader never sends.
 */
function measurableForecast(overrides?: {
  rate?: number | null;
  basedOn?: number;
  skipped?: { unknownDenominator: number; noText: number; noAnswers: number };
  note?: string | null;
  /** Null means the look-back window covered every run. */
  totalRunsInProject?: number | null;
  /** The measured slope the projection extends, when the history supports one. */
  direction?: { perWeek: number | null; basedOnWeeks: number };
}): unknown {
  const rate = overrides?.rate === undefined ? 0.25 : overrides.rate;
  const basedOn = overrides?.basedOn ?? 8;
  // The window reads one "run" per observation here, so `considered` lines up with
  // the array length rather than being a second number to keep in step.
  const observations = Array.from({ length: basedOn === 0 ? 1 : basedOn });
  return {
    series: {
      domain: "acme.com",
      platform: "chat_gpt",
      observations,
      windowed: {
        considered: observations.length,
        totalRunsInProject: overrides?.totalRunsInProject ?? null,
      },
      skipped: overrides?.skipped ?? {
        unknownDenominator: 0,
        noText: 0,
        noAnswers: 0,
      },
      note: overrides?.note ?? null,
    },
    forecast: {
      current: [
        {
          platform: "chat_gpt",
          rate,
          low: rate === null ? null : 0.06,
          high: rate === null ? null : 0.61,
          basedOn,
          confidence: basedOn === 0 ? "none" : "low",
        },
      ],
      direction: {
        perWeek: overrides?.direction?.perWeek ?? null,
        confidence: "none",
        basedOnWeeks: overrides?.direction?.basedOnWeeks ?? 0,
      },
      doesNotClaim: "This is not a market share.",
    },
  };
}

describe("get_geo_visibility_forecast", () => {
  beforeEach(() => {
    forecastForStoredSeries.mockReset();
  });

  it("leads with the sample size, not the percentage", async () => {
    // **The whole point of the tool.** An agent reading only the first line must
    // not come away with "25%". 4 of 8 prompts and 4 of 400 are the same sentence
    // and different facts, and a percentage alone invites quoting the flattering
    // half of that.
    forecastForStoredSeries.mockResolvedValue(measurableForecast());
    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    const text = textOf(result);
    expect(text).toMatch(/Based on 8 prompts/);
    // Order asserted, not just presence: the count has to come first, or a
    // reader who stops early is misled about what the number means.
    expect(text.indexOf("Based on 8 prompts")).toBeLessThan(
      text.indexOf("25%"),
    );
    // And the interval is present, because at n=8 the spread *is* the measurement.
    expect(text).toMatch(/Between 6% and 61%/);
  });

  it("says it cannot give a rate when no run recorded a denominator", async () => {
    // The common case: the Live path cannot know how many prompts the vendor
    // asked. This must be a sentence, not an error and not a bare null — an agent
    // that sees a failure will retry, and one that sees a number will use it.
    forecastForStoredSeries.mockResolvedValue(
      measurableForecast({
        rate: null,
        basedOn: 0,
        skipped: { unknownDenominator: 4, noText: 0, noAnswers: 0 },
        note: "No run has recorded how many prompts it asked, so there is nothing to forecast.",
      }),
    );

    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    const text = textOf(result);
    expect(text).toMatch(/no rate to give/i);
    // It must not have produced a percentage either.
    expect(text).not.toMatch(/\d+%/);
    // And it explains the excluded runs, which is what a reader asks next.
    expect(text).toMatch(/4 run\(s\) are not included/);
  });

  it("states the look-back window, so an agent does not read a limit as a history", async () => {
    // The forecast reads a bounded window. An agent told "forecasted from 8 of 8
    // runs" reasonably concludes the brand has eight runs of history — when it has
    // two hundred, and the window simply stopped reading. Acting on that
    // ("visibility has been flat for eight runs") is a conclusion drawn from a
    // limit, so the count has to be in the payload as a number.
    forecastForStoredSeries.mockResolvedValue(
      measurableForecast({ totalRunsInProject: 40 }),
    );
    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(textOf(result)).toMatch(
      /read the 8 most recent run\(s\); 32 older run\(s\) were not read/,
    );
  });

  it("says nothing about a window when it covered the whole archive", async () => {
    // The common case for a young project. A window clause here would be noise,
    // and noise in a tool description is what makes agents skip reading it.
    forecastForStoredSeries.mockResolvedValue(measurableForecast());
    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(textOf(result)).not.toMatch(/look-back window/i);
  });

  it("adds the arrival date when a pace has been measured", async () => {
    // CL-501-web: the "at this pace, X% in N days" sentence. It is the number a
    // reader will remember and the weakest one in the payload — a linear
    // extension of a slope, conditional on nothing changing — so the assertion
    // checks the condition travels with it ("At that pace"), and that it arrives
    // *after* the sample size, which is the ordering the product promises.
    forecastForStoredSeries.mockResolvedValue(
      measurableForecast({
        direction: { perWeek: 0.01, basedOnWeeks: 16 },
      }),
    );
    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    const text = textOf(result);
    expect(text).toMatch(
      /At that pace it reaches 30% of prompts in about 5 weeks/,
    );
    expect(text.indexOf("Based on 8 prompts")).toBeLessThan(
      text.indexOf("At that pace"),
    );
    // Two refusals travel, because the projection is conditional and a reader
    // who takes it as a forecast is the failure this ordering prevents.
    expect(text).toMatch(/not a prediction/);
    // And the numbers, so an agent can reason from the pace without parsing prose.
    expect(result.structuredContent?.pace).toMatchObject({
      perWeek: 0.01,
      targetShare: 0.3,
      horizonDays: 90,
    });
  });

  it("refuses the arrival date when no pace has been measured", async () => {
    // The common case: a young project has a rate and no slope. The sentence must
    // be the refusal, never an arrival date computed from a slope that does not
    // exist — the confident arithmetic this product refuses everywhere else.
    forecastForStoredSeries.mockResolvedValue(measurableForecast());
    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    const text = textOf(result);
    expect(text).toMatch(/nothing has been measured yet, so there is no pace/i);
    expect(text).not.toMatch(/At that pace/);
    expect(result.structuredContent?.pace).toMatchObject({
      perWeek: null,
      weeksToTarget: null,
    });
  });

  it("reads through the authorized project rather than a target id", async () => {
    // The tool takes a domain and resolves the target server-side. It must not
    // look the target up itself and pass an id, because that would be a second
    // identity the auth wrapper cannot see.
    forecastForStoredSeries.mockResolvedValue(measurableForecast());
    await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(forecastForStoredSeries).toHaveBeenCalledWith({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(listTargets).not.toHaveBeenCalled();
  });
});
describe("tool annotations", () => {
  it("is marked read-only, because it reads the archive and spends nothing", () => {
    // A wrong readOnlyHint makes an agent ask the user to confirm a call that
    // costs nothing — which trains them to approve prompts, and the next one
    // costs credits.
    expect(getGeoVisibilityForecastTool.config.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });
});
