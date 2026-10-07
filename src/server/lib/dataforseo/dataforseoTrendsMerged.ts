/**
 * DataForSEO Trends merged data: all three views in one request.
 *
 * ## Verified against the reference, 2026-10-06
 *
 * Path `/v3/keywords_data/dataforseo_trends/merged_data/live`, under the same request rules as its
 * siblings — `keywords` required and capped at **5**, location optional (**omitting it returns
 * global results**), `type` of `web`/`news`/`ecommerce`, per-type date floors, `time_range`
 * ignored beside a date, billed once per request whatever it carries.
 *
 * ## What makes it worth a client of its own
 *
 * One request returns **three elements**: `dataforseo_trends_graph`, `subregion_interests` and
 * `demography`, each in the shape its own endpoint returns. So this client needs **no new readers**
 * — the graph, subregion and demography readers already exist and are reused by dispatching on the
 * element's `type`.
 *
 * The economics are worth stating plainly rather than as a saving: at `mergedData` the request
 * costs what the three separate calls cost together. **What it buys is not a discount but a shared
 * frame** — one `date_from`/`date_to`, one `location`, one moment of capture — so the three views
 * cannot disagree about the window they describe. Three separate calls could.
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

/** One element of the merged response, tagged by the `type` that says which reader to use. */
type MergedTrendElement = {
  type?: string | null;
  keywords?: string[] | null;
  [key: string]: unknown;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchDataforseoTrendsMergedData(input: {
  keywords: string[];
  type?: TrendIndexType;
  locationCode?: number;
  dateFrom?: string;
  dateTo?: string;
  timeRange?: TrendTimeRange;
}): Promise<DataforseoApiResponse<MergedTrendElement[]>> {
  if (
    input.keywords.length === 0 ||
    input.keywords.length > MAX_TREND_KEYWORDS
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO Trends merged data takes between 1 and ${MAX_TREND_KEYWORDS} keywords per request (one request is billed the same either way); got ${input.keywords.length}.`,
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

  const response = await dataforseoPost<
    DataforseoItemsTask<MergedTrendElement>
  >("/v3/keywords_data/dataforseo_trends/merged_data/live", [
    {
      keywords: input.keywords,
      type,
      location_code: input.locationCode,
      date_from: input.dateFrom,
      date_to: input.dateTo,
      time_range: input.timeRange,
    },
  ]);
  const task = assertOk(response);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}

/** The three element types the merged endpoint returns, so a caller can dispatch on `type`. */
export const MERGED_TREND_ELEMENT_TYPES = [
  "dataforseo_trends_graph",
  "subregion_interests",
  "demography",
] as const;
