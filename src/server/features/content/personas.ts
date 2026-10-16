/**
 * Aggregate persona builder (CL-721): who the audience is, from aggregate signals only.
 *
 * The vendor supplies no PII, so the persona is built from shares that are
 * already aggregate: DFS Trends demography (age/gender), the intent funnel
 * stage, SERP-feature proxies, review language, B2B technology signals. The
 * output describes a population ("skews 25–34, commercial intent") with every
 * share carrying its sample — a persona without a sample is a stereotype with
 * a chart.
 *
 * Aggregate-only by construction: the input type has no field a person could
 * be assigned to (no query text, no identifier, no per-user anything), so a
 * "small change" adding one fails to compile rather than quietly publishing it.
 * Shares that do not sum to ~1 are refused, because a demography that sums to
 * 0.6 is a broken read wearing a distribution's clothes.
 */

export type DemographyShare = {
  label: string;
  /** 0–1 share of the measured sample. */
  share: number;
};

export type AggregatePersonaInput = {
  /** Age/gender shares from Trends demography; must sum to ~1. */
  demography: DemographyShare[];
  /** Funnel stage from search-intent majority; null when unmeasured. */
  funnelStage: "informational" | "commercial" | "transactional" | null;
  /** SERP features observed, as evidence of how the audience reads. */
  serpFeatures: string[];
  /** How many measured responses the shares rest on. */
  sampleSize: number;
};

export type AggregatePersona = {
  /** The leading segment, or null when no share leads. */
  dominantSegment: string | null;
  funnelStage: AggregatePersonaInput["funnelStage"];
  readingHabits: string[];
  sampleSize: number;
  caveat: string;
};

const SHARE_TOLERANCE = 0.02;

/**
 * Build the persona, or refuse the input.
 *
 * Throws VALIDATION-style Errors (plain, catchable) on shares that do not sum
 * and on empty demography: a builder that rendered either would publish a
 * persona from numbers that cannot be a population.
 */
export function aggregatePersona(
  input: AggregatePersonaInput,
): AggregatePersona {
  if (input.demography.length === 0) {
    throw new Error("aggregate persona needs at least one demography share");
  }
  const total = input.demography.reduce((sum, entry) => sum + entry.share, 0);
  if (Math.abs(total - 1) > SHARE_TOLERANCE) {
    throw new Error(
      `demography shares sum to ${total.toFixed(3)}, not ~1 — refusing to render a population from broken reads`,
    );
  }
  let dominant: DemographyShare | null = null;
  for (const entry of input.demography) {
    if (dominant === null || entry.share > dominant.share) dominant = entry;
  }
  const readingHabits = input.serpFeatures.map((feature) => {
    if (feature === "video") return "watches video answers";
    if (feature === "people_also_ask") return "asks follow-up questions";
    if (feature === "images") return "compares visuals";
    return `encounters ${feature}`;
  });
  return {
    dominantSegment: dominant?.label ?? null,
    funnelStage: input.funnelStage,
    readingHabits,
    sampleSize: input.sampleSize,
    caveat:
      `Built from ${input.sampleSize} measured responses across ${input.demography.length} segments` +
      (input.funnelStage === null ? "; funnel stage unmeasured" : "") +
      ". An aggregate of populations, never a person.",
  };
}
