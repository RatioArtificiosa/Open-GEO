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
