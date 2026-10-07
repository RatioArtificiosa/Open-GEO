import { describe, expect, it } from "vitest";

import {
  OPPORTUNITY_SCORE_VERSION,
  opportunityScore,
  type OpportunityInputs,
  type OpportunityScore,
} from "@/server/lib/opportunity/opportunityScore";

const base: OpportunityInputs = {
  keywordDifficulty: 50,
  serpCompetitors: 100,
  intent: "commercial",
  aiNativeRatio: 0.5,
  rankElasticity: 0.5,
};

describe("opportunityScore", () => {
  it("scores a perfect input at exactly 100, which is what pins the weights to a sum of 1", () => {
    // If a weight is changed without the others, this fails. That is the point: the weights are a
    // judgement, but they are a *bounded* judgement, and the scale has to mean something.
    const scored = opportunityScore({
      keywordDifficulty: 0,
      // One competitor: the easiest a real SERP can be. Zero is a data gap, tested below.
      serpCompetitors: 1,
      intent: "transactional",
      aiNativeRatio: 1,
      rankElasticity: 1,
    });
    expect(scored.score).toBe(100);
  });

  it("scores a worst-case input at 0 and never escapes the range", () => {
    const worst = opportunityScore({
      keywordDifficulty: 100,
      serpCompetitors: 1000,
      intent: "navigational",
      aiNativeRatio: 0,
      rankElasticity: 0,
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);

    // Out-of-range input is clamped rather than allowed to produce a score outside 0-100.
    const absurd = opportunityScore({
      ...base,
      aiNativeRatio: 4,
      rankElasticity: -3,
    });
    expect(absurd.score).toBeLessThanOrEqual(100);
    expect(absurd.score).toBeGreaterThanOrEqual(0);
  });

  it("treats zero competitors as a data gap, not as the easiest possible keyword", () => {
    // A SERP with no results is missing data. Scoring it as maximally easy would put broken rows at
    // the top of every lead list, which is worse than scoring them low.
    const noResults = opportunityScore({ ...base, serpCompetitors: 0 });
    const oneCompetitor = opportunityScore({ ...base, serpCompetitors: 1 });
    expect(noResults.score).toBeLessThan(oneCompetitor.score);
    expect(noResults.contributions.serpCompetitors).toBe(0);
  });

  it("squashes competitor counts, so 100 and 1,000 are not equally hard", () => {
    const hundred = opportunityScore({ ...base, serpCompetitors: 100 });
    const thousand = opportunityScore({ ...base, serpCompetitors: 1000 });
    expect(thousand.contributions.serpCompetitors).toBeLessThan(
      hundred.contributions.serpCompetitors,
    );
  });

  it("ranks intent by how close the searcher is to acting", () => {
    const score = (intent: OpportunityInputs["intent"]) =>
      opportunityScore({ ...base, intent }).score;
    expect(score("transactional")).toBeGreaterThan(score("commercial"));
    expect(score("commercial")).toBeGreaterThan(score("informational"));
    expect(score("informational")).toBeGreaterThan(score("navigational"));
  });

  it("falls when difficulty rises, so the score is monotonic in its own inputs", () => {
    const easy = opportunityScore({ ...base, keywordDifficulty: 10 });
    const hard = opportunityScore({ ...base, keywordDifficulty: 90 });
    expect(easy.score).toBeGreaterThan(hard.score);
  });

  it("carries its version, so a stored score can be read against the model that produced it", () => {
    expect(opportunityScore(base).version).toBe(OPPORTUNITY_SCORE_VERSION);
  });

  it("returns contributions that add up to the score, which is what makes it explainable", () => {
    const scored: OpportunityScore = opportunityScore(base);
    const total = Object.values(scored.contributions).reduce(
      (sum, part) => sum + part,
      0,
    );
    expect(Math.round(total * 100)).toBe(scored.score);
  });
});
