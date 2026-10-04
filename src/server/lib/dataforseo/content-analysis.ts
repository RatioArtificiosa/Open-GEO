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
import {
  countMap,
  countsOf,
  toDomainRows,
} from "@/server/lib/dataforseo/content-analysis-shapes";

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

/** 0-1 thresholds are clamped rather than passed through: an out-of-range
 *  value is a billed rejection, and the useful reading is "clamped", not
 *  "the server refused it". */
function clampThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
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

/**
 * `content_analysis/phrase_trends` — the same citation data over a date range.
 *
 * ## This is the web side over time, not an AI reading
 *
 * `phrase_trends` returns one result per date bucket, each carrying the *same*
 * `connotation_types` / `top_domains` shape as `summary`. So it is
 * `summary` with a time axis — and **it says nothing about what AI engines
 * think.** Worth stating plainly, because it is tempting to read a
 * per-date series as "how sentiment is moving" and quote it as though it
 * covered both audiences. It covers the vendor's index of citing pages,
 * which is the web half of CL-306's comparison and only that half.
 *
 * ## `date_from` is REQUIRED and `date_to` defaults to today
 *
 * Unlike every sibling, an omitted `date_from` is a **billed rejection**
 * rather than a default. Historical data starts **2022-10-31**, so a range
 * starting earlier is asking for months that do not exist — which would
 * come back as an empty series rather than an error, and read as "nothing
 * was ever said about this topic". So the floor is enforced here and named
 * in the error, because "no data" and "you asked for a year we do not have"
 * are different answers.
 *
 * **`internal_list_limit` defaults to 1 here too**, as on `summary`.
 *
 * Verified against the live documentation on 2026-10-04.
 */

const TRENDS_PATH = "/v3/content_analysis/phrase_trends/live";

/** Documented start of the vendor's history for this endpoint. */
export const PHRASE_TRENDS_HISTORY_FLOOR = "2022-10-31";

/** Documented maximum for the internal arrays, same as `summary`. */
const MAX_TRENDS_LIST_LIMIT = 20;

const trendsResultSchema = z
  .object({
    type: z.string().optional(),
    /** The bucket this row covers: `YYYY-MM-DD`, per `date_group`. */
    date: z.string().nullish(),
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

type PhraseTrendPoint = {
  /** The bucket start, ISO. */
  date: string | null;
  totalCount: number | null;
  rank: number | null;
  positiveShare: number | null;
  polarity: { positive: number; negative: number; neutral: number };
  topDomains: Array<{ domain: string; count: number }>;
};

/** Module-private until a caller names it; knip enforces that an export nobody
 *  consumes is a lie about the API surface. */
type PhraseTrendsResult = {
  keyword: string;
  dateFrom: string;
  dateTo: string | null;
  dateGroup: "day" | "week" | "month";
  searchMode: "as_is" | "one_per_domain";
  points: PhraseTrendPoint[];
  /**
   * A worded direction, never a percentage: "rising" / "falling" / "flat".
   *
   * The same refusal as `sentimentComparison`: a percentage over these counts
   * would be arithmetic whose denominator changes month to month, since
   * `total_count` swings by an order of magnitude between buckets. The words
   * are defensible; the ratio is not.
   */
  direction: "rising" | "falling" | "flat" | null;
  basis: string;
};

export async function fetchPhraseTrends(input: {
  keyword: string;
  /** Required by the vendor. ISO `YYYY-MM-DD`. */
  dateFrom: string;
  /** Defaults to today server-side; recorded either way. */
  dateTo?: string;
  dateGroup?: "day" | "week" | "month";
  searchMode?: "as_is" | "one_per_domain";
  internalListLimit?: number;
}): Promise<DataforseoApiResponse<PhraseTrendsResult>> {
  const keyword = input.keyword.trim();
  if (keyword.length === 0) {
    throw new AppError("VALIDATION_ERROR", "keyword is required");
  }

  const dateFrom = input.dateFrom.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "date_from is required by DataForSEO and must be YYYY-MM-DD. An omitted date_from is a billed rejection, not a default.",
    );
  }
  // The floor is enforced here rather than discovered as an empty series: a
  // range that starts before the vendor's history returns nothing, and
  // "nothing" reads as "nothing was ever said" rather than "we have no data
  // for that year".
  if (dateFrom < PHRASE_TRENDS_HISTORY_FLOOR) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO holds phrase_trends history from ${PHRASE_TRENDS_HISTORY_FLOOR}; ${dateFrom} is before it. Asking for earlier data returns an empty series, which reads as "nothing was ever said about this topic".`,
    );
  }

  const dateGroup = input.dateGroup ?? "month";
  const searchMode = input.searchMode ?? "as_is";

  // **Validated before the billed post, like `dateFrom`.** A malformed
  // `date_to` is a rejection the customer pays for, and a `date_to` earlier
  // than `date_from` is a range that cannot exist — which would come back as
  // an empty series and read as "nothing was ever said" rather than "that
  // range is backwards". Normalised once here and used for both the request
  // and the returned record, so the two cannot disagree.
  const dateTo = input.dateTo?.trim() || null;
  if (dateTo !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "date_to must be YYYY-MM-DD when supplied. A malformed date is a billed rejection, not a default.",
      );
    }
    if (dateTo < dateFrom) {
      throw new AppError(
        "VALIDATION_ERROR",
        `date_to (${dateTo}) is earlier than date_from (${dateFrom}). That range contains no months, and DataForSEO would return an empty series that reads as "nothing was ever said".`,
      );
    }
  }

  const listLimit = Math.min(
    MAX_TRENDS_LIST_LIMIT,
    Math.max(1, Math.floor(input.internalListLimit ?? 10)),
  );

  const response = await dataforseoPost(
    TRENDS_PATH,
    [
      {
        keyword,
        date_from: dateFrom,
        ...(dateTo ? { date_to: dateTo } : {}),
        date_group: dateGroup,
        search_mode: searchMode,
        // Sent explicitly: the default is 1, so a caller who does not ask gets
        // one domain and reads it as a leaderboard.
        internal_list_limit: listLimit,
      },
    ],
    NO_RETRY_BILLED_POST,
  );

  const task = assertOk(response, {
    classify: classifyContentAnalysisError,
    classifyPath: TRENDS_PATH,
  });

  const raw = z.array(trendsResultSchema).safeParse(task.result ?? []);
  if (!raw.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO content_analysis/phrase_trends returned an unexpected payload",
    );
  }

  const points: PhraseTrendPoint[] = raw.data.map((row) => {
    const positive = row.connotation_types?.positive ?? 0;
    const negative = row.connotation_types?.negative ?? 0;
    const neutral = row.connotation_types?.neutral ?? 0;
    const classified = positive + negative + neutral;
    return {
      date: row.date ?? null,
      totalCount: row.total_count ?? null,
      rank: row.rank ?? null,
      positiveShare: classified > 0 ? positive / classified : null,
      polarity: { positive, negative, neutral },
      topDomains: toDomainRows(row.top_domains),
    };
  });

  return {
    data: {
      keyword,
      dateFrom,
      dateTo,
      dateGroup,
      searchMode,
      points,
      direction: trendDirection(points),
      basis: `Citing pages in DataForSEO's index for "${keyword}", grouped by ${dateGroup}. This is the open web, not an AI engine's reading.`,
    },
    billing: buildTaskBilling(task),
  };
}

/**
 * Word the direction, by comparing the first and last buckets that carry a
 * share — and only when they are far enough apart to be worth saying.
 *
 * **No percentage.** `total_count` swings by an order of magnitude between
 * months for the same keyword, so a change in *share* is not a change in
 * *volume*, and reporting "sentiment fell 12%" would be reading a ratio of
 * two ratios whose denominators moved. Null rather than zero when there are
 * fewer than two usable buckets: one point is a measurement, not a direction.
 */
function trendDirection(
  points: readonly PhraseTrendPoint[],
): PhraseTrendsResult["direction"] {
  const usable = points.filter((point) => point.positiveShare !== null);
  if (usable.length < 2) return null;
  const first = usable[0]?.positiveShare ?? 0;
  const last = usable[usable.length - 1]?.positiveShare ?? 0;
  const gap = last - first;
  if (Math.abs(gap) < 0.02) return "flat";
  return gap > 0 ? "rising" : "falling";
}
