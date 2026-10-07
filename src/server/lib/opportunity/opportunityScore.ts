/**
 * Opportunity Score — `f(KD, SERP competitors, intent, AI-native ratio, rank elasticity)`.
 *
 * **This arithmetic is ours, not the vendor's.** §7.4 of the proposal records it plainly:
 * DataForSEO publishes no forecasting endpoint, so they sell history and the extrapolation is the
 * product. That has two consequences for this file. It is **pure** — no I/O, no clock, no vendor
 * call — so it can be tested exhaustively and reasoned about without a live account. And it is
 * **version-stamped**, because a score that changes silently is a score nobody can trust across
 * time; `OPPORTUNITY_SCORE_VERSION` travels with every result so a stored score can always be read
 * back against the model that produced it.
 *
 * Every weight below is a **judgement**, chosen so the function is monotonic and explainable rather
 * than fitted to nothing. When the nightly jobs of CL-503 have enough stored outcomes, these become
 * the baseline a fitted model is compared against — which is the only honest way to change them.
 */

/** Bump when any weight or transform below changes. Stored scores are read back against this. */
export const OPPORTUNITY_SCORE_VERSION = "1.0.0";

export type SearchIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational";

export type OpportunityInputs = {
  /** Keyword difficulty, 0–100 as the vendor reports it. */
  keywordDifficulty: number;
  /** How many results the SERP returned for this term. Fewer is easier to enter. */
  serpCompetitors: number;
  intent: SearchIntent;
  /** Share of the SERP that is AI-native, 0–1. High means the old playbook is already losing. */
  aiNativeRatio: number;
  /**
   * How much rank moves per unit of effort, 0–1. Estimated upstream; 0 means the position is
   * effectively fixed and 1 that it is wide open. Called `elasticity` rather than `opportunity`
   * so nobody mistakes it for the output of this function.
   */
  rankElasticity: number;
};

export type OpportunityScore = {
  /** 0–100. Higher is a better bet, never a guarantee. */
  score: number;
  version: string;
  /** Which way each input pushed, so the number can be explained rather than asserted. */
  contributions: Record<
    keyof Omit<OpportunityInputs, "intent"> | "intent",
    number
  >;
};

/** Intent is the only categorical input: how close a searcher is to acting. */
const INTENT_WEIGHT: Record<SearchIntent, number> = {
  transactional: 1,
  commercial: 0.85,
  informational: 0.5,
  // Someone looking for a specific destination is not a prospect for a new one.
  navigational: 0.25,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Competitor count is unbounded and long-tailed, so it is squashed rather than capped: 10, 100 and
 * 1,000 competitors should not read as equally hard, and a hard cap would make them. Zero is
 * treated as an unknown rather than an advantage — a SERP with no results is a data gap, not an
 * empty field to win, and scoring it as maximally easy would put a broken row at the top of a list.
 */
const competitorEase = (count: number) => {
  if (count <= 0) return 0;
  return clamp01(1 - Math.log10(count) / 3);
};

/**
 * Score one keyword as an opportunity.
 *
 * The weights sum to 1, so the output is a weighted average on a 0–100 scale and each contribution
 * is directly comparable with the others. That is deliberate: a score whose parts cannot be
 * compared cannot be explained to the person deciding where to spend the month.
 */
export function opportunityScore(inputs: OpportunityInputs): OpportunityScore {
  const contributions = {
    keywordDifficulty: 0.25 * clamp01(1 - inputs.keywordDifficulty / 100),
    serpCompetitors: 0.2 * competitorEase(inputs.serpCompetitors),
    intent: 0.2 * INTENT_WEIGHT[inputs.intent],
    aiNativeRatio: 0.15 * clamp01(inputs.aiNativeRatio),
    rankElasticity: 0.2 * clamp01(inputs.rankElasticity),
  };

  const total = Object.values(contributions).reduce(
    (sum, part) => sum + part,
    0,
  );

  return {
    // Rounded because a score quoted to six decimals invites false precision about a judgement.
    score: Math.round(total * 100),
    version: OPPORTUNITY_SCORE_VERSION,
    contributions,
  };
}
