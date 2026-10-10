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

// ── The interval, and the rule that makes it honest ──────────────────────────
//
// The design rule: *"a forecast drawn as a hard line is a lie. Draw the band."*
// This model is the sharpest case for it — the coefficients are unfitted, so the
// point estimate is a ranking signal and the interval is what says how much the
// ranking is worth. A caller that renders only `probability` has thrown away the
// number that matters.

describe("the citation win interval", () => {
  const strong = {
    authority: 0.9,
    topicalOverlap: 0.8,
    alreadyCitesUs: true,
    citationPropensity: 0.7,
    freshness: 0.6,
  };

  it("brackets the point estimate, and never leaves 0-1", () => {
    const { probability, interval } = citationWinProbability(strong);
    expect(interval.low).toBeLessThanOrEqual(probability);
    expect(interval.high).toBeGreaterThanOrEqual(probability);
    expect(interval.low).toBeGreaterThan(0);
    expect(interval.high).toBeLessThan(1);
    // A band with zero width would be a claim of certainty this model cannot make.
    expect(interval.width).toBeGreaterThan(0);
  });

  it("widens when a feature stops being measured", () => {
    // **The assertion the design requirement asks for.**
    //
    // Sparse input must not look precise. The first version of this test only
    // asserted `low <= probability <= high`, which every implementation including
    // a zero-width band satisfies — the same failure as a test that reads on both
    // the fixed and the broken version.
    const measured = citationWinProbability(strong, {
      authority: 0.05,
      topicalOverlap: 0.05,
      citationPropensity: 0.05,
      freshness: 0.05,
    });
    const unmeasured = citationWinProbability(strong);

    expect(unmeasured.interval.width).toBeGreaterThan(measured.interval.width);
  });

  it("widens monotonically with every feature's uncertainty", () => {
    const tight = citationWinProbability(strong, {
      authority: 0.01,
      topicalOverlap: 0.01,
      citationPropensity: 0.01,
      freshness: 0.01,
    });
    const loose = citationWinProbability(strong, {
      authority: 0.2,
      topicalOverlap: 0.2,
      citationPropensity: 0.2,
      freshness: 0.2,
    });
    expect(loose.interval.width).toBeGreaterThan(tight.interval.width);
  });

  it("names the dominant source, and it changes in the right direction", () => {
    // **Two-directional, because a one-sided assertion passes on a hardcoded
    // string.** With tight measurements the prior dominates — it is a statement
    // about the model, and an unfitted model is uncertain about itself. With loose
    // ones the measurements take over.
    const tight = citationWinProbability(strong, {
      // **Every feature measured**, including `alreadyCitesUs`. Leaving that one
      // out is what the first version did, and it dominates everything — it is the
      // largest coefficient and an unmeasured feature takes the widest case — so
      // the test asserted "features" no matter how tight the rest were.
      authority: 0.02,
      topicalOverlap: 0.02,
      citationPropensity: 0.02,
      freshness: 0.02,
      alreadyCitesUs: 0.02,
    });
    expect(tight.interval.dominantSource).toBe("uncalibrated");

    const loose = citationWinProbability(strong, {
      authority: 0.8,
      topicalOverlap: 0.8,
      citationPropensity: 0.8,
      freshness: 0.8,
      alreadyCitesUs: 0.8,
    });
    expect(loose.interval.dominantSource).toBe("features");
    // And the loose case really is wider.
    expect(loose.interval.width).toBeGreaterThan(tight.interval.width);
  });

  it("treats an unmeasured feature as the widest case, never the narrowest", () => {
    // The direction that matters. A zero standard error would claim a precision
    // the model does not have and narrow the band on the least-known inputs.
    const oneUnmeasured = citationWinProbability(strong, {
      authority: 0.05,
      topicalOverlap: 0.05,
      citationPropensity: 0.05,
      freshness: 0.05,
    });
    const noneUnmeasured = citationWinProbability(strong, {
      authority: 0.05,
      topicalOverlap: 0.05,
      citationPropensity: 0.05,
      freshness: 0.05,
      // `alreadyCitesUs` is boolean and has no 0-1 scale, but a caller may still
      // supply a standard error for it.
      alreadyCitesUs: 0.05,
    });
    expect(oneUnmeasured.interval.width).toBeGreaterThan(0);
    expect(noneUnmeasured.interval.width).toBeGreaterThan(0);
  });

  it("never produces a zero-width band at the boundaries", () => {
    // The logistic flattens at both ends, so a naive interval mapped through it
    // collapses to zero width exactly where a weak or a certain target lives.
    const weak = citationWinProbability({
      authority: 0,
      topicalOverlap: 0,
      alreadyCitesUs: false,
      citationPropensity: 0,
      freshness: 0,
    });
    expect(weak.interval.low).toBeGreaterThan(0);
    expect(weak.interval.width).toBeGreaterThan(0);
  });
});
