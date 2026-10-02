import { z } from "zod";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { AppError } from "@/server/lib/errors";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";

/**
 * AI Keyword Data — demand for a topic in AI answers.
 *
 * This is the endpoint behind the most valuable signal in the product: a topic
 * with high AI demand and low Google demand is invisible to classic SEO tools
 * and often the cheapest traffic available. See the `what-to-build` skill.
 *
 * The `ai_search_volume` returned here is a MODEL, and it is not comparable with
 * the same field returned by llm_mentions/target_metrics — different unit,
 * different source. Never merge the two into one number.
 */

const classifyAiSearchError = createDataforseoBillingClassifier({
  pathPrefix: "/ai_optimization/",
  billingIssueCode: "AI_SEARCH_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

/**
 * The live endpoint.
 *
 * **The path is `keywords_search_volume`, with an underscore — not
 * `keywords/search_volume`.** It was the latter here until this was checked
 * against the live documentation, and it had never worked: DataForSEO bills a
 * task that fails, so a wrong path is a silent 40501 on a paid request rather
 * than a visible error at boot. The response's own `path` array confirms it:
 * `["v3","ai_optimization","ai_keyword_data","keywords_search_volume","live"]`.
 *
 * A test now pins the full URL, not just the request body. The 14 tests that
 * already existed checked the body and the parsing and passed the whole time
 * the client was pointed at a URL that does not exist.
 */
const PATH = "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live";

/** Documented limits. Exceeding them is a billed rejection, so we clamp first. */
const MAX_KEYWORDS = 1000;
export const MAX_KEYWORD_CHARS = 250;

const monthlySearchSchema = z
  .object({
    year: z.number(),
    month: z.number(),
    // A month may legitimately be 0: the keyword had no recorded AI demand then.
    // That is not an error, and it must survive to the caller intact.
    ai_search_volume: z.number().nullish(),
  })
  .passthrough();

const keywordVolumeItemSchema = z
  .object({
    keyword: z.string(),
    ai_search_volume: z.number().nullish(),
    ai_monthly_searches: z.array(monthlySearchSchema).nullish(),
  })
  .passthrough();

const resultSchema = z
  .object({
    location_code: z.number().nullish(),
    language_code: z.string().nullish(),
    items_count: z.number().nullish(),
    items: z.array(keywordVolumeItemSchema).nullish(),
  })
  .passthrough();

// Module-private: nothing outside this file consumes these yet. Export them when
// a caller needs to name the shape (the MCP tool layer will), rather than
// speculatively now — knip enforces that, and an unused export is a lie about
// the API surface.
type AiKeywordVolumeItem = z.infer<typeof keywordVolumeItemSchema>;

/** Exported because `fetchAiKeywordVolume` returns it, and a test double typed from it is the honest shape. */
export type AiKeywordVolumeResult = {
  locationCode: number | null;
  languageCode: string | null;
  items: AiKeywordVolumeItem[];
};

export type AiKeywordVolumeInput = {
  keywords: string[];
  /**
   * Optional in the type because the runtime guard below exists precisely to
   * catch a missing value from a loosely-typed caller — and because this
   * endpoint *requires* it, sending a request without it is a billed rejection.
   * Callers should always supply a resolved code.
   */
  locationCode?: number;
  languageCode?: string;
  tag?: string;
};

/**
 * Normalise a keyword for submission.
 *
 * DataForSEO lowercases and truncates server-side, but it bills a task that
 * fails, and it returns the normalised string. We normalise identically up
 * front so the returned `keyword` is a safe join key against the caller's
 * input — the number one source of silently mis-joined keyword rows.
 */
export function normaliseAiKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().slice(0, MAX_KEYWORD_CHARS);
}

export function validateAiKeywordBatch(keywords: string[]): string[] {
  if (keywords.length === 0) {
    throw new AppError("VALIDATION_ERROR", "At least one keyword is required");
  }
  if (keywords.length > MAX_KEYWORDS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO accepts at most ${MAX_KEYWORDS} keywords per AI keyword request; received ${keywords.length}. Split the batch.`,
    );
  }
  const normalised = keywords.map(normaliseAiKeyword);
  const blanks = normalised.filter((k) => k.length === 0);
  if (blanks.length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${blanks.length} keyword(s) were empty after normalisation`,
    );
  }
  return [...new Set(normalised)];
}

export async function fetchAiKeywordVolume(
  input: AiKeywordVolumeInput,
): Promise<DataforseoApiResponse<AiKeywordVolumeResult>> {
  // Location AND language are both required by this endpoint. Omitting one
  // returns data that is not reproducible, so we refuse rather than guess.
  if (input.locationCode === undefined || input.languageCode === undefined) {
    throw new AppError(
      "VALIDATION_ERROR",
      "ai_keyword_data requires both a location and a language. Resolve codes from /v3/ai_optimization/ai_keyword_data/locations_and_languages first.",
    );
  }

  const keywords = validateAiKeywordBatch(input.keywords);

  const response = await dataforseoPost(
    PATH,
    [
      {
        keywords,
        location_code: input.locationCode,
        language_code: input.languageCode,
        ...(input.tag ? { tag: input.tag } : {}),
      },
    ],
    { classify: classifyAiSearchError },
  );

  const task = assertOk(response, {
    classify: classifyAiSearchError,
    classifyPath: PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "DataForSEO returned an unexpected AI keyword volume payload",
    );
  }

  const data = raw.data;
  return {
    data: {
      locationCode: data.location_code ?? null,
      languageCode: data.language_code ?? null,
      items: (data.items ?? []).map((item) => ({
        keyword: item.keyword,
        ai_search_volume: item.ai_search_volume ?? null,
        ai_monthly_searches: item.ai_monthly_searches ?? null,
      })),
    },
    billing: buildTaskBilling(task),
  };
}
