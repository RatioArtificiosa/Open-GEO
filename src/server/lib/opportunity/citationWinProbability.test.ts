import { describe, expect, it } from "vitest";

import {
  CITATION_INTERCEPT,
  CITATION_MODEL_VERSION,
  citationWinProbability,
  type CitationWinProbability,
  type CitingDomainFeatures,
} from "@/server/lib/opportunity/citationWinProbability";

const middling: CitingDomainFeatures = {
  authority: 0.5,
  topicalOverlap: 0.5,
  alreadyCitesUs: false,
  citationPropensity: 0.5,
  freshness: 0.5,
};

describe("citationWinProbability", () => {
  it("starts below even odds for a middling target, because most pages win nothing", () => {
    // The negative intercept is the point of the model. Without it every plausible-looking domain
    // reads as likely, and a prospect list that is mostly wrong is worse than none.
    expect(citationWinProbability(middling).probability).toBeLessThan(0.5);
  });

  it("still reaches a high probability for a target that is strong everywhere", () => {
    const strong = citationWinProbability({
      authority: 1,
      topicalOverlap: 1,
      alreadyCitesUs: true,
      citationPropensity: 1,
      freshness: 1,
    });
    expect(strong.probability).toBeGreaterThan(0.9);
  });

  it("is monotonic in each feature and never leaves 0-1", () => {
    const low = citationWinProbability({ ...middling, topicalOverlap: 0.1 });
    const high = citationWinProbability({ ...middling, topicalOverlap: 0.9 });
    expect(high.probability).toBeGreaterThan(low.probability);

    const clamped = citationWinProbability({
      ...middling,
      authority: 5,
      freshness: -2,
    });
    expect(clamped.probability).toBeGreaterThanOrEqual(0);
    expect(clamped.probability).toBeLessThanOrEqual(1);
  });

  it("weights an existing citation relationship most, since it is the cheapest to act on", () => {
    const withRelationship = citationWinProbability({
      ...middling,
      alreadyCitesUs: true,
    });
    const without = citationWinProbability(middling);
    // Compared on **contributions**, where the coefficients live. Probability swings measure the
    // logistic's saturation instead: a large change late in the curve moves probability less than a
    // smaller one in the middle, which is how this test failed when it was first written.
    expect(without.contributions.alreadyCitesUs).toBe(0);
    const authority = citationWinProbability({ ...middling, authority: 1 });
    expect(withRelationship.contributions.alreadyCitesUs).toBeGreaterThan(
      authority.contributions.authority,
    );
  });

  it("says it is uncalibrated, so the number is not quoted as a frequency", () => {
    const scored = citationWinProbability(middling);
    expect(scored.calibrated).toBe(false);
    expect(scored.version).toBe(CITATION_MODEL_VERSION);
  });

  it("returns contributions that reproduce the log-odds, so the ranking can be explained", () => {
    const scored: CitationWinProbability = citationWinProbability(middling);
    const total = Object.values(scored.contributions).reduce(
      (sum, part) => sum + part,
      0,
    );
    // The intercept is not a contribution: it is the prior, and a feature's push is only meaningful
    // relative to it. Reconstructing the odds here keeps that separation honest.
    const logOdds = Math.log(scored.probability / (1 - scored.probability));
    // Read from the model rather than duplicated: this assertion failed the moment the intercept
    // changed, because the old value was written into the test as a literal.
    expect(logOdds).toBeCloseTo(total + CITATION_INTERCEPT, 6);
  });
});
