import {
  type ContentFormat,
  type ContentIntent,
  formatForElement,
  formatsForIntent,
} from "@/server/features/content/intent-format";
import {
  OPPORTUNITY_SCORE_VERSION,
  opportunityScore,
} from "@/server/lib/opportunity/opportunityScore";

/**
 * What to Build (CL-717): content gaps ranked into a build list.
 *
 * The pipeline, in order: a keyword competitors rank for and we do not is a
 * *candidate*; its intent decides which formats are even eligible (an unknown
 * intent excludes rather than defaults); the SERP elements on its page decide
 * the format within the eligible set; then `opportunityScore` prices the bet
 * and volume × trend order the list. Every stage can refuse, and a refusal
 * carries the reason — a keyword that cannot be priced is listed as
 * unpriced, never as zero, because zero would top-or-bottom the ranking
 * silently depending on the sort direction.
 *
 * Pure like the scorer: no I/O, no clock, no vendor call. The vendor reads
 * (intersection gaps, intent labels, SERP elements, volume/KD/trend/ETV) arrive
 * as arguments from the caller, which is where the metering and the dry-run
 * quote already live.
 */

export type BuildCandidate = {
  keyword: string;
  /** Monthly search volume; null means unmeasured, never zero. */
  volume: number | null;
  keywordDifficulty: number;
  serpCompetitors: number;
  /** Vendor intent label; "unknown" is first-class and excludes formats. */
  intent: ContentIntent | "unknown";
  aiNativeRatio: number;
  rankElasticity: number;
  /** Recent direction multiplier, 0–2 where 1 is flat. Null when unknown. */
  trendFactor: number | null;
  /** ETV for context and tiebreaks; null when the series carries none. */
  etv: number | null;
  /** SERP element types observed on the keyword's page. */
  serpElements: string[];
  /** Competitor domains already covering it, for the brief. */
  competitorDomains: string[];
};

export type BuildRecommendation = {
  keyword: string;
  /** Eligible formats, intent first, SERP-element winner first — never an ineligible one. */
  formats: ContentFormat[];
  /**
   * An ineligible SERP winner, kept as evidence rather than advice: the
   * SERP shows it, the intent table does not bless it, and merging the two
   * would let consumers build a format the contract never recommended.
   */
  serpEvidence: ContentFormat | null;
  /** 0–100 from the opportunity scorer, with its version attached. */
  score: number;
  scoreVersion: string;
  /** Why this rank: the sentence an editor reads before the number. */
  reason: string;
  trendFactor: number | null;
  etv: number | null;
  competitorDomains: string[];
};

export type UnpricedCandidate = {
  keyword: string;
  /** Why it could not be priced: no volume, no eligible format, or both. */
  reason: string;
};

const VOLUME_SCALE = 6;

function volumeWeight(volume: number): number {
  return Math.log10(volume + 1) / VOLUME_SCALE;
}

/**
 * Rank candidates into a build list plus an explicit unpriced list.
 *
 * Ordering is score × volume-weight × trend, computed in that named order so
 * the ranking reads as a sentence: the best bet, at real volume, moving our
 * way. ETV breaks ties (a tie broken arbitrarily is a tie broken silently).
 * Unknown trend counts as flat (×1) rather than excluding — flat is news,
 * missing volume is not a measurement.
 */
export function whatToBuild(candidates: BuildCandidate[]): {
  build: BuildRecommendation[];
  unpriced: UnpricedCandidate[];
} {
  const ranked: { recommendation: BuildRecommendation; rank: number }[] = [];
  const unpriced: UnpricedCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.volume === null || candidate.volume <= 0) {
      unpriced.push({
        keyword: candidate.keyword,
        reason: "no measured volume — unpriced, never zero",
      });
      continue;
    }
    const intent = candidate.intent;
    if (intent === "unknown") {
      unpriced.push({
        keyword: candidate.keyword,
        reason: "unknown intent excludes formats rather than defaulting",
      });
      continue;
    }
    const formats = formatsForIntent(intent);
    if (formats === null) {
      unpriced.push({
        keyword: candidate.keyword,
        reason: "unknown intent excludes formats rather than defaulting",
      });
      continue;
    }
    const elementWinner = candidate.serpElements
      .map((element) => formatForElement(element))
      .find((format): format is ContentFormat => format !== null);
    // The SERP signal leads only inside the intent-eligible set: a video
    // element on a commercial keyword must not outrank the evaluation trio
    // the intent contract names. An ineligible winner trails as evidence.
    const eligibleWinner =
      elementWinner !== undefined && formats.includes(elementWinner)
        ? elementWinner
        : undefined;
    const trailingWinner =
      elementWinner !== undefined && eligibleWinner === undefined
        ? elementWinner
        : undefined;
    const ordered =
      eligibleWinner === undefined
        ? formats
        : [
            eligibleWinner,
            ...formats.filter((format) => format !== eligibleWinner),
          ];

    const scored = opportunityScore({
      keywordDifficulty: candidate.keywordDifficulty,
      serpCompetitors: candidate.serpCompetitors,
      intent,
      aiNativeRatio: candidate.aiNativeRatio,
      rankElasticity: candidate.rankElasticity,
    });
    const trend = candidate.trendFactor ?? 1;
    const rank = scored.score * volumeWeight(candidate.volume) * trend;
    let trendClause = "with no trend read";
    if (candidate.trendFactor !== null) {
      if (candidate.trendFactor > 1) trendClause = "trending up";
      else if (candidate.trendFactor < 1) trendClause = "trending down";
      else trendClause = "trending flat";
    }
    const reason =
      `scores ${scored.score} (${scored.version}) at volume ${candidate.volume} ${trendClause}` +
      (eligibleWinner === undefined
        ? trailingWinner === undefined
          ? ""
          : `; the SERP also shows ${trailingWinner}, outside ${intent} formats`
        : `; the SERP asks for ${eligibleWinner}`);
    const recommendation: BuildRecommendation = {
      keyword: candidate.keyword,
      formats: ordered,
      serpEvidence: trailingWinner ?? null,
      score: scored.score,
      scoreVersion: OPPORTUNITY_SCORE_VERSION,
      reason,
      trendFactor: candidate.trendFactor,
      etv: candidate.etv,
      competitorDomains: candidate.competitorDomains,
    };

    // Highest rank first; ETV breaks ties so equal ranks never depend on input
    // order. Insertion-ordered, not sorted: the repo bans `Array#sort()`.
    let at = ranked.length;
    for (const [index, placed] of ranked.entries()) {
      if (
        rank > placed.rank ||
        (rank === placed.rank &&
          (candidate.etv ?? -1) > (placed.recommendation.etv ?? -1))
      ) {
        at = index;
        break;
      }
    }
    ranked.splice(at, 0, { recommendation, rank });
  }

  return {
    build: ranked.map((entry) => entry.recommendation),
    unpriced,
  };
}
