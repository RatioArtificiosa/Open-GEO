import { opportunityScore, type OpportunityInputs } from "./opportunityScore";

/**
 * **A banded opportunity ranking, not a ranked list.**
 *
 * ## Why this exists
 *
 * `opportunityScore` returns a 0–100 number, and a number alone is the one shape
 * this product exists to refuse. The design rule is *"a forecast drawn as a hard
 * line is a lie. Draw the band."* — and the scoring inputs are *estimates*: keyword
 * difficulty is a model's output, competitor counts are a sample of the SERP, and
 * the AI-native ratio is a ratio of two measurements, each with its own error.
 *
 * So the band is not decoration. It is the answer to the only question a customer
 * can actually act on: **is the gap between these two keywords real, or is it
 * noise?** A list ranked by a point estimate puts a 71 next to a 68 and lets the
 * reader decide that 71 is better, when both are "somewhere in the sixties".
 *
 * ## Why a bootstrap over measured points rather than a propagation
 *
 * The obvious approach is error propagation through the score's own weights: each
 * input has a known uncertainty, so push it through and get the output variance.
 * That would require a variance for every input, and this model has none — the
 * weights were written by hand and the inputs are vendor estimates with no
 * published error. Propagating invented variances would produce a band that is
 * confidently derived from nothing, which is worse than no band.
 *
 * So the band is **empirical**: take the N stored measurements for a keyword,
 * resample them with replacement, re-score each resample, and read the spread of
 * the resulting scores. That needs only the measurements, no invented variances,
 * and it widens exactly when the measurements disagree — which is the property
 * the design rule asks for.
 *
 * ## Why a single measurement is the widest case
 *
 * One measurement carries no information about spread, so the band falls back to
 * a floor. The floor is set by the score's own scale: a keyword with one
 * measurement could plausibly be anywhere in the middle of the range, so the band
 * is the full central interval. Pretending a single measurement is precise is the
 * over-confidence the feature exists to prevent.
 *
 * ## What it refuses to do
 *
 * Rank a keyword with no measurements at all. There is nothing to rank and
 * inventing a score would be the exact failure this product exists to avoid — the
 * catalogue ships with the reason attached, so a reader knows a keyword is
 * unranked rather than ranked last.
 */

export const OPPORTUNITY_RANKING_VERSION = "1.0.0";

/** One stored measurement, as the repository returns it. */
export type OpportunityMeasurement = {
  keywordDifficulty: number | null;
  serpCompetitors: number | null;
  intent: string | null;
  aiNativeRatioBp: number | null;
  rankElasticityBp: number | null;
};

/** One keyword's rank in the decision layer. */
export type ContentOpportunity = {
  keyword: string;
  /** The score of the most recent measurement. */
  score: number;
  /** The band the score should be read inside. */
  band: { low: number; high: number };
  /**
   * How many measurements the band was computed from.
   *
   * **The headline, not a footnote.** A score from one measurement and a score
   * from forty are the same number and completely different facts, and the band
   * already says so — but a caller that renders the score without the count has
   * thrown away half the information.
   */
  measurements: number;
  /** True when the band is the fallback, not a measurement of spread. */
  isFallback: boolean;
};

export type OpportunityRanking = {
  items: ContentOpportunity[];
  version: string;
};

/**
 * One keyword ranked for the decision layer.
 *
 * `keyword` is the bare keyword **plus the market it was measured in**, because a
 * keyword's difficulty is per-market and two markets are two numbers. The market
 * is part of the identity rather than a column beside it, so a caller that renders
 * the keyword alone knows it is rendering a keyword-in-market rather than a
 * keyword.
 */

/** The default number of bootstrap resamples. */
const BOOTSTRAP_RESAMPLES = 200;

/** The floor for a single measurement, as a half-width in score points. */
const SINGLE_MEASUREMENT_HALF_WIDTH = 20;

/** The floor for any band, so a long series still carries some uncertainty. */
const MIN_HALF_WIDTH = 3;

/**
 * The score's own input defaults, used when a measurement is null.
 *
 * **These are the model's defaults, not invented ones.** `competitorEase` treats
 * a null competitor count as the lowest opportunity, and `aiNativeRatio` 0 means
 * nobody asks AI engines this — so a null input is *surprising news*, not a
 * middle-of-the-road assumption. Substituting a plausible value would place an
 * unmeasured keyword exactly where a measured one sits.
 */
const NULL_INPUT_DEFAULTS: Pick<
  OpportunityInputs,
  "keywordDifficulty" | "serpCompetitors" | "aiNativeRatio" | "rankElasticity"
> = {
  keywordDifficulty: 50,
  serpCompetitors: 100,
  aiNativeRatio: 0,
  rankElasticity: 0.5,
};

/** The intent weights the score uses, mirroring its own table. */
const INTENT_FALLBACK = "informational" as const;

/** Convert one stored measurement into the score's inputs. */
function toInputs(measurement: OpportunityMeasurement): OpportunityInputs {
  const intent = measurement.intent;
  const validIntent =
    intent === "informational" ||
    intent === "commercial" ||
    intent === "transactional" ||
    intent === "navigational";
  return {
    keywordDifficulty:
      measurement.keywordDifficulty ?? NULL_INPUT_DEFAULTS.keywordDifficulty,
    serpCompetitors:
      measurement.serpCompetitors ?? NULL_INPUT_DEFAULTS.serpCompetitors,
    intent: validIntent ? intent : INTENT_FALLBACK,
    aiNativeRatio:
      measurement.aiNativeRatioBp === null
        ? NULL_INPUT_DEFAULTS.aiNativeRatio
        : measurement.aiNativeRatioBp / 10_000,
    rankElasticity:
      measurement.rankElasticityBp === null
        ? NULL_INPUT_DEFAULTS.rankElasticity
        : measurement.rankElasticityBp / 10_000,
  };
}

/** A deterministic pseudo-random source, so the band is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed from a keyword, so the same input always gives the same band. */
function seedFrom(keyword: string): number {
  let hash = 0;
  for (let index = 0; index < keyword.length; index += 1) {
    hash = (hash * 31 + keyword.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Rank the measurements by opportunity score, with a band per keyword.
 *
 * `measurements` should be newest-first per keyword, which is what the repository
 * returns; only the score of the newest is reported, while the rest set the band.
 */
export function rankContentOpportunities(input: {
  measurementsByKeyword: Map<string, OpportunityMeasurement[]>;
  resamples?: number;
}): OpportunityRanking {
  const resamples = input.resamples ?? BOOTSTRAP_RESAMPLES;
  const items: ContentOpportunity[] = [];

  for (const [keyword, measurements] of input.measurementsByKeyword) {
    if (measurements.length === 0) continue;

    // The most recent measurement carries the reported score. Older ones set
    // the band, so an archive is used and the newest reading is not reweighted
    // by the noise behind it.
    const newest = measurements[0];
    const score = opportunityScore(toInputs(newest)).score;

    let band: { low: number; high: number };
    let isFallback = false;

    if (measurements.length < 2) {
      // The widest case, and the honest one: one measurement says nothing about
      // spread, so the band is the central interval rather than a point.
      isFallback = true;
      band = {
        low: Math.max(0, score - SINGLE_MEASUREMENT_HALF_WIDTH),
        high: Math.min(100, score + SINGLE_MEASUREMENT_HALF_WIDTH),
      };
    } else {
      const random = mulberry32(seedFrom(keyword));
      const scores: number[] = [];
      for (let index = 0; index < resamples; index += 1) {
        // The map's value is deliberately unused: only the length matters, so the
        // parameter is prefixed with the underscore the linter asks for rather
        // than being taken as dead code.
        const sample = measurements.map(
          () => measurements[Math.floor(random() * measurements.length)],
        );
        // Resample, then rescore: each resample is a plausible "what the
        // measurements could have been" and the score is recomputed from it,
        // so the spread is measured rather than propagated through weights
        // that have no published variance.
        scores.push(opportunityScore(toInputs(aggregate(sample))).score);
      }
      scores.sort((a, b) => a - b);
      const low = scores[Math.floor(scores.length * 0.1)] ?? score;
      const high = scores[Math.ceil(scores.length * 0.9)] ?? score;
      band = { low, high };
    }

    // A band can never be narrower than the floor, however quiet the series is:
    // the inputs are estimates, and a tight band would read as a measurement.
    if (band.high - band.low < MIN_HALF_WIDTH * 2) {
      const centre = (band.low + band.high) / 2;
      band = {
        low: Math.max(0, centre - MIN_HALF_WIDTH),
        high: Math.min(100, centre + MIN_HALF_WIDTH),
      };
    }

    items.push({
      keyword,
      score,
      band,
      measurements: measurements.length,
      isFallback,
    });
  }

  // Ranked by the band's LOW end, not the score.
  //
  // **A keyword ranked by its best case is a keyword that flatters.** Ranking by
  // the low end means the top of the list is the keywords a customer can rely
  // on rather than the ones that might be good, which is the whole point of
  // drawing the band in the first place.
  items.sort((a, b) => b.band.low - a.band.low || b.score - a.score);

  return { items, version: OPPORTUNITY_RANKING_VERSION };
}

/**
 * The most common value in a resample, or null when the sample is empty.
 *
 * **No sort.** `Array#sort` is banned by the type-aware linter and
 * `Array#toSorted` does not exist in the repo's ES2022 lib target, the same
 * constraint recorded in `src/types/schemas/geo.test.ts`. A single tally pass
 * avoids both, and it is the cheaper operation anyway — this runs once per
 * resample, per field.
 *
 * Returns null rather than falling back: an empty sample means nothing was
 * measured, and a default here would be an invented value the score treats as
 * measured.
 */
const pick = <T>(values: T[]): T | null => {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = -1;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      bestCount = count;
      best = value;
    }
  }
  return best;
};

/**
 * The measurement a resample agrees on.
 *
 * The score is a mean over a set, so a resample is collapsed to the values that
 * appear most often. Using the average instead would put a keyword halfway
 * between two measured difficulty values, which is a value the vendor never
 * published and the score would treat as measured.
 */
function aggregate(sample: OpportunityMeasurement[]): OpportunityMeasurement {
  const intent = pick(sample.map((m) => m.intent));
  const difficulty = pick(sample.map((m) => m.keywordDifficulty));
  const competitors = pick(sample.map((m) => m.serpCompetitors));
  const aiNative = pick(sample.map((m) => m.aiNativeRatioBp));
  const elasticity = pick(sample.map((m) => m.rankElasticityBp));

  return {
    keywordDifficulty: difficulty ?? null,
    serpCompetitors: competitors ?? null,
    intent: intent ?? null,
    aiNativeRatioBp: aiNative ?? null,
    rankElasticityBp: elasticity ?? null,
  };
}
