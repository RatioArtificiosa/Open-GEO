import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";
import type { AdTrafficRow } from "@/shared/ad-traffic-forecast-read";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";

/**
 * Google Ads traffic forecast — the cross-check, and the landmine it carries.
 *
 * ## Verified against the reference, 2026-10-13
 *
 * Path `/v3/keywords_data/google_ads/ad_traffic_by_keywords/live`, under the same
 * request rules as its siblings — keywords required, location and language
 * required, billed once per request.
 *
 * ## The landmine, and who enforces the guardrail
 *
 * The response carries `impressions` and `ctr` **always null** — deprecated
 * upstream. A caller that maps the row straight onto a chart publishes an empty
 * chart with axes and a trend line through no data, and the reader concludes
 * their impressions were flat.
 *
 * The guardrail lives in `@/shared/ad-traffic-fields` so the client and any
 * chart surface read one rule, and **the reader that applies it is
 * `@/shared/ad-traffic-forecast-read`** — this client stops at the envelope. A
 * reader is product code, not a vendor call, and `check-vendor-imports` refused
 * it here for exactly that reason.
 *
 * ## Why it is a cross-check and not a forecast
 *
 * Ad traffic and organic traffic are different systems answering different
 * questions, and the reference gives no mechanism joining them. This endpoint is
 * honest about a *paid* plan's expected outcome; it cannot corroborate an
 * organic one. A caller reaches for it as a sanity check on a bid, not as a
 * second opinion on organic visibility.
 */

const MAX_KEYWORDS = 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The keywords-data task shape, and its reader — the same pair the other Google
 * Ads clients use, because `keywords_data` returns rows directly in `result`
 * with no `items` wrapper (unlike Labs).
 */
type KeywordsDataTask<T> = DataforseoTaskLike & { result?: T[] };

function taskItems<T>(task: KeywordsDataTask<T>): T[] {
  return task.result ?? [];
}

export async function fetchAdTrafficForecast(input: {
  keywords: string[];
  locationCode: number;
  languageCode: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<DataforseoApiResponse<AdTrafficRow[]>> {
  if (input.keywords.length === 0 || input.keywords.length > MAX_KEYWORDS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The Google Ads traffic forecast takes between 1 and ${MAX_KEYWORDS} keywords per request; got ${input.keywords.length}.`,
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
  }
  // The reference requires a location and a language; a request missing either
  // is a billed rejection, and the two are checked before the call for the same
  // reason as everywhere else.
  if (!input.locationCode || !input.languageCode) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The Google Ads traffic forecast requires both a location code and a language code.",
    );
  }

  const response = await dataforseoPost<KeywordsDataTask<AdTrafficRow>>(
    "/v3/keywords_data/google_ads/ad_traffic_by_keywords/live",
    [
      {
        keywords: input.keywords,
        location_code: input.locationCode,
        language_code: input.languageCode,
        date_from: input.dateFrom,
        date_to: input.dateTo,
      },
    ],
  );
  const task = assertOk(response);
  return {
    data: taskItems(task),
    billing: buildTaskBilling(task),
  };
}
