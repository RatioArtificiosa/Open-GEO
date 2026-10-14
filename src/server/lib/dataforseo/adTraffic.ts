import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { AppError } from "@/server/lib/errors";
import {
  USABLE_AD_TRAFFIC_FIELDS,
  adTrafficChartRule,
  adTrafficRefusalWarning,
  type AdTrafficField,
} from "@/shared/ad-traffic-fields";
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
 * ## The landmine, and why this client enforces the guardrail at the read
 *
 * The response carries `impressions` and `ctr` **always null** — deprecated
 * upstream. A caller that maps the row straight onto a chart publishes an empty
 * chart with axes and a trend line through no data, and the reader concludes
 * their impressions were flat. The guardrail lives in `@/shared/ad-traffic-fields`
 * so the client and any chart surface read one rule, and this client applies it
 * at the read: the deprecated fields are **named in a refusal that travels with
 * the data**, never silently dropped.
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

/**
 * One keyword's forecast row, as the vendor sends it.
 *
 * `impressions` and `ctr` are typed as **always-null rather than omitted**: a
 * type that hides the field invites a caller to read it, and a caller that
 * reads it gets `undefined` where a null was sent and reports it as absent
 * rather than as deprecated. They are optional rather than required because the
 * envelope's `result` is `unknown[]` — the type states what the vendor sends,
 * and does not pretend the type system proved it.
 */
export type AdTrafficRow = {
  keyword?: string | null;
  clicks?: number | null;
  average_cpc?: number | null;
  cost?: number | null;
  /** Deprecated upstream and always null. Never charted — see the guardrail. */
  impressions?: null;
  /** Deprecated upstream and always null. Never charted — see the guardrail. */
  ctr?: null;
  [key: string]: unknown;
};

/** The forecast as the product is allowed to show it. */
export type AdTrafficForecast = {
  rows: Array<{
    keyword: string;
    /** The requested fields that carry a measurement, with their values. */
    values: Partial<
      Record<Exclude<AdTrafficField, "impressions" | "ctr">, number>
    >;
  }>;
  /** What was refused, and why. Null when the caller asked only for usable fields. */
  refusal: string | null;
};

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

/**
 * Read a forecast into the shape the product may show.
 *
 * **The guardrail is applied here, at the read, and not left to a caller.** The
 * two deprecated fields are named in the refusal rather than dropped: a caller
 * who asked for four fields and received three must be told which one vanished
 * and why, because an unexplained missing series reads as data the vendor never
 * sent. And the values carry **only the requested usable fields**, so a caller
 * that asked for `cost` gets `cost` — the rule's `chartable` list is what the
 * read returns, not a full row with the deprecated pair hidden inside it.
 *
 * Billing is deliberately not part of this read: it belongs to the envelope the
 * caller already holds, and a reader that manufactured a number would be the
 * paid-log defect the envelope-returning sibling of `meter` exists to prevent.
 */
export function readAdTrafficForecast(
  rows: AdTrafficRow[],
  requestedFields: readonly string[],
): AdTrafficForecast {
  const rule = adTrafficChartRule(requestedFields);
  const usable = new Set<string>(rule.chartable);
  return {
    rows: rows.map((row) => {
      const values: Partial<
        Record<Exclude<AdTrafficField, "impressions" | "ctr">, number>
      > = {};
      for (const field of USABLE_AD_TRAFFIC_FIELDS) {
        if (!usable.has(field)) continue;
        const value = row[field];
        if (typeof value === "number") values[field] = value;
      }
      return { keyword: row.keyword ?? "", values };
    }),
    refusal: adTrafficRefusalWarning(rule),
  };
}
