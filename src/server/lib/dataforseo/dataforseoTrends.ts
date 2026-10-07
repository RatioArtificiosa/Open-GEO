/**
 * DataForSEO Trends: keyword popularity over time, from their own index.
 *
 * ## Verified against the reference, 2026-10-06
 *
 * **The path is `keywords_data/dataforseo_trends/…`, not `dataforseo_trends/…`** — the family
 * lives under the keywords-data API, which is worth stating because the shorter path looks right
 * and 404s in the docs. `keywords` is required and takes **at most 5**; location is **optional**,
 * and omitting it returns **global** results rather than an error, which is the same comparability
 * hazard the clickstream endpoint carries.
 *
 * `type` selects the index: `web` (default), `news`, `ecommerce`. `dateFrom`/`dateTo` default to
 * *the same day and month of the preceding year* through today, and carry different floors by
 * type — **2004-01-01 for `web`, 2008-01-01 for the others** — so a floor is checked against the
 * type rather than against one constant. `timeRange` is a preset **the vendor ignores entirely
 * when either date field is present**, so the two are refused together here: a caller who set both
 * would silently get the dates they typed, believing the preset applied.
 *
 * **The billing note is the important one:** *"our system will charge your account per each
 * request, no matter what number of keywords an array has."* One request with five keywords costs
 * what one keyword costs, so batching is the whole economics of this endpoint — which is why the
 * client takes an array rather than a keyword.
 *
 * The reference's sample carries a `cost` that no longer matches the price book, as its siblings'
 * samples do. The book and the task's own `cost` are the authorities.
 */
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
} from "@/server/lib/dataforseo/envelope";

/** The vendor's cap. One request with five keywords costs what one keyword costs. */
const MAX_TREND_KEYWORDS = 5;

/** Earliest date per index type, as the reference states them. */
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

/** One point on the graph, as the vendor returns it. */
type TrendGraphPoint = {
  date_from?: string | null;
  date_to?: string | null;
  timestamp?: number | null;
  /** One entry per keyword in the request, aligned by index. */
  values?: number[] | null;
  [key: string]: unknown;
};

/** The single element the response carries, per request. */
type TrendGraphItem = {
  type?: string | null;
  keywords?: string[] | null;
  data?: TrendGraphPoint[] | null;
  /** One entry per keyword, averaged over the whole range. */
  averages?: number[] | null;
  [key: string]: unknown;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchDataforseoTrendsExplore(input: {
  keywords: string[];
  type?: TrendIndexType;
  locationCode?: number;
  dateFrom?: string;
  dateTo?: string;
  timeRange?: TrendTimeRange;
}): Promise<DataforseoApiResponse<TrendGraphItem[]>> {
  // Refused rather than truncated: a request costs the same whatever it carries, so silently
  // dropping a keyword would lose a series for free — the worst possible trade.
  if (
    input.keywords.length === 0 ||
    input.keywords.length > MAX_TREND_KEYWORDS
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO Trends takes between 1 and ${MAX_TREND_KEYWORDS} keywords per request (one request is billed the same either way); got ${input.keywords.length}.`,
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

  const response = await dataforseoPost<DataforseoItemsTask<TrendGraphItem>>(
    "/v3/keywords_data/dataforseo_trends/explore/live",
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
