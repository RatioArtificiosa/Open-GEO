import { describe, expect, it } from "vitest";
import {
  scoreCitability,
  WEIGHTS,
  type CitabilityInput,
} from "./citabilityScore";

/**
 * The AI Citability Score.
 *
 * Four of the six factors are **heuristics we wrote** and one is a
 * **measurement**. The score's job is to keep that distinction visible rather
 * than blend them into a number that claims a precision it does not have — which
 * is the same failure as the 198× cross-platform sum, one level up.
 *
 * The tests are therefore mostly about absence: a factor we could not evaluate
 * must not become a zero, because that is the fastest way a composite score turns
 * into a lie.
 */

const nothing: CitabilityInput = {
  entityDefinition: null,
  answerFirst: null,
  questionHeaderRatio: null,
  schemaTypes: null,
  aiCrawlerAllowed: null,
  citationsObserved: null,
  answersObserved: null,
  competingPagesCited: null,
};

const everything: CitabilityInput = {
  entityDefinition: 1,
  answerFirst: 1,
  questionHeaderRatio: 1,
  schemaTypes: ["Article", "FAQPage"],
  aiCrawlerAllowed: true,
  citationsObserved: 9,
  answersObserved: 10,
  competingPagesCited: 2,
};

describe("scoreCitability", () => {
  it("weights sum to one, so a renormalised coverage is meaningful", () => {
    // A weighted mean over weights that do not sum to one silently rescales
    // itself, which makes the published weight table a lie.
    const total = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("scores a perfect page at 100", () => {
    expect(scoreCitability(everything).score).toBe(100);
  });

  it("returns null, not zero, when nothing could be evaluated", () => {
    // A page we could not measure is not a page that failed. Zero would tell the
    // customer to rewrite something we never looked at.
    const result = scoreCitability(nothing);
    expect(result.score).toBeNull();
    expect(result.coverage).toBe(0);
    expect(result.summary).toMatch(/not a zero/i);
  });

  it("leaves an unevaluated factor out of the denominator", () => {
    // No zero-filling: a missing factor is absent, and averaging an unknown in as
    // a zero makes a page we could not measure look bad.
    const withSchema = scoreCitability({ ...everything, schemaTypes: null });
    // The point of leaving it out: the remaining factors still score 100 rather
    // than being dragged down by an unknown treated as a zero.
    expect(withSchema.coverage).toBeLessThan(1);
    expect(withSchema.score).toBe(100);
    const factor = withSchema.factors.find((f) => f.id === "schema_coverage");
    expect(factor?.score).toBeNull();
    expect(factor?.unavailable).toMatch(/not parsed/i);
  });

  it("says how much of the score is our opinion rather than observation", () => {
    // All six evaluated, none of them measured: a perfect 100 that says nothing
    // about whether AI cites this page. The summary has to say so.
    const rubricOnly = scoreCitability({
      ...everything,
      answersObserved: null,
    });
    expect(rubricOnly.score).toBe(100);
    expect(rubricOnly.heuristicShare).toBe(1);
    expect(rubricOnly.summary).toMatch(
      /our rubric rather than observed behaviour/i,
    );
  });

  it("calls itself a checklist when coverage is too thin to be a measurement", () => {
    // One factor out of six is not a score; it is one observation.
    const thin = scoreCitability({
      ...nothing,
      entityDefinition: 0.5,
    });
    expect(thin.coverage).toBeCloseTo(WEIGHTS.entity_definition, 6);
    expect(thin.summary).toMatch(/checklist, not a finding/i);
  });

  it("distinguishes never-retrieved from retrieved-but-not-cited", () => {
    // Two different findings, two different pieces of advice. Collapsing them
    // would tell a customer to rewrite a page the models never saw.
    const neverSeen = scoreCitability({
      ...nothing,
      answersObserved: 0,
      citationsObserved: 0,
      competingPagesCited: 0,
    });
    const seenNotChosen = scoreCitability({
      ...nothing,
      answersObserved: 10,
      citationsObserved: 0,
      competingPagesCited: 20,
    });
    const a = neverSeen.factors.find((f) => f.id === "competitive_density");
    const b = seenNotChosen.factors.find((f) => f.id === "competitive_density");
    // The one distinction that matters for advice. A page the models never saw
    // is a *reachability* problem and has no measurement at all, so it is absent
    // with a reachability fix. A page that was retrieved and not chosen **is** a
    // measurement — a low one — so it scores and gets the "be more quotable"
    // advice instead. Reading either as the other sends the customer to do the
    // wrong work.
    expect(a?.score).toBeNull();
    expect(a?.unavailable).toMatch(/never been retrieved/i);
    expect(a?.fix).toMatch(/check crawlability/i);

    expect(b?.score).toBeLessThan(0.1);
    expect(b?.unavailable).toBeNull();
    expect(b?.fix).toMatch(/being retrieved is not the problem/i);
  });

  it("makes one citation out of one look like one observation, not a certainty", () => {
    // Laplace smoothing with the *outcome* and *non-outcome* both added: 1
    // citation against 1 competing slot is (1+1)/(1+2) = 67%, not 100% and not
    // 50%. The point is only that it is not 100% — one observation is one
    // observation, and without smoothing a single lucky citation reads as a
    // dominant one.
    const single = scoreCitability({
      ...nothing,
      answersObserved: 1,
      citationsObserved: 1,
      competingPagesCited: 1,
    });
    const factor = single.factors.find((f) => f.id === "competitive_density");
    expect(factor?.score).toBeCloseTo(2 / 3, 6);
    expect(factor?.score).toBeLessThan(1);
  });

  it("never caps competitive density at 100", () => {
    // A page cited 10 times where 9 slots existed is clamped, and the clamp is
    // silent because the arithmetic is simply bounded.
    const capped = scoreCitability({
      ...nothing,
      answersObserved: 5,
      citationsObserved: 50,
      competingPagesCited: 1,
    });
    const factor = capped.factors.find((f) => f.id === "competitive_density");
    expect(factor?.score).toBe(1);
  });

  it("tells a blocked crawler that no content edit will help", () => {
    // The most important copy in this file: the obvious advice is wrong here.
    const blocked = scoreCitability({ ...everything, aiCrawlerAllowed: false });
    const factor = blocked.factors.find((f) => f.id === "crawlable");
    expect(factor?.score).toBe(0);
    expect(factor?.fix).toMatch(/no content edit will help/i);
  });

  it("picks the top fix by weight, not by how easy it is", () => {
    // Density carries the most weight, so a failing density outranks a failing
    // schema even though schema is the quicker change.
    const result = scoreCitability({
      ...everything,
      schemaTypes: [],
      answersObserved: 10,
      citationsObserved: 1,
      competingPagesCited: 30,
    });
    expect(result.topFix?.id).toBe("competitive_density");
  });

  it("offers no top fix when everything measured is already good", () => {
    const result = scoreCitability({
      ...everything,
      schemaTypes: ["Article", "FAQPage"],
    });
    expect(result.topFix).toBeNull();
  });

  it("treats missing schema as zero when the parser did run", () => {
    // Distinct from the parser not running: we looked, and found nothing.
    const none = scoreCitability({ ...everything, schemaTypes: [] });
    const factor = none.factors.find((f) => f.id === "schema_coverage");
    expect(factor?.score).toBe(0);
    expect(factor?.unavailable).toBeNull();
  });
});
