import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import {
  countMap,
  countsOf,
  toDomainRows,
} from "@/server/lib/dataforseo/content-analysis-shapes";

/**
 * `content_analysis/sentiment_analysis` — the polarity and connotation
 * breakdown, split by bucket.
 *
 * Split out of `content-analysis.ts` because the 400-line rule forced it, and
 * because this endpoint's reasoning is genuinely a different shape from its
 * two siblings': `summary` is one aggregate and `phrase_trends` is that
 * aggregate over dates. This one is **two distributions over the same corpus,
 * keyed differently** — which is the whole thing worth reading.
 *
 * ## The shape is nested, and that is the point
 *
 * - `positive_connotation_distribution` — split by **polarity**
 *   (positive / negative / neutral)
 * - `sentiment_connotation_distribution` — split by **emotion** (anger,
 *   happiness, love, sadness, share, fun)
 *
 * Each bucket is a *whole* `content_analysis_summary` — its own
 * `total_count`, `rank`, `top_domains`, and its own `connotation_types`.
 * So a negative-polarity bucket still contains `happiness: 87373` cites.
 *
 * **That is not a contradiction and it is the most useful fact on the page:**
 * "650 cited articles are anger-coded" reads like outrage until you see that
 * 87,373 of the *negative* bucket are happiness-coded — they are articles
 * *about* anger, not angry articles. A product that flattened this into two
 * lists would report a brand as widely hated on the strength of articles
 * written about other people's anger.
 *
 * ## `null` is a value here, not an absence
 *
 * The documented sample has `"organization": null` inside `page_types`. That
 * means "no citations in that page type", not "we did not measure it" — a real
 * measured zero with no articles behind it. Dropping nullish entries would
 * erase the difference between "blogs dominate this topic" and "this topic is
 * only ever discussed in forums".
 *
 * ## `total_count` differs per bucket, so nothing here may be summed
 *
 * `positive: 2986476`, `negative: 1683708`, `neutral: 2854419` overlap: a
 * single page can carry several connotations and each bucket counts it once
 * per distribution. Adding them, or taking a share of their sum, produces a
 * number that looks like a sentiment score and is not one.
 *
 * Verified against the live documentation on 2026-10-04.
 */

const PATH = "/v3/content_analysis/sentiment_analysis/live";

const POLARITIES = ["positive", "negative", "neutral"] as const;
const CONNOTATIONS = [
  "anger",
  "happiness",
  "love",
  "sadness",
  "share",
  "fun",
] as const;

type Polarity = (typeof POLARITIES)[number];
type Connotation = (typeof CONNOTATIONS)[number];

const classifyError = createDataforseoBillingClassifier({
  pathPrefix: "/content_analysis/",
  billingIssueCode: "BACKLINKS_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

/** Documented maximum for the internal arrays. */
const MAX_INTERNAL_LIST_LIMIT = 20;

/** The vendor's own defaults, sent explicitly so the answer is reproducible. */
const DEFAULT_CONNOTATION_THRESHOLD = 0.4;

/**
 * One bucket, as a `content_analysis_summary`.
 *
 * `pageTypes` and `countries` keep their nulls — see the module note.
 */
const bucketSchema = z
  .object({
    total_count: z.number().nullish(),
    rank: z.number().nullish(),
    top_domains: z
      .array(
        z
          .object({
            domain: z.string().nullish(),
            count: z.number().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    sentiment_connotations: z
      .record(z.string(), z.number().nullish())
      .nullish(),
    connotation_types: countMap.nullish(),
    page_types: z.record(z.string(), z.number().nullish()).nullish(),
    countries: z.record(z.string(), z.number().nullish()).nullish(),
  })
  .passthrough();

const resultSchema = z
  .object({
    positive_connotation_distribution: z
      .record(z.string(), bucketSchema.nullish())
      .nullish(),
    sentiment_connotation_distribution: z
      .record(z.string(), bucketSchema.nullish())
      .nullish(),
  })
  .passthrough();

/** Module-private: the metered client's inferred types carry these, and knip
 *  enforces that an export nobody names is a lie about the API surface. */
type SentimentBucket = {
  /** Citations in this bucket. Never summed with another bucket. */
  totalCount: number | null;
  rank: number | null;
  /** Inside this bucket only — a negative-polarity bucket has plenty of these. */
  connotations: Record<string, number>;
  /** Inside this bucket only, which is a third number again. */
  polarityWithinBucket: { positive: number; negative: number; neutral: number };
  topDomains: Array<{ domain: string; count: number }>;
  /** Nulls preserved: "no citations in that page type" is a measurement. */
  pageTypes: Record<string, number | null>;
  countries: Record<string, number | null>;
};

/** Keep nulls — unlike `countsOf`, which drops them as absent. */
function nullableCountsOf(
  raw: Record<string, number | null | undefined> | null | undefined,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) out[key] = null;
    else if (typeof value === "number") out[key] = value;
  }
  return out;
}

function readBucket(
  raw: z.infer<typeof bucketSchema> | null | undefined,
): SentimentBucket | null {
  if (!raw) return null;
  return {
    totalCount: raw.total_count ?? null,
    rank: raw.rank ?? null,
    connotations: countsOf(raw.sentiment_connotations),
    polarityWithinBucket: {
      positive: raw.connotation_types?.positive ?? 0,
      negative: raw.connotation_types?.negative ?? 0,
      neutral: raw.connotation_types?.neutral ?? 0,
    },
    topDomains: toDomainRows(raw.top_domains),
    pageTypes: nullableCountsOf(raw.page_types),
    countries: nullableCountsOf(raw.countries),
  };
}

/** Module-private: see `SentimentBucket` above. */
type SentimentAnalysisResult = {
  keyword: string;
  /** Split by polarity. Buckets overlap and are never summed. */
  byPolarity: Partial<Record<Polarity, SentimentBucket>>;
  /** Split by emotion. Same overlap, same rule. */
  byConnotation: Partial<Record<Connotation, SentimentBucket>>;
  /**
   * The polarity with the most citations, or null when fewer than two buckets
   * carry a count. **A label, not a percentage** — the buckets overlap, so no
   * share of their sum is a sentiment score.
   */
  dominantPolarity: Polarity | null;
  basis: string;
};

/**
 * The polarity with the most citations, or null when that is ambiguous.
 *
 * **A tie returns null.** The first version walked `POLARITIES` and kept the
 * first strict maximum, so two equal buckets reported whichever came first in
 * the array — a confident winner read off the declaration order rather than
 * off the data. That is the same defect this product refuses everywhere
 * else: reporting a finding the measurement did not earn. `positive` and
 * `neutral` tying is a real state, and the honest reading of it is "no
 * dominant polarity", not whichever one the code happened to visit first.
 *
 * Null rather than zero when fewer than two buckets carry a count: one bucket
 * is a measurement, not a comparison.
 */
function dominantOf(
  byPolarity: SentimentAnalysisResult["byPolarity"],
): Polarity | null {
  const present = POLARITIES.filter((key) => {
    const count = byPolarity[key]?.totalCount;
    return typeof count === "number";
  });
  if (present.length < 2) return null;

  let best: Polarity | null = null;
  let bestCount = -1;
  let tied = false;
  for (const key of present) {
    const count = byPolarity[key]?.totalCount ?? -1;
    if (count > bestCount) {
      best = key;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}

function clampThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export async function fetchSentimentAnalysis(input: {
  keyword: string;
  internalListLimit?: number;
  positiveConnotationThreshold?: number;
  sentimentsConnotationThreshold?: number;
}): Promise<DataforseoApiResponse<SentimentAnalysisResult>> {
  const keyword = input.keyword.trim();
  if (keyword.length === 0) {
    throw new AppError("VALIDATION_ERROR", "keyword is required");
  }

  const listLimit = Math.min(
    MAX_INTERNAL_LIST_LIMIT,
    Math.max(1, Math.floor(input.internalListLimit ?? 10)),
  );
  const positiveThreshold = clampThreshold(
    input.positiveConnotationThreshold,
    DEFAULT_CONNOTATION_THRESHOLD,
  );
  const sentimentThreshold = clampThreshold(
    input.sentimentsConnotationThreshold,
    DEFAULT_CONNOTATION_THRESHOLD,
  );

  const response = await dataforseoPost(
    PATH,
    [
      {
        keyword,
        // Sent explicitly: this endpoint's default is 1, so a caller who does
        // not ask gets one domain and reads it as a leaderboard.
        internal_list_limit: listLimit,
        // Both thresholds *remove rows* from the response, so they change the
        // question rather than filtering one answer.
        positive_connotation_threshold: positiveThreshold,
        sentiments_connotation_threshold: sentimentThreshold,
      },
    ],
    NO_RETRY_BILLED_POST,
  );

  const task = assertOk(response, {
    classify: classifyError,
    classifyPath: PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO content_analysis/sentiment_analysis returned an unexpected payload",
    );
  }

  const byPolarity: SentimentAnalysisResult["byPolarity"] = {};
  for (const key of POLARITIES) {
    const bucket = readBucket(
      raw.data.positive_connotation_distribution?.[key],
    );
    if (bucket) byPolarity[key] = bucket;
  }
  const byConnotation: SentimentAnalysisResult["byConnotation"] = {};
  for (const key of CONNOTATIONS) {
    const bucket = readBucket(
      raw.data.sentiment_connotation_distribution?.[key],
    );
    if (bucket) byConnotation[key] = bucket;
  }

  return {
    data: {
      keyword,
      byPolarity,
      byConnotation,
      dominantPolarity: dominantOf(byPolarity),
      basis: `Citations in DataForSEO's index for "${keyword}", split by the vendor's classification. The buckets overlap — a page can appear in several — so they are never summed. This is the open web, not an AI engine's reading.`,
    },
    billing: buildTaskBilling(task),
  };
}
