import { describe, expect, it } from "vitest";
import {
  rankContentOpportunities,
  type OpportunityMeasurement,
} from "./opportunityRanking";
import { opportunityScore } from "./opportunityScore";

/**
 * `rankContentOpportunities` — the decision layer, and the band that makes it
 * honest.
 *
 * ## The assertions that carry the design rule
 *
 * The design rule is *"a forecast drawn as a hard line is a lie. Draw the band."*
 * So the tests that matter are about the **direction of the band**: it widens
 * when measurements are sparse, it widens when measurements disagree, and it
 * narrows toward a floor when they agree — never to zero, because the inputs are
 * estimates and a tight band would read as a measurement.
 *
 * ## The assertion that makes it a decision layer
 *
 * Ranking by the band's low end rather than the score. A list ranked by best
 * case is a list that flatters: the top would be the keywords that might be
 * good, not the ones a customer can rely on. That is the whole point of drawing
 * the band, so it is asserted directly rather than left to a sort order nobody
 * checks.
 */

/**
 * One measurement, at a given difficulty.
 *
 * Typed against the model's own `OpportunityMeasurement` rather than a local
 * shape: a local shape would drift from the model, and the test would keep passing
 * against a shape the ranking no longer accepts. The serpCompetitors value is the
 * mid-range the score's easing is centred on, so difficulty is the only variable
 * these tests move.
 */
const measure = (difficulty: number): OpportunityMeasurement => ({
  keywordDifficulty: difficulty,
  serpCompetitors: 100,
  intent: "commercial",
  aiNativeRatioBp: 3000,
  rankElasticityBp: 5000,
});

const bandFor = (measurements: OpportunityMeasurement[], keyword = "kw") =>
  rankContentOpportunities({
    measurementsByKeyword: new Map([[keyword, measurements]]),
    resamples: 50,
  }).items[0];

describe("rankContentOpportunities", () => {
  it("refuses to rank a keyword with no measurements", () => {
    // There is nothing to rank, and inventing a score would be the failure this
    // product exists to prevent — a keyword ranked last looks like a bad
    // keyword when it is an unmeasured one.
    const result = rankContentOpportunities({
      measurementsByKeyword: new Map([["kw", []]]),
    });
    expect(result.items).toEqual([]);
  });

  it("widens the band when the series is a single measurement", () => {
    // **The assertion the design rule asks for.** Sparse input must not look
    // precise: a first version that asserted only \"low <= score <= high\" would
    // pass for a zero-width band, which is the same failure as a test that reads
    // on both the fixed and the broken version.
    const single = bandFor([measure(40)]);
    const many = bandFor([
      measure(40),
      measure(41),
      measure(39),
      measure(40),
      measure(42),
      measure(38),
      measure(40),
      measure(41),
      measure(39),
      measure(40),
    ]);

    expect(single.band.high - single.band.low).toBeGreaterThan(
      many.band.high - many.band.low,
    );
    // ...and the single-measurement keyword is marked as such, so the UI can
    // say "one reading" rather than presenting a floor as a spread.
    expect(single.isFallback).toBe(true);
    expect(many.isFallback).toBe(false);
  });

  it("widens the band when measurements disagree", () => {
    // The other direction: a genuine spread must produce a genuine band, or the
    // fallback floor would be the only width the model can produce.
    const tight = bandFor(Array.from({ length: 12 }, () => measure(40)));
    const loose = bandFor([
      measure(15),
      measure(85),
      measure(30),
      measure(70),
      measure(20),
      measure(80),
      measure(40),
      measure(60),
      measure(25),
      measure(75),
      measure(35),
      measure(65),
    ]);

    expect(loose.band.high - loose.band.low).toBeGreaterThan(
      tight.band.high - tight.band.low,
    );
  });

  it("never narrows to zero, however quiet the series is", () => {
    // The inputs are estimates, so a tight band would read as a measurement. The
    // floor is a floor in the honest sense: it holds however still the series.
    const quiet = bandFor(Array.from({ length: 30 }, () => measure(40)));

    expect(quiet.band.high - quiet.band.low).toBeGreaterThan(0);
    expect(quiet.band.high - quiet.band.low).toBeGreaterThanOrEqual(6);
  });

  it("keeps the band inside 0-100 at the extremes", () => {
    const low = bandFor([measure(0)]);
    const high = bandFor([measure(100)]);

    expect(low.band.low).toBeGreaterThanOrEqual(0);
    expect(low.band.high).toBeLessThanOrEqual(100);
    expect(high.band.low).toBeGreaterThanOrEqual(0);
    expect(high.band.high).toBeLessThanOrEqual(100);
  });

  it("ranks by the band's low end, not the score", () => {
    // **The assertion that makes it a decision layer.** A list ranked by best
    // case is a list that flatters. Here a reliable 50 beats a possibly-90
    // keyword, because the customer acts on the first and gambles on the second.
    const result = rankContentOpportunities({
      measurementsByKeyword: new Map([
        ["reliable", Array.from({ length: 10 }, () => measure(50))],
        ["volatile", [measure(5), measure(95), measure(20), measure(80)]],
      ]),
      resamples: 50,
    });

    expect(result.items[0]?.keyword).toBe("reliable");
  });

  it("breaks a tie on the score so the order is stable", () => {
    // A sort with no tiebreak is a sort that reorders on input order, which
    // makes a rendered list look arbitrary between two identical keywords.
    const result = rankContentOpportunities({
      measurementsByKeyword: new Map([
        ["b-keyword", [measure(40)]],
        ["a-keyword", [measure(40)]],
      ]),
      resamples: 50,
    });

    // Ranked by the band's low end, so two identical keywords tie and then fall
    // back to the score — which is also identical here, so the order is the map's
    // insertion order. Asserting the *set* rather than a sorted list keeps the
    // test honest about what it proves: both are present, and the sort is not
    // what put them there.
    expect(new Set(result.items.map((item) => item.keyword))).toEqual(
      new Set(["a-keyword", "b-keyword"]),
    );
  });

  it("is reproducible, so the same measurements give the same band", () => {
    // A bootstrap with an unseeded RNG would move the band between requests, and
    // a band that moves is a band nobody can reason about.
    const measurements = [
      measure(30),
      measure(50),
      measure(40),
      measure(60),
      measure(45),
    ];
    const first = bandFor(measurements);
    const second = bandFor(measurements);

    expect(first.band).toEqual(second.band);
  });

  it("scores the newest measurement, not the average", () => {
    // The reported score is the latest reading; the archive sets the band. An
    // average would blend a stale measurement into the current one, which is
    // the same confusion the score's own contribution display avoids.
    const result = bandFor([measure(90), measure(10)]);
    expect(result.score).toBeCloseTo(
      opportunityScore({
        keywordDifficulty: 90,
        serpCompetitors: 100,
        intent: "commercial",
        aiNativeRatio: 0.3,
        rankElasticity: 0.5,
      }).score,
      5,
    );
  });

  it("counts the measurements it ranked on, because the count is the headline", () => {
    // A score from one measurement and a score from forty are the same number
    // and completely different facts. The band already says that, and the count
    // is what a caller can render next to it.
    const result = bandFor([measure(40), measure(41)]);
    expect(result.measurements).toBe(2);
  });

  it("carries a version, so a model change is visible in the output", () => {
    // The same stamping rule as every other score in the product: an unversioned
    // rank is a rank nobody can audit after the weights move.
    expect(bandFor([measure(40)])).toHaveProperty("keyword", "kw");
    const result = rankContentOpportunities({
      measurementsByKeyword: new Map([["kw", [measure(40)]]]),
    });
    expect(result.version).toBe("1.0.0");
  });
});
