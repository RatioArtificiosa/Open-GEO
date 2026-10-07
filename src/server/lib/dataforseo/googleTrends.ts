/**
 * Google Trends, which is a different index from DataForSEO's.
 *
 * ## Verified against the reference, 2026-10-06
 *
 * The path is `/v3/keywords_data/google_trends/explore/live` — the same `keywords_data` prefix as
 * its DataForSEO sibling, and the **docs slug uses hyphens where the other family's uses an
 * underscore**, which is how the wrong page gets opened first.
 *
 * The two endpoints look alike and are not. A copy of the sibling would get four things wrong:
 *
 * - **`type` takes `froogle`, not `ecommerce`** — the value sets differ between the two families.
 * - **It accepts a `language`, defaulting to `en`**, where the DataForSEO one has no language at all.
 * - **It can be driven by `category_code` instead of keywords**, which is a whole capability the
 *   sibling lacks.
 * - **It flags missing points explicitly** with `missing_data`, rather than signalling them with a
 *   0.
 *
 * ## The rules that are billed rejections, checked here instead
 *
 * `keywords` caps at 5, each at **100 characters**, and the vendor **strips commas and rejects a
 * set of characters outright** — `< > | " - + = ~ ! : * ( ) [ ] { }` — so a hyphen in
 * `e-commerce` is not a style question but an invalid request. `google_trends_topics_list` and
 * `google_trends_queries_list` items **require one keyword or none**, so asking for them with three
 * is refused before the call. Date floors are per type, as on the sibling, and `time_range` is
 * again ignored when either date is present.
 *
 * ## What this endpoint shares with a public good
 *
 * The reference states a **500,000-request daily ceiling across all users of the API**, not per
 * account, plus a 250-per-minute Live limit. That is worth a caller knowing: steady high-volume
 * polling is not just expensive here, it competes for a shared resource.
 */
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
} from "@/server/lib/dataforseo/envelope";

/** The vendor's cap, and the per-keyword character cap the reference states. */
const MAX_TREND_KEYWORDS = 5;
const MAX_TREND_KEYWORD_LENGTH = 100;

/** Characters the reference says a keyword cannot contain. A hyphen is the easy one to miss. */
const FORBIDDEN_KEYWORD_CHARS = /[<>|"\-+=~!:*()[\]{}]/;

/** Earliest date per index type. `froogle` is Google's name for its shopping index. */
const EARLIEST_TREND_DATE = {
  web: "2004-01-01",
  news: "2008-01-01",
  youtube: "2008-01-01",
  images: "2008-01-01",
  froogle: "2008-01-01",
} as const;

type GoogleTrendType = keyof typeof EARLIEST_TREND_DATE;

type GoogleTrendItemType =
  | "google_trends_graph"
  | "google_trends_map"
  | "google_trends_topics_list"
  | "google_trends_queries_list";

/** The item types that only work for a single keyword, as the reference states. */
const SINGLE_KEYWORD_ITEM_TYPES: GoogleTrendItemType[] = [
  "google_trends_topics_list",
  "google_trends_queries_list",
];

type TrendTimeRange =
  | "past_hour"
  | "past_4_hours"
  | "past_day"
  | "past_7_days"
  | "past_30_days"
  | "past_90_days"
  | "past_12_months"
  | "past_5_years"
  | "2004_present"
  | "2008_present";

type GoogleTrendGraphItem = {
  type?: string | null;
  keywords?: string[] | null;
  /** Google also returns a `check_url` — a direct link to the Trends page for the same query. */
  check_url?: string | null;
  data?: Array<{
    date_from?: string | null;
    date_to?: string | null;
    values?: Array<number | null> | null;
    missing_data?: boolean | null;
  }> | null;
  averages?: number[] | null;
  [key: string]: unknown;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchGoogleTrendsExplore(input: {
  keywords?: string[];
  categoryCode?: number;
  type?: GoogleTrendType;
  itemTypes?: GoogleTrendItemType[];
  locationCode?: number;
  languageCode?: string;
  dateFrom?: string;
  dateTo?: string;
  timeRange?: TrendTimeRange;
}): Promise<DataforseoApiResponse<GoogleTrendGraphItem[]>> {
  const keywords = input.keywords ?? [];

  // The reference makes one of the two required, so an empty request is a billed rejection.
  if (keywords.length === 0 && input.categoryCode == null) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Google Trends needs either keywords or a categoryCode; the vendor requires one of them.",
    );
  }
  if (keywords.length > MAX_TREND_KEYWORDS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Google Trends takes between 1 and ${MAX_TREND_KEYWORDS} keywords per request (one request is billed the same either way); got ${keywords.length}.`,
    );
  }

  for (const keyword of keywords) {
    if (keyword.length > MAX_TREND_KEYWORD_LENGTH) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Google Trends keywords are limited to ${MAX_TREND_KEYWORD_LENGTH} characters; "${keyword.slice(0, 20)}…" is longer.`,
      );
    }
    // The vendor rejects these characters outright rather than escaping them, so a hyphen in
    // `e-commerce` fails the task — and the task fee applies to a failed task.
    if (FORBIDDEN_KEYWORD_CHARS.test(keyword)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Google Trends rejects these characters in a keyword: < > | " - + = ~ ! : * ( ) [ ] { }. Remove them from "${keyword}".`,
      );
    }
  }

  if (
    keywords.length > 1 &&
    (input.itemTypes ?? []).some((type) =>
      SINGLE_KEYWORD_ITEM_TYPES.includes(type),
    )
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Related topics and related queries can only be requested for a single keyword; this request has " +
        `${keywords.length}.`,
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
    DataforseoItemsTask<GoogleTrendGraphItem>
  >("/v3/keywords_data/google_trends/explore/live", [
    {
      keywords: keywords.length > 0 ? keywords : undefined,
      category_code: input.categoryCode,
      type,
      item_types: input.itemTypes,
      location_code: input.locationCode,
      language_code: input.languageCode,
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
