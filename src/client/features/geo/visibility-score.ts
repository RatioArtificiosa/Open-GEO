/**
 * The AI Visibility Score.
 *
 * A 0–100 composite, published openly, with every component click-through to its
 * evidence. The formula is fixed in `WEIGHTS` and the components are named, so a
 * customer can check the arithmetic rather than trust a badge.
 *
 * The one thing this file refuses to do is **sum across platforms**. It is the
 * exact mistake CL-135 shipped, and a composite is where it hides best: a single
 * headline number is the most persuasive place in the product to put a
 * meaningless total. So the score is computed **per platform** and the UI shows
 * one score per platform, and there is no combined one.
 *
 * A component that cannot be computed is `null`, never zero. A brand with no
 * citation data has an *unknown* citation score, and scoring it zero would tell
 * them to fix something they have not measured. The weights are then applied
 * only over the components that exist, and the result says how much of the score
 * it could actually stand on — `coverage` — so a "72" computed from two of four
 * components does not read like a "72" computed from four.
 */

/** Fixed and published. Changing a weight changes the product's meaning. */
export const WEIGHTS = {
  /** How often the brand is mentioned, relative to the category median. */
  mentionCoverage: 0.4,
  /** The brand's share of tracked competitor mentions. */
  shareOfVoice: 0.25,
  /** Quality and recency of the domains citing the brand. */
  citationAuthority: 0.2,
  /** 13-week direction, plus new-minus-lost. */
  momentum: 0.15,
} as const;

export type ScoreComponentId = keyof typeof WEIGHTS;

export type ScoreComponent = {
  id: ScoreComponentId;
  /** 0–100, or null when it could not be computed. */
  value: number | null;
  weight: number;
  /** One line the reader can check the number against. */
  evidence: string;
};

export type VisibilityScore = {
  /** 0–100 over the components that exist, or null when none could. */
  score: number | null;
  platform: string;
  components: ScoreComponent[];
  /**
   * How much of the intended weight the score actually stands on, 0–1.
   * A score computed from half the components is not the same claim as one
   * computed from all of them, and this is what lets the UI say so.
   */
  coverage: number;
  /** Components that could not be computed, named. */
  missing: ScoreComponentId[];
};

/** Inputs, all per platform and all pre-aggregated by the caller. */
export type ScoreInputs = {
  platform: string;
  /** 0–100 already scaled against the category median. */
  mentionCoverage: number | null;
  /** 0–100, or null when no competitors were tracked. */
  shareOfVoice: number | null;
  /** 0–100, or null when nothing cites the brand yet. */
  citationAuthority: number | null;
  /** 0–100, or null with fewer than two measured months. */
  momentum: number | null;
  evidence: Partial<Record<ScoreComponentId, string>>;
};

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

const DEFAULT_EVIDENCE: Record<ScoreComponentId, string> = {
  mentionCoverage:
    "Mentions for this platform, scaled against the median for brands in the same category.",
  shareOfVoice:
    "Your mentions divided by the mentions of the competitors you track. Needs at least one competitor.",
  citationAuthority:
    "Quality and recency of the domains citing you. Null until something cites the brand.",
  momentum:
    "Direction of the 13-week series plus new minus lost mentions. Null with fewer than two measured months.",
};

/**
 * The component ids, derived from `WEIGHTS` rather than listed again, so a
 * weight added there appears in the table automatically.
 *
 * A guard rather than a cast: `Object.keys` returns `string[]`, and asserting it
 * to the union would compile even if a key were misspelled — the component would
 * then silently score zero instead of failing. This returns null for anything
 * unrecognised, and `filter` drops it.
 */
function isComponentId(value: string): value is ScoreComponentId {
  return Object.hasOwn(WEIGHTS, value);
}

const COMPONENT_IDS = Object.keys(WEIGHTS).filter(isComponentId);

/**
 * Compute the score for one platform.
 *
 * Null in, null out — per component. A component with no data contributes
 * nothing to the weighted mean and is listed in `missing`, so the arithmetic
 * stays honest about what it rested on.
 */
export function computeVisibilityScore(inputs: ScoreInputs): VisibilityScore {
  const components: ScoreComponent[] = COMPONENT_IDS.map((id) => {
    const raw = inputs[id];
    return {
      id,
      value: raw === null || raw === undefined ? null : clampScore(raw),
      weight: WEIGHTS[id],
      evidence: inputs.evidence[id] ?? DEFAULT_EVIDENCE[id],
    };
  });

  const present = components.filter(
    (component): component is ScoreComponent & { value: number } =>
      component.value !== null,
  );
  const missing = components
    .filter((component) => component.value === null)
    .map((component) => component.id);

  if (present.length === 0) {
    return {
      score: null,
      platform: inputs.platform,
      components,
      coverage: 0,
      missing,
    };
  }

  // The weighted mean is taken over the components that *exist*, with their
  // weights renormalised among themselves so the result is still on a 0–100
  // scale. Without that, a brand with one strong component would look worse than
  // one with four mediocre ones purely for having less data — and `coverage` is
  // what stops the rescaling from being a lie.
  const availableWeight = present.reduce(
    (sum, component) => sum + component.weight,
    0,
  );
  const weightedMean = present.reduce((sum, component) => {
    const share = component.weight / availableWeight;
    return sum + component.value * share;
  }, 0);

  return {
    score: Math.round(weightedMean),
    platform: inputs.platform,
    components,
    coverage: Math.round(availableWeight * 100) / 100,
    missing,
  };
}

/**
 * A sentence saying what the score can and cannot claim.
 *
 * Shown under the ring, because a bare "72" invites a reader to treat it as a
 * measurement. This is the difference between a score and a badge.
 */
export function describeVisibilityScore(score: VisibilityScore): string {
  if (score.score === null) {
    return "Not enough measured yet to score this brand.";
  }
  if (score.missing.length === 0) {
    return `${score.score}/100 on ${score.platform}, from all four components.`;
  }
  if (score.coverage <= 0.4) {
    // **Inclusive**, and the test caught it being exclusive. A score resting on
    // the mention-coverage weight alone is 0.4 exactly — one component standing
    // in for four, which is precisely the case this sentence exists for. `<` let
    // the most common thin score through as if it were a measurement.
    return `${score.score}/100 on ${score.platform}, but only ${Math.round(
      score.coverage * 100,
    )}% of the score could be computed — treat it as a direction, not a measurement.`;
  }
  return `${score.score}/100 on ${score.platform}, from ${4 - score.missing.length} of 4 components. Missing: ${score.missing.join(", ")}.`;
}
