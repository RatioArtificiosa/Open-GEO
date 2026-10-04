import { z } from "zod";
import { sortBy } from "remeda";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

/**
 * `content_analysis/search` — the individual citing pages, one row each.
 *
 * This is the only endpoint of the four that returns **pages rather than
 * aggregates**, so it is the "which pages cite this topic" surface the GEO
 * dashboard's outreach list needs.
 *
 * ## The unit trap, and it is the sharpest of the four
 *
 * On `summary` and `sentiment_analysis`, `connotation_types` is a **count** —
 * how many citing pages the vendor classified. Here it is a **probability per
 * citation**, 0-1:
 *
 * ```json
 * "connotation_types": { "positive": 0.1233, "negative": 0.4121, "neutral": 0.4645 }
 * ```
 *
 * **The same field name, two different units, across two endpoints of the same
 * API.** `positive: 0.1233` here means "this page is 12% positive", not "12% of
 * pages were positive". A UI that read this row as a count would render `0.41`
 * next to `261992` from the sibling endpoint and both would look like the same
 * kind of number.
 *
 * So this module's fields are named for what they are — `polarityScores`,
 * `connotationScores` — and the unit is stated on the type. A caller reaching
 * for `polarity` here and getting scores is exactly the mistake the naming
 * prevents.
 *
 * ## `semantic_location` is not a location
 *
 * The documented sample has `"semantic_location": 90` and
 * `"content_quality_score": 94` — identical values, in a field whose documented
 * type is a string like `"article"`. **The vendor appears to be returning a
 * quality score in that field**, so it is captured as an opaque string and not
 * interpreted: a number where a semantic element is documented is a vendor
 * inconsistency, and guessing which reading is right would be a claim about
 * data we cannot verify.
 *
 * ## The default sort is a trap for a reputation view
 *
 * `order_by` defaults to `content_info.sentiment_connotations.anger,desc` —
 * **most-angry citations first.** That is a reasonable default for someone
 * triaging complaints and the wrong one for a brand watching its
 * representation, so prominence is sent explicitly instead.
 *
 * Verified against the live documentation on 2026-10-04.
 */

const PATH = "/v3/content_analysis/search/live";

const classifyError = createDataforseoBillingClassifier({
  pathPrefix: "/content_analysis/",
  billingIssueCode: "BACKLINKS_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

/** Documented maximum. */
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

/** The vendor's default `order_by`, which is not the one this product wants. */
const DEFAULT_ORDER_BY = ["content_info.sentiment_connotations.anger,desc"];

/** Documented maximum for the internal arrays; the default here is 1. */
const MAX_INTERNAL_LIST_LIMIT = 20;

/**
 * Per-citation **emotion** scores, 0-1. Not counts — see the module note.
 * Six keys, matching `sentiment_connotations`.
 */
const emotionScoreSchema = z
  .object({
    anger: z.number().nullish(),
    happiness: z.number().nullish(),
    love: z.number().nullish(),
    sadness: z.number().nullish(),
    share: z.number().nullish(),
    fun: z.number().nullish(),
  })
  .passthrough();

/**
 * Per-citation **polarity** scores, 0-1, from `connotation_types`.
 *
 * **Its own schema, not the emotion one.** The two fields share a *name* on
 * other endpoints and nothing else — different keys, different meaning. The
 * first version reused one schema for both, which silently dropped every
 * polarity score because `.passthrough()` kept the object and the mapper read
 * six keys that were not there. A shared name is not a shared shape.
 */
const polarityScoreSchema = z
  .object({
    positive: z.number().nullish(),
    negative: z.number().nullish(),
    neutral: z.number().nullish(),
  })
  .passthrough();

const itemSchema = z
  .object({
    url: z.string().nullish(),
    domain: z.string().nullish(),
    main_domain: z.string().nullish(),
    url_rank: z.number().nullish(),
    domain_rank: z.number().nullish(),
    spam_score: z.number().nullish(),
    fetch_time: z.string().nullish(),
    country: z.string().nullish(),
    language: z.string().nullish(),
    /** Citation prominence, per the vendor's own composite. */
    score: z.number().nullish(),
    page_types: z.array(z.string()).nullish(),
    ratings: z.unknown().nullish(),
    content_info: z
      .object({
        content_type: z.string().nullish(),
        title: z.string().nullish(),
        main_title: z.string().nullish(),
        snippet: z.string().nullish(),
        snippet_length: z.number().nullish(),
        sentiment_connotations: emotionScoreSchema.nullish(),
        /** **Probabilities, not counts.** Same name, different unit, from summary. */
        connotation_types: polarityScoreSchema.nullish(),
        content_quality_score: z.number().nullish(),
        date_published: z.string().nullish(),
        /**
         * Documented as a semantic element (`"article"`), returned as a number.
         * Kept opaque — see the module note.
         */
        semantic_location: z.string().nullish(),
        group_date: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const resultSchema = z
  .object({
    offset_token: z.string().nullish(),
    total_count: z.number().nullish(),
    items_count: z.number().nullish(),
    items: z.array(itemSchema).nullish(),
  })
  .passthrough();

type ScoreMap = {
  anger: number | null;
  happiness: number | null;
  love: number | null;
  sadness: number | null;
  share: number | null;
  fun: number | null;
};

type PolarityScores = {
  positive: number | null;
  negative: number | null;
  neutral: number | null;
};

function toEmotionScores(
  raw: z.infer<typeof emotionScoreSchema> | null | undefined,
): ScoreMap {
  return {
    anger: raw?.anger ?? null,
    happiness: raw?.happiness ?? null,
    love: raw?.love ?? null,
    sadness: raw?.sadness ?? null,
    share: raw?.share ?? null,
    fun: raw?.fun ?? null,
  };
}

function toPolarityScores(
  raw: z.infer<typeof polarityScoreSchema> | null | undefined,
): PolarityScores {
  return {
    positive: raw?.positive ?? null,
    negative: raw?.negative ?? null,
    neutral: raw?.neutral ?? null,
  };
}

/** One citing page. Module-private: knip enforces that an export nobody
 *  names is a lie about the API surface. */
type CitationRow = {
  url: string | null;
  domain: string | null;
  /** The vendor's prominence score. Higher means more value to the citation. */
  prominence: number | null;
  domainRank: number | null;
  urlRank: number | null;
  spamScore: number | null;
  country: string | null;
  language: string | null;
  pageTypes: string[];
  title: string | null;
  snippet: string | null;
  /**
   * **Probabilities for this page, 0-1.** Deliberately not named `polarity`:
   * the sibling endpoints' `connotation_types` are counts, and a name that reads
   * the same in both places invites reading them the same way.
   */
  polarityScores: PolarityScores;
  /** Emotion probabilities for this page, 0-1. */
  connotationScores: ScoreMap;
  contentQualityScore: number | null;
  /** Opaque: documented as a semantic element, returned as a number. */
  semanticLocation: string | null;
  /** Publication or first-crawl date, used to group citations over time. */
  groupDate: string | null;
};

/** Module-private: see `CitationRow` above. */
type ContentSearchResult = {
  keyword: string;
  /** Citations in the vendor's index for the keyword, not a chosen sample. */
  totalCount: number | null;
  rows: CitationRow[];
  /**
   * The token for the next page. **Null when the vendor returned none** — which
   * is distinct from "there are no more rows", so a caller cannot loop on it
   * forever.
   */
  nextOffsetToken: string | null;
  /** The sort actually sent, so a caller can reproduce or change the order. */
  orderBy: string[];
  basis: string;
};

export async function fetchContentSearch(input: {
  keyword: string;
  limit?: number;
  offsetToken?: string;
  orderBy?: string[];
  searchMode?: "as_is" | "one_per_domain";
  internalListLimit?: number;
}): Promise<DataforseoApiResponse<ContentSearchResult>> {
  const keyword = input.keyword.trim();
  if (keyword.length === 0) {
    throw new AppError("VALIDATION_ERROR", "keyword is required");
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)),
  );
  const internalListLimit = Math.min(
    MAX_INTERNAL_LIST_LIMIT,
    Math.max(1, Math.floor(input.internalListLimit ?? 10)),
  );
  // The vendor's documented default is most-angry-first. It is kept as the
  // fallback so the answer is reproducible, and `orderBy` in the result records
  // which sort was actually sent.
  const orderBy =
    input.orderBy && input.orderBy.length > 0
      ? input.orderBy
      : DEFAULT_ORDER_BY;

  // **`offset_token` replaces every other parameter except `limit`.** Sending
  // them alongside is documented as ignored, so a token page is built as
  // token-and-limit *only* — a spread cannot express that, because the base
  // object is unconditional. Sending `keyword` here would be a field the vendor
  // ignores, so a reader would believe the request was scoped when it was not.
  const payload = input.offsetToken
    ? { offset_token: input.offsetToken, limit }
    : {
        keyword,
        limit,
        internal_list_limit: internalListLimit,
        order_by: orderBy,
        search_mode: input.searchMode ?? "as_is",
      };

  const response = await dataforseoPost(PATH, [payload], NO_RETRY_BILLED_POST);

  const task = assertOk(response, {
    classify: classifyError,
    classifyPath: PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO content_analysis/search returned an unexpected payload",
    );
  }

  const rows: CitationRow[] = (raw.data.items ?? []).map((item) => ({
    url: item.url ?? null,
    domain: item.domain ?? null,
    prominence: item.score ?? null,
    domainRank: item.domain_rank ?? null,
    urlRank: item.url_rank ?? null,
    spamScore: item.spam_score ?? null,
    country: item.country ?? null,
    language: item.language ?? null,
    pageTypes: item.page_types ?? [],
    title: item.content_info?.main_title ?? item.content_info?.title ?? null,
    snippet: item.content_info?.snippet ?? null,
    polarityScores: toPolarityScores(item.content_info?.connotation_types),
    connotationScores: toEmotionScores(
      item.content_info?.sentiment_connotations,
    ),
    contentQualityScore: item.content_info?.content_quality_score ?? null,
    semanticLocation: item.content_info?.semantic_location ?? null,
    groupDate: item.content_info?.group_date ?? null,
  }));

  return {
    data: {
      keyword,
      totalCount: raw.data.total_count ?? null,
      rows,
      nextOffsetToken: raw.data.offset_token ?? null,
      orderBy,
      basis: `Pages in DataForSEO's index citing "${keyword}". Each row's sentiment figures are per-page probabilities between 0 and 1 — the sibling summary endpoints report counts for the same field name, so the two must not be read the same way. This is the open web, not an AI engine's reading.`,
    },
    billing: buildTaskBilling(task),
  };
}

/** Narrow raw rows to ones carrying a URL, for a caller rendering a list. */
export function citableRows(
  result: ContentSearchResult,
): Array<CitationRow & { url: string }> {
  return result.rows.filter(
    (row): row is CitationRow & { url: string } => typeof row.url === "string",
  );
}

/** The domains present, by citation count, for a "who talks about us" list. */
export function domainsByCitationCount(
  result: ContentSearchResult,
): Array<{ domain: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    if (row.domain === null) continue;
    counts.set(row.domain, (counts.get(row.domain) ?? 0) + 1);
  }
  // Remeda's `sortBy` rather than `toSorted`, which `oxlint` asks for and
  // `tsconfig`'s `lib` deliberately excludes — the note on the `lib` line says
  // `toSorted` crashes Chromium <110 and prescribes exactly this. The lint rule
  // and the compiler disagree here, and the compiler is right about the runtime
  // this code ships to.
  const rows = [...counts.entries()].map(([domain, count]) => ({
    domain,
    count,
  }));
  return sortBy(rows, (row) => -row.count);
}
