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
  version: string;
  /** False until CL-503's stored outcomes refit these coefficients. */
  calibrated: boolean;
  /** Each feature's push on the log-odds, so the ranking can be explained. */
  contributions: Record<keyof CitingDomainFeatures, number>;
};

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

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const logistic = (z: number) => 1 / (1 + Math.exp(-z));

/** Score one citing domain as a citation target. */
export function citationWinProbability(
  features: CitingDomainFeatures,
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

  return {
    probability: logistic(logOdds),
    version: CITATION_MODEL_VERSION,
    calibrated: false,
    contributions,
  };
}
