/**
 * The categories a domain ranks in.
 *
 * Split from `labs.ts` for the same reason `labsIntersection.ts` was: that file's remaining
 * budget for code lines was small, and a family of its own earns its own module.
 *
 * The endpoint's catch is that a category arrives as a **numeric criterion ID with no label**,
 * and the labels are published separately as a taxonomy CSV. This client hands the IDs through
 * unchanged — inventing a label, or dropping an ID whose label is unknown, would each be worse
 * than a join the caller can do. `docs/DATAFORSEO_GOTCHAS.md` §4.5 carries the verified detail,
 * including the taxonomy's URL and its 3,183 rows.
 */
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
} from "@/server/lib/dataforseo/envelope";

/**
 * One category a domain ranks in.
 *
 * `categories` is an array of **numeric criterion IDs** — `[10007]` — and the endpoint returns
 * **no labels at all**. `metrics` carries the same per-position and ETV block as elsewhere in
 * Labs, per item type, because a domain's organic and paid standing in one category differ.
 */
type CategoryForDomainItem = {
  categories?: number[] | null;
  metrics?: {
    organic?: LabsMetricsBlock | null;
    paid?: LabsMetricsBlock | null;
    featured_snippet?: LabsMetricsBlock | null;
    local_pack?: LabsMetricsBlock | null;
  } | null;
  [key: string]: unknown;
};

/** The per-position and traffic block shared by every Labs metrics object. */
type LabsMetricsBlock = {
  pos_1?: number | null;
  pos_2_3?: number | null;
  pos_4_10?: number | null;
  pos_11_20?: number | null;
  etv?: number | null;
  count?: number | null;
  estimated_paid_traffic_cost?: number | null;
  is_new?: number | null;
  is_up?: number | null;
  is_down?: number | null;
  is_lost?: number | null;
  [key: string]: unknown;
};

/**
 * One keyword the vendor returns for a set of categories.
 *
 * The fields a Market Map reads: volume and CPC from `keyword_info`, difficulty from
 * `keyword_properties`, and intent from `search_intent_info`. Everything is optional because the
 * vendor omits blocks per keyword rather than sending zeros — `keyword_difficulty: 0` in its own
 * sample coexists with a null `detected_language`, so an absent block and a zero are not the same
 * claim and must not be collapsed.
 */
type CategoryKeywordItem = {
  keyword?: string | null;
  keyword_info?: {
    search_volume?: number | null;
    cpc?: number | null;
    competition?: number | null;
    competition_level?: string | null;
  } | null;
  keyword_properties?: {
    keyword_difficulty?: number | null;
    words_count?: number | null;
  } | null;
  search_intent_info?: {
    main_intent?: string | null;
  } | null;
  [key: string]: unknown;
};

/**
 * The product and service categories a domain ranks in.
 *
 * **Location and language are both required** here, unlike `ranked_keywords` where each is
 * optional; `limit` reaches 1,000 with `offset`, and `item_types` offers no AI-Overview option.
 * `includeClickstreamData` **doubles the vendor's price**, so it is an explicit caller choice
 * rather than a default.
 *
 * **No `use_new_etv` flag is sent, and that is a known gap rather than an oversight.** The
 * endpoint returns `etv`, but it is not on `ETV_BEARING_LABS_ENDPOINTS` — the vendor's list of
 * endpoints that take the flag — so an unversioned number is what comes back, and the vendor
 * switches ETV models on 2026-11-01. Verifying whether this endpoint accepts the parameter is
 * CL-712a's job; until then, a caller recording these values should know they carry no formula
 * version.
 */
export async function fetchCategoriesForDomain(input: {
  target: string;
  locationCode: number;
  languageCode: string;
  includeSubcategories?: boolean;
  includeClickstreamData?: boolean;
  limit: number;
  offset?: number;
  orderBy?: string[];
}): Promise<DataforseoApiResponse<CategoryForDomainItem[]>> {
  const response = await dataforseoPost<
    DataforseoItemsTask<CategoryForDomainItem>
  >("/v3/dataforseo_labs/google/categories_for_domain/live", [
    {
      target: input.target,
      location_code: input.locationCode,
      language_code: input.languageCode,
      include_subcategories: input.includeSubcategories,
      include_clickstream_data: input.includeClickstreamData ?? false,
      limit: input.limit,
      offset: input.offset,
      order_by: input.orderBy,
    },
  ]);
  const task = assertOk(response);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}

/**
 * Keywords relevant to a set of categories: the drill-down from a category profile.
 *
 * ## Verified against the reference, 2026-10-06
 *
 * `category_codes` is **required** and takes the same criterion IDs the taxonomy is keyed by —
 * **at most 20 of them**. Location and language are both required, as on its sibling. `limit`
 * reaches 1,000, and `offset_token` exists for paging beyond 10,000 results.
 *
 * **`category_intersection` defaults to `true`**, and that default is the trap: with it set, the
 * response contains only keywords that appear in **every** category named. A caller who passes
 * three unrelated categories expecting their union gets a short or empty answer that looks like a
 * failed request. This client sends the flag explicitly, and the caller says which it wants.
 *
 * **`offset_token` overrides everything but `limit`** — the reference is explicit that when it is
 * present, all other parameters are ignored. So it is never combined with filters here: a caller
 * paging with a token would otherwise believe its filters still applied.
 *
 * `includeClickstreamData` doubles the price, and `includeSerpInfo` adds a SERP block per keyword,
 * which is a much larger response for data the caller may not read. The reference's sample
 * response shows a price that predates the current one, as its sibling's does — the price book and
 * the task's own `cost` are the authorities.
 */
export async function fetchKeywordsForCategories(input: {
  categoryCodes: number[];
  locationCode: number;
  languageCode: string;
  /** `true` = keywords in ALL named categories; `false` = in ANY. Sent explicitly. */
  categoryIntersection: boolean;
  includeSerpInfo?: boolean;
  includeClickstreamData?: boolean;
  ignoreSynonyms?: boolean;
  limit: number;
  offset?: number;
  offsetToken?: string;
}): Promise<DataforseoApiResponse<CategoryKeywordItem[]>> {
  // Refused rather than truncated: 21 categories silently cut to 20 would answer a different
  // question than the one asked, and the caller would have no way to see that.
  if (input.categoryCodes.length === 0 || input.categoryCodes.length > 20) {
    throw new AppError(
      "VALIDATION_ERROR",
      `keywords_for_categories takes between 1 and 20 categories; got ${input.categoryCodes.length}.`,
    );
  }

  const response = await dataforseoPost<
    DataforseoItemsTask<CategoryKeywordItem>
  >("/v3/dataforseo_labs/google/keywords_for_categories/live", [
    {
      category_codes: input.categoryCodes,
      location_code: input.locationCode,
      language_code: input.languageCode,
      category_intersection: input.categoryIntersection,
      include_serp_info: input.includeSerpInfo,
      include_clickstream_data: input.includeClickstreamData ?? false,
      ignore_synonyms: input.ignoreSynonyms,
      limit: input.limit,
      offset: input.offset,
      offset_token: input.offsetToken,
    },
  ]);
  const task = assertOk(response);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}
