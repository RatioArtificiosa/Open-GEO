/**
 * DataForSEO Trends subregion interests: where a keyword is popular.
 *
 * ## Verified against the reference, 2026-10-06
 *
 * Path `/v3/keywords_data/dataforseo_trends/subregion_interests/live`, under the same request rules
 * as its `explore` and `demography` siblings: `keywords` required and capped at **5**, location
 * optional (**omitting it returns global results**), `type` of `web`/`news`/`ecommerce`, per-type
 * date floors, `time_range` ignored whenever a date is present, and one request billed the same at
 * one keyword or five.
 *
 * ## Three normalisations, not one
 *
 * The reference states all three, and they are three different rulers:
 *
 * - `interests[].values[].value` — each keyword against **its own highest location** (100), so
 *   locations compare *within one keyword*.
 * - `interests_comparison.items[].values` — each keyword against the **highest keyword in that
 *   location** (100), so keywords compare *within one location*.
 * - `interests_comparison.absolute_items[].values` — against the **highest across every keyword and
 *   every location**, which is the only block where two different locations' numbers can be read
 *   against each other.
 *
 * `interests_comparison` is **null when a single keyword was asked for** — the reference says so up
 * front, and there is genuinely nothing to compare.
 *
 * One field to be careful with: `geo_id` arrives **null** throughout the reference's own sample, so
 * `geo_name` is the only reliable key for matching a result to a location.
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

type GeoValue = {
  geo_id?: string | null;
  /** The only reliable key: the reference's own sample sends a null `geo_id` throughout. */
  geo_name?: string | null;
  value?: number | null;
};

type SubregionItem = {
  type?: string | null;
  keywords?: string[] | null;
  interests?: Array<{
    keyword?: string | null;
    values?: GeoValue[] | null;
  }> | null;
  interests_comparison?: {
    items?: Array<{
      geo_name?: string | null;
      values?: number[] | null;
    }> | null;
    absolute_items?: Array<{
      geo_name?: string | null;
      values?: number[] | null;
    }> | null;
  } | null;
  [key: string]: unknown;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchDataforseoTrendsSubregion(input: {
  keywords: string[];
  type?: TrendIndexType;
  locationCode?: number;
  dateFrom?: string;
  dateTo?: string;
  timeRange?: TrendTimeRange;
}): Promise<DataforseoApiResponse<SubregionItem[]>> {
  if (
    input.keywords.length === 0 ||
    input.keywords.length > MAX_TREND_KEYWORDS
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO Trends subregion interests takes between 1 and ${MAX_TREND_KEYWORDS} keywords per request (one request is billed the same either way); got ${input.keywords.length}.`,
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

  const response = await dataforseoPost<DataforseoItemsTask<SubregionItem>>(
    "/v3/keywords_data/dataforseo_trends/subregion_interests/live",
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
