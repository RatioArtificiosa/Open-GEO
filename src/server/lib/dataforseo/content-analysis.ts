import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { AppError } from "@/server/lib/errors";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";

/**
 * Content Analysis — what the open web says about a topic, and who says it.
 *
 * ## The number is a count, and reading it as a score is the whole trap
 *
 * `connotation_types` is **how many citing pages the vendor classified**
 * `positive` / `negative` / `neutral`:
 *
 * ```json
 * "connotation_types": { "positive": 261992, "negative": 68043, "neutral": 108682 }
 * ```
 *
 * Those are three numbers over DataForSEO's **whole corpus** for that keyword,
 * not a sample of the pages anyone is about to read. So `261992` is not "the web
 * is positive about Logitech" — it is "of every page in this index that cites
 * the term, 262k were classified positive". The share is offered, and it is
 * named `positiveShare`, because a ratio of three vendor counts is arithmetic we
 * can defend — but its denominator is the vendor's corpus and the response says
 * so.
 *
 * The distinction that matters most: **this is the open web's sentiment, not an
 * AI engine's.** Nothing here says what ChatGPT or an AI Overview thinks about
 * the keyword, and the two are different measurements over different
 * populations. Presenting one as the other is the chart-of-two-currencies defect
 * this product refuses elsewhere, so the type carries no field a caller could
 * mistake for an AI reading.
 *
 * ## `internal_list_limit` defaults to 1 here, and 5 on its siblings
 *
 * Same documented inconsistency as `llm_mentions`: this endpoint's default is
 * **1**, so a caller who does not ask gets one domain and reads it as a
 * leaderboard. Sent explicitly, and clamped to the documented maximum of 20.
 *
 * ## Two filters that silently change what the numbers mean
 *
 * `positive_connotation_threshold` and `sentiments_connotation_threshold` both
 * default to **0.4**, and they *remove rows from the response* — so a summary
 * fetched with a different threshold is not a more filtered view of the same
 * data, it is a **different question**. Both are sent explicitly so the answer
 * is reproducible from the request, and the values are returned alongside it.
 *
 * Verified against the live documentation on 2026-10-03.
 */

const PATH = "/v3/content_analysis/summary/live";

/** Documented maximum for the internal arrays. */
const MAX_INTERNAL_LIST_LIMIT = 20;

/** The vendor's own defaults, sent explicitly so the answer is reproducible. */
const DEFAULT_CONNOTATION_THRESHOLD = 0.4;

const classifyContentAnalysisError = createDataforseoBillingClassifier({
  pathPrefix: "/content_analysis/",
  billingIssueCode: "BACKLINKS_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

const countMap = z
  .object({
    positive: z.number().nullish(),
    negative: z.number().nullish(),
    neutral: z.number().nullish(),
  })
  .passthrough();

const resultSchema = z
  .object({
    type: z.string().optional(),
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
    languages: z.record(z.string(), z.number().nullish()).nullish(),
  })
  .passthrough();

/** Module-private: the metered client's inferred types carry these, and knip
 *  enforces that an export nobody names is a lie about the API surface. */
type ContentAnalysisSummary = {
  keyword: string;
  /** Pages in the vendor's corpus citing this keyword. Not a sample we chose. */
  totalCount: number | null;
  /** The keyword's normalised rank across that corpus. */
  rank: number | null;
  topDomains: Array<{ domain: string; count: number }>;
  /**
   * Emotion labels (`happiness`, `love`, `anger`, …) with citation counts.
   * Absent keys are omitted rather than zero-filled: the vendor returns only
   * the labels it has counts for, and a missing label is not a measured zero.
   */
  sentimentConnotations: Record<string, number>;
  /** Citation counts per polarity. */
  polarity: { positive: number; negative: number; neutral: number };
  /**
   * Positive citations as a fraction of all classified citations, or null when
   * nothing was classified. **Over the vendor's corpus**, which is what the
   * caller needs to know before quoting a percentage.
   */
  positiveShare: number | null;
  /** Every count in the response shares this denominator, so it travels with it. */
  countBasis: string;
  /** The thresholds actually sent, so a cached answer is reproducible. */
  thresholds: {
    positiveConnotation: number;
    sentimentConnotation: number;
  };
  pageTypes: Record<string, number>;
  countries: Record<string, number>;
  languages: Record<string, number>;
};

type ContentAnalysisInput = {
  keyword: string;
  /** How many entries each internal array may hold. 1-20; the vendor's default is 1. */
  internalListLimit?: number;
  /** 0-1. Rows below this are dropped from the response, changing the question. */
  positiveConnotationThreshold?: number;
  /** 0-1. Same, for the emotion labels. */
  sentimentsConnotationThreshold?: number;
};

/** Drop nullish entries so an absent label is not reported as a measured zero. */
function countsOf(
  raw: Record<string, number | null | undefined> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

export async function fetchContentAnalysisSummary(
  input: ContentAnalysisInput,
): Promise<DataforseoApiResponse<ContentAnalysisSummary>> {
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
        // Sent explicitly: this endpoint's default is 1, and a caller who does
        // not ask gets one domain and reads it as a leaderboard.
        internal_list_limit: listLimit,
        positive_connotation_threshold: positiveThreshold,
        sentiments_connotation_threshold: sentimentThreshold,
      },
    ],
    NO_RETRY_BILLED_POST,
  );

  const task = assertOk(response, {
    classify: classifyContentAnalysisError,
    classifyPath: PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO content_analysis/summary returned an unexpected payload",
    );
  }

  const data = raw.data;
  const positive = data.connotation_types?.positive ?? 0;
  const negative = data.connotation_types?.negative ?? 0;
  const neutral = data.connotation_types?.neutral ?? 0;
  const classified = positive + negative + neutral;

  return {
    data: {
      keyword,
      totalCount: data.total_count ?? null,
      rank: data.rank ?? null,
      topDomains: (data.top_domains ?? [])
        .filter(
          (row): row is { domain: string; count: number } =>
            typeof row.domain === "string" && typeof row.count === "number",
        )
        .map((row) => ({ domain: row.domain, count: row.count })),
      sentimentConnotations: countsOf(data.sentiment_connotations),
      polarity: { positive, negative, neutral },
      // Null rather than 0 when nothing was classified: "no pages were
      // classified" and "no pages were positive" are different claims.
      positiveShare: classified > 0 ? positive / classified : null,
      countBasis:
        "Citation counts over DataForSEO's whole index for this keyword — not a sample of pages, and not an AI engine's view.",
      thresholds: {
        positiveConnotation: positiveThreshold,
        sentimentConnotation: sentimentThreshold,
      },
      pageTypes: countsOf(data.page_types),
      countries: countsOf(data.countries),
      languages: countsOf(data.languages),
    },
    billing: buildTaskBilling(task),
  };
}

function clampThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
