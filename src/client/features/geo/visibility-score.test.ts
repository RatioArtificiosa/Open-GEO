import { describe, expect, it } from "vitest";
import {
  computeVisibilityScore,
  describeVisibilityScore,
  WEIGHTS,
  type ScoreInputs,
} from "./visibility-score";

/**
 * The AI Visibility Score.
 *
 * A composite is where a meaningless number hides best: one confident headline
 * figure is the most persuasive place in a product to put a bad number. These
 * tests are therefore mostly about what the score *refuses* to say:
 *
 * 1. **No component is ever zero-filled.** A brand with no citation data has an
 *    unknown citation score. Scoring it zero tells them to fix something they
 *    have not measured, and it drags a good brand down for a missing input.
 * 2. **Coverage is reported.** A score computed from two of four components is a
 *    different claim from one computed from four, and the rescaling that keeps
 *    both on a 0–100 scale is only honest because `coverage` says so.
 * 3. **It is per platform.** There is no combined score, for the same reason
 *    there is no combined demand figure (CL-135).
 */

const all: ScoreInputs = {
  platform: "chat_gpt",
  mentionCoverage: 80,
  shareOfVoice: 60,
  citationAuthority: 40,
  momentum: 70,
  evidence: {},
};

describe("computeVisibilityScore", () => {
  it("publishes weights that sum to one", () => {
    // A weighted mean over weights that do not sum to one silently rescales
    // itself, which makes the published table a lie.
    const total = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("returns every component with its weight and evidence", () => {
    const score = computeVisibilityScore(all);
    expect(score.components).toHaveLength(4);
    for (const component of score.components) {
      expect(component.weight).toBe(WEIGHTS[component.id]);
      // Click-through to the evidence is the product; a component without a
      // sentence is a number nobody can check.
      expect(component.evidence.length).toBeGreaterThan(20);
    }
  });

  it("returns null for a brand with no measurable component", () => {
    const score = computeVisibilityScore({
      ...all,
      mentionCoverage: null,
      shareOfVoice: null,
      citationAuthority: null,
      momentum: null,
    });
    expect(score.score).toBeNull();
    expect(score.coverage).toBe(0);
    expect(score.missing).toHaveLength(4);
  });

  it("does not score a missing component as zero", () => {
    // The failure this prevents: a brand with no citation data scores 0 on
    // citations and is told to go fix it, rather than being told we do not know.
    const withCitation = computeVisibilityScore(all);
    const withoutCitation = computeVisibilityScore({
      ...all,
      citationAuthority: null,
    });
    expect(withoutCitation.missing).toContain("citationAuthority");
    // The remaining components renormalise, so the score is not dragged down —
    // but `coverage` drops, and that is what makes the rescaling honest.
    expect(withoutCitation.coverage).toBeCloseTo(0.8, 5);
    expect(withoutCitation.score).toBeGreaterThan(withCitation.score!);
  });

  it("reports coverage as the weight it could actually stand on", () => {
    const score = computeVisibilityScore({ ...all, momentum: null });
    expect(score.coverage).toBeCloseTo(0.85, 5);
  });

  it("computes a weighted mean a reader can check by hand", () => {
    // 0.4*80 + 0.25*60 + 0.2*40 + 0.15*70 = 32 + 15 + 8 + 10.5 = 65.5, and
    // `Math.round` puts that at 66. The first draft of this test said 71,
    // which is the point: the whole promise of the score is that a reader can
    // check the arithmetic, so the test has to be able to.
    const score = computeVisibilityScore(all);
    expect(score.score).toBe(66);
    expect(score.coverage).toBe(1);
  });

  it("renormalises over the components that exist", () => {
    // Only mentions and SoV: 0.4*80 + 0.25*60 over 0.65 = 72.3 -> 72.
    const score = computeVisibilityScore({
      ...all,
      citationAuthority: null,
      momentum: null,
    });
    expect(score.score).toBe(72);
  });

  it("clamps out-of-range and non-finite inputs rather than propagating them", () => {
    const score = computeVisibilityScore({
      ...all,
      mentionCoverage: 5000,
      shareOfVoice: -20,
      citationAuthority: Number.NaN,
      momentum: Number.POSITIVE_INFINITY,
    });
    for (const component of score.components) {
      if (component.value === null) continue;
      expect(component.value).toBeGreaterThanOrEqual(0);
      expect(component.value).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the platform it was given, and never invents a combined one", () => {
    const score = computeVisibilityScore(all);
    expect(score.platform).toBe("chat_gpt");
    expect(Object.keys(score)).not.toContain("combined");
  });

  it("uses caller-supplied evidence where given", () => {
    // Evidence is per-brand ("12 mentions, median 8") and the default sentence
    // would be generic to the point of being useless.
    const score = computeVisibilityScore({
      ...all,
      evidence: {
        mentionCoverage: "12 mentions against a category median of 8.",
      },
    });
    const coverage = score.components.find(
      (component) => component.id === "mentionCoverage",
    );
    expect(coverage?.evidence).toBe(
      "12 mentions against a category median of 8.",
    );
  });
});

describe("describeVisibilityScore", () => {
  it("says plainly when there is nothing to score", () => {
    const score = computeVisibilityScore({
      ...all,
      mentionCoverage: null,
      shareOfVoice: null,
      citationAuthority: null,
      momentum: null,
    });
    expect(describeVisibilityScore(score)).toMatch(/not enough measured/i);
  });

  it("does not advertise a thin score as a measurement", () => {
    // A "72" computed from one component invites a reader to treat it as a fact.
    // A "72" computed from one component invites a reader to treat it as a fact.
    // At or under 40% coverage the sentence has to say "direction, not
    // measurement" — the boundary is inclusive, so a score resting on the
    // mention-coverage weight alone is already too thin to lead with.
    const score = computeVisibilityScore({
      ...all,
      shareOfVoice: null,
      citationAuthority: null,
      momentum: null,
    });
    expect(score.coverage).toBeLessThanOrEqual(0.4);
    expect(describeVisibilityScore(score)).toMatch(
      /direction, not a measurement/i,
    );
  });

  it("names the missing components rather than quietly dropping their weight", () => {
    const score = computeVisibilityScore({ ...all, citationAuthority: null });
    const text = describeVisibilityScore(score);
    expect(text).toMatch(/3 of 4/);
    expect(text).toContain("citationAuthority");
  });

  it("claims nothing about coverage when every component is present", () => {
    const text = describeVisibilityScore(computeVisibilityScore(all));
    expect(text).toContain("all four components");
    expect(text).not.toMatch(/missing/i);
  });
});
