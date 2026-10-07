/**
 * Who ranks in a set of categories, and how their traffic moved between two dates.
 *
 * ## Verified against the reference, 2026-10-06
 *
 * Its own family, and the differences from `categories_for_domain` are the point: `category_codes`
 * is required and takes **at most 5** categories (not 20), and **`first_date` and `second_date` are
 * both required** in `yyyy-mm-dd`. The whole call is a comparison, so a caller cannot ask for one
 * date. The rules the reference states are all locally checkable, and every one of them is a
 * **billed rejection** if broken:
 *
 * - the two dates **cannot be the same month of the same year**;
 * - neither may be later than today, and the earliest supported date is **2020-10-01**;
 * - they may be given in either order, which is why nothing here assumes `first` is earlier;
 * - `topCategoriesCount` **cannot be less than** the number of categories requested, and caps at 5.
 *
 * **`pricing` is `heavyHistorical`: $0.12 a request plus $0.0012 a domain — roughly 10× the
 * standard Labs rate.** A caller who does not know that is a caller who will be surprised, so the
 * tool that exposes this states the price rather than leaving it to the pricing page.
 *
 * ## `metrics_difference` is returned by the vendor and deliberately not trusted
 *
 * The reference describes the block as *"subtracting domain metrics as of the greater date from
 * domain metrics as of the smaller date"*, which does not say whether a **positive** number means
 * growth. Its own sample does not settle it either: an ETV that rises from 147.22 to 308.87 carries
 * a difference of `+161.65` (later minus earlier), while a `pos_1` that is 4 in both months carries
 * `+1`. So the direction of movement is computed by the caller from the two history months, which
 * are unambiguous, and this module never reads `metrics_difference`. The doc samples in this family
 * are visibly machine-mangled in places, which is another reason not to build a sign convention on
 * one.
 */
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
} from "@/server/lib/dataforseo/envelope";

/** The earliest date the vendor supports. A request before it is a billed rejection. */
const EARLIEST_CATEGORY_METRICS_DATE = "2020-10-01";

/** The vendor's cap for this endpoint, which is 5 rather than its sibling's 20. */
const MAX_CATEGORY_CODES = 5;

/** One month's metrics block, as the vendor returns it. */
type CategoryMetricsBlock = {
  etv?: number | null;
  count?: number | null;
  pos_1?: number | null;
  pos_2_3?: number | null;
  pos_4_10?: number | null;
  [key: string]: unknown;
};

type CategoryMetricsMonth = {
  organic?: CategoryMetricsBlock | null;
  paid?: CategoryMetricsBlock | null;
  /** Null in the vendor's own sample, so a null block is normal rather than a failure. */
  featured_snippet?: CategoryMetricsBlock | null;
  local_pack?: CategoryMetricsBlock | null;
};

/** One domain the vendor found in these categories. */
type CategoryDomainMetricsItem = {
  domain?: string | null;
  main_domain?: string | null;
  top_categories?: number[] | null;
  organic_etv?: number | null;
  organic_count?: number | null;
  /** Keyed by `YYYYMM`. The two requested months, and the only thing movement is derived from. */
  metrics_history?: Record<string, CategoryMetricsMonth> | null;
  [key: string]: unknown;
};

/** `yyyy-mm-dd`, the only format the endpoint accepts. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function monthKey(date: string): string {
  return date.slice(0, 7).replace("-", "");
}

/**
 * Everything the reference says must be true before a request is sent.
 *
 * Each rule exists because breaking it costs money: the vendor rejects the task, and the task fee
 * applies regardless. Refusing locally turns a billed failure into an error message.
 */
function assertCategoryMetricsDates(
  firstDate: string,
  secondDate: string,
  now: Date = new Date(),
): void {
  for (const [label, value] of [
    ["firstDate", firstDate],
    ["secondDate", secondDate],
  ] as const) {
    if (!DATE_PATTERN.test(value)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${label} must be in yyyy-mm-dd format, got "${value}".`,
      );
    }
    if (value < EARLIEST_CATEGORY_METRICS_DATE) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${label} is before ${EARLIEST_CATEGORY_METRICS_DATE}, the earliest date this endpoint supports.`,
      );
    }
    if (value > now.toISOString().slice(0, 10)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${label} is in the future; this endpoint compares two past months.`,
      );
    }
  }

  if (monthKey(firstDate) === monthKey(secondDate)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "firstDate and secondDate cannot point to the same month of the same year; a comparison needs two different months.",
    );
  }
}

export async function fetchDomainMetricsByCategories(input: {
  categoryCodes: number[];
  locationCode: number;
  languageCode: string;
  firstDate: string;
  secondDate: string;
  topCategoriesCount?: number;
  includeSubdomains?: boolean;
  etvMin?: number;
  etvMax?: number;
  limit: number;
  offset?: number;
  orderBy?: string[];
  /** Injectable so the future-date rule is testable rather than clock-dependent. */
  now?: Date;
}): Promise<DataforseoApiResponse<CategoryDomainMetricsItem[]>> {
  // Refused rather than truncated, as with its sibling: answering about three categories when five
  // were asked for is a different answer, and the caller would have no way to see that.
  if (
    input.categoryCodes.length === 0 ||
    input.categoryCodes.length > MAX_CATEGORY_CODES
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `domain_metrics_by_categories takes between 1 and ${MAX_CATEGORY_CODES} categories; got ${input.categoryCodes.length}.`,
    );
  }

  if (
    input.topCategoriesCount != null &&
    input.topCategoriesCount < input.categoryCodes.length
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `topCategoriesCount cannot be less than the number of categories requested (${input.categoryCodes.length}).`,
    );
  }

  assertCategoryMetricsDates(input.firstDate, input.secondDate, input.now);

  const response = await dataforseoPost<
    DataforseoItemsTask<CategoryDomainMetricsItem>
  >("/v3/dataforseo_labs/google/domain_metrics_by_categories/live", [
    {
      category_codes: input.categoryCodes,
      location_code: input.locationCode,
      language_code: input.languageCode,
      first_date: input.firstDate,
      second_date: input.secondDate,
      top_categories_count: input.topCategoriesCount,
      include_subdomains: input.includeSubdomains,
      etv_min: input.etvMin,
      etv_max: input.etvMax,
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
