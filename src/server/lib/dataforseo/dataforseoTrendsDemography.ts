/**
 * DataForSEO Trends demography: how a keyword's interest splits by age and gender.
 *
 * ## Verified against the reference, 2026-10-06
 *
 * Path `/v3/keywords_data/dataforseo_trends/demography/live`, the same family and the same rules as
 * its `explore` sibling: `keywords` required and capped at **5**, location optional (**omitting it
 * returns global results**), `type` of `web`/`news`/`ecommerce`, per-type date floors, and
 * `time_range` ignored whenever a date is present. One request bills the same at one keyword or
 * five.
 *
 * ## The result carries two normalisations, and they are not the same ruler
 *
 * `demography.age` and `demography.gender` normalise **per keyword**: the highest value across that
 * keyword's age buckets becomes 100 and the rest are shares of it — so age buckets are comparable
 * *within one keyword* and not across keywords. `demography_comparison` instead normalises across
 * the **requested keywords** within each bucket, so its numbers are shares of the total across
 * terms and sum to about 100. Reading one as the other would produce a confident, wrong comparison.
 * `demography_comparison` is **null for a single keyword**, because there is nothing to compare.
 */
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
} from "@/server/lib/dataforseo/envelope";

const MAX_TREND_KEYWORDS = 5;

const EARLIEST_TREND_DATE = {
  web: "2004-01-01",
  news: "2008-01-01",
  ecommerce: "2008-01-01",
} as const;

type TrendIndexType = keyof typeof EARLIEST_TREND_DATE;

type TrendTimeRange =
  | "past_4_hours"
  | "past_day"
  | "past_7_days"
  | "past_30_days"
  | "past_90_days"
  | "past_12_months"
  | "past_5_years";

type DemographyBucket = { type?: string | null; value?: number | null };

type DemographyItem = {
  type?: string | null;
  keywords?: string[] | null;
  demography?: {
    /** Per keyword, with each keyword's own peak as 100. */
    age?: Array<{
      keyword?: string | null;
      values?: DemographyBucket[] | null;
    }> | null;
    gender?: Array<{
      keyword?: string | null;
      values?: DemographyBucket[] | null;
    }> | null;
  } | null;
  /** Shares across the requested keywords, per bucket. Null when only one keyword was asked for. */
  demography_comparison?: {
    age?: Record<string, number[] | null> | null;
    gender?: Record<string, number[] | null> | null;
  } | null;
  [key: string]: unknown;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchDataforseoTrendsDemography(input: {
  keywords: string[];
  type?: TrendIndexType;
  locationCode?: number;
  dateFrom?: string;
  dateTo?: string;
  timeRange?: TrendTimeRange;
}): Promise<DataforseoApiResponse<DemographyItem[]>> {
  if (
    input.keywords.length === 0 ||
    input.keywords.length > MAX_TREND_KEYWORDS
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO Trends demography takes between 1 and ${MAX_TREND_KEYWORDS} keywords per request (one request is billed the same either way); got ${input.keywords.length}.`,
    );
  }

  const type = input.type ?? "web";
  if (
    input.timeRange != null &&
    (input.dateFrom != null || input.dateTo != null)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "timeRange is ignored by the vendor when dateFrom or dateTo is set, so passing both would silently apply the dates. Send one or the other.",
    );
  }

  for (const [label, value] of [
    ["dateFrom", input.dateFrom],
    ["dateTo", input.dateTo],
  ] as const) {
    if (value == null) continue;
    if (!DATE_PATTERN.test(value)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${label} must be in yyyy-mm-dd format, got "${value}".`,
      );
    }
    const earliest = EARLIEST_TREND_DATE[type];
    if (value < earliest) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${label} is before ${earliest}, the earliest date the "${type}" index supports.`,
      );
    }
  }

  const response = await dataforseoPost<DataforseoItemsTask<DemographyItem>>(
    "/v3/keywords_data/dataforseo_trends/demography/live",
    [
      {
        keywords: input.keywords,
        type,
        location_code: input.locationCode,
        date_from: input.dateFrom,
        date_to: input.dateTo,
        time_range: input.timeRange,
      },
    ],
  );
  const task = assertOk(response);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}
