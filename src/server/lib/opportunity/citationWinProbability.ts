/**
 * Citation Win Probability — §7.4's second model: "a logistic on citing-domain features".
 *
 * **Read the honesty note before using the number.** This is an **unfitted** logistic: the
 * coefficients are judgements chosen for direction and monotonicity, not values estimated from
 * outcomes. Which means the output is a **ranking, not a calibrated probability** — the ordering is
 * meaningful today, the absolute value is not, and quoting "37% chance" to a customer before CL-503
 * has stored real wins would be inventing precision. The `calibrated` flag is part of the result so
 * that distinction cannot be lost by a caller who reads only the number.
 *
 * That is also why the version stamp exists. When the nightly jobs have enough outcomes, these
 * coefficients get refitted and `CITATION_MODEL_VERSION` moves — and a stored score stays readable
 * against the model that produced it.
 */

/** Bump when any coefficient below changes, including the intercept. */
export const CITATION_MODEL_VERSION = "1.0.0-unfitted";

export type CitingDomainFeatures = {
  /** The citing page's authority, 0–1. */
  authority: number;
  /** How much the citing page's topic overlaps ours, 0–1. */
  topicalOverlap: number;
  /** Whether this domain already cites us somewhere, which makes a repeat far likelier. */
  alreadyCitesUs: boolean;
  /** Whether the citing page is the kind that cites sources at all, 0–1. */
  citationPropensity: number;
  /** How recently the citing page was updated, 0–1 — recent pages are still being edited. */
  freshness: number;
};

export type CitationWinProbability = {
  /** 0–1. **A ranking signal while `calibrated` is false, not a frequency.** */
  probability: number;
  /**
   * The interval this probability should be read inside.
   *
   * **Not decoration.** The design rule is *"a forecast drawn as a hard line is a
   * lie. Draw the band."*, and this model is the sharpest case for it: the
   * coefficients are **unfitted** (`calibrated: false`), so the point estimate is
   * a ranking signal and its width is the difference between "third on the list"
   * and "about as likely to be cited as the one above it".
   *
   * A caller that renders only `probability` has thrown away the number that says
   * how much the ranking is worth.
   */
  interval: CitationWinInterval;
  version: string;
  /** False until CL-503's stored outcomes refit these coefficients. */
  calibrated: boolean;
  /** Each feature's push on the log-odds, so the ranking can be explained. */
  contributions: Record<keyof CitingDomainFeatures, number>;
};

/**
 * The band, in the same unit as `probability`.
 *
 * ## Why it is wide by construction, and wide for a reason
 *
 * Two sources of uncertainty, both real, neither optional:
 *
 * 1. **Measurement.** Every feature is 0–1 and none of them is measured exactly. An
 *    authority estimate has a standard error; a topical-overlap estimate more so.
 *    A feature with no uncertainty supplied is treated as *unmeasured*, which is the
 *    widest case — **never zero**, because a zero standard error claims a precision
 *    this model does not have and would narrow the band on the least-known inputs.
 *
 * 2. **The model is unfitted.** `calibrated: false`, so the coefficients are a prior
 *    rather than a fit. That contributes a flat term on the log-odds scale rather
 *    than a feature, because it is not about any one input.
 *
 * The interval is computed on the **log-odds** scale — where the uncertainty is
 * roughly symmetric and the logistic is not — and mapped through the logistic at the
 * ends, so it never leaves 0–1 and never goes to zero width at the boundaries.
 */
export type CitationWinInterval = {
  low: number;
  high: number;
  /**
   * The dominant source of the uncertainty, so a reader can see *why* the band is
   * the width it is. `"uncalibrated"` wins over `"features"` because a prior is a
   * bigger statement than a measurement.
   */
  width: number;
  dominantSource: "uncalibrated" | "features";
};

/**
 * How wide an *unmeasured* feature is on the log-odds scale.
 *
 * ±1.5 in log-odds is roughly a factor of 4.5 in odds either way — deliberately
 * generous, because **the narrowest honest band on a feature nobody measured is
 * still wide**, and a model that reports a tight interval on inputs it has no data
 * about is the over-confidence that makes a prospect list useless.
 */
const UNMEASURED_FEATURE_SE = 1.5;

/**
 * The flat log-odds uncertainty contributed by an unfitted model.
 *
 * ±1.0 in log-odds is roughly a factor of 2.7 in odds either way. This is the honest
 * price of a prior: it is why `probability` is documented as a ranking signal and
 * not a frequency, and it disappears the day CL-503's stored outcomes refit the
 * coefficients — at which point `calibrated` flips and this term goes to zero.
 */
const UNFITTED_MODEL_SE = 1.0;

/**
 * The intercept is negative, and that is the most important number in this file: **most pages do
 * not win a citation from any given domain**. A model without that prior rates any plausible-looking
 * target as likely, which is exactly the over-optimism that makes a prospect list useless. Starting
 * from "probably not" and letting strong features argue upward is both truer and more useful.
 */
export const CITATION_INTERCEPT = -4;

/**
 * Coefficients, in log-odds. `alreadyCitesUs` is the largest because an established relationship is
 * the single strongest predictor available and the cheapest to act on — it is why "who already
 * mentions us" is a better list than "who should".
 */
const COEFFICIENTS: Record<keyof CitingDomainFeatures, number> = {
  authority: 2.1,
  topicalOverlap: 2.6,
  alreadyCitesUs: 2.8,
  citationPropensity: 1.8,
  freshness: 0.7,
};

/**
 * The feature list, in one place — derived from the coefficient table, so a
 * feature added to the model cannot be forgotten by this loop and no cast is
 * needed to index `COEFFICIENTS`.
 */
// Narrowed by filtering rather than by asserting: `Object.keys` returns `string[]`,
// and the cast the type-aware linter rejects is exactly the unsafe widening this
// module's other loops avoid by iterating FEATURES instead of Object.entries.
const FEATURES: Array<keyof CitingDomainFeatures> = [
  "authority",
  "topicalOverlap",
  "alreadyCitesUs",
  "citationPropensity",
  "freshness",
];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const logistic = (z: number) => 1 / (1 + Math.exp(-z));

/** Score one citing domain as a citation target. */
export function citationWinProbability(
  features: CitingDomainFeatures,
  /**
   * Each feature's standard error on the 0–1 scale. **Omit a feature and it is
   * treated as unmeasured**, which is the widest case rather than the narrowest —
   * the direction that keeps a weakly-known target from looking precise.
   */
  standardErrors?: Partial<Record<keyof CitingDomainFeatures, number>>,
): CitationWinProbability {
  const contributions: Record<keyof CitingDomainFeatures, number> = {
    authority: COEFFICIENTS.authority * clamp01(features.authority),
    topicalOverlap:
      COEFFICIENTS.topicalOverlap * clamp01(features.topicalOverlap),
    alreadyCitesUs:
      COEFFICIENTS.alreadyCitesUs * (features.alreadyCitesUs ? 1 : 0),
    citationPropensity:
      COEFFICIENTS.citationPropensity * clamp01(features.citationPropensity),
    freshness: COEFFICIENTS.freshness * clamp01(features.freshness),
  };

  const logOdds =
    CITATION_INTERCEPT +
    Object.values(contributions).reduce((sum, part) => sum + part, 0);

  /**
   * Uncertainty, accumulated on the log-odds scale.
   *
   * **Each feature's standard error on its own scale, scaled by the coefficient**,
   * because the coefficient is what turns a 0–1 wobble into a log-odds wobble — a
   * high-coefficient feature pushes the band wider for the same relative
   * uncertainty, which is the correct behaviour and also why an unmeasured
   * `alreadyCitesUs` dominates everything else.
   *
   * Combined in quadrature, not summed: these are independent sources, and summing
   * them would produce a band that grows as the square of the number of features.
   */
  // Iterate the feature keys directly rather than `Object.entries(contributions)`,
  // so the key is already `keyof CitingDomainFeatures` and no cast is needed — the
  // type-aware linter rejects the cast, and rightly: a widened `string` key would
  // index `COEFFICIENTS` unsafely.
  const featureVariance = FEATURES.reduce((total, feature) => {
    const se = standardErrors?.[feature];
    const scale = se === undefined || se <= 0 ? UNMEASURED_FEATURE_SE : se;
    return total + (COEFFICIENTS[feature] * scale) ** 2;
  }, 0);

  const featureSe = Math.sqrt(featureVariance);
  const modelSe = UNFITTED_MODEL_SE;

  const intervalSe = Math.sqrt(featureSe * featureSe + modelSe * modelSe);
  const [low, high] = [
    logistic(logOdds - intervalSe),
    logistic(logOdds + intervalSe),
  ];

  return {
    probability: logistic(logOdds),
    interval: {
      low,
      high,
      width: high - low,
      /**
       * **The prior outranks the measurement**, because it is the bigger statement:
       * a fitted model may still be uncertain about a target, but an unfitted one is
       * uncertain about *itself*. Naming the source means a reader can tell which
       * part a refit will shrink.
       */
      dominantSource: modelSe >= featureSe ? "uncalibrated" : "features",
    },
    version: CITATION_MODEL_VERSION,
    calibrated: false,
    contributions,
  };
}
