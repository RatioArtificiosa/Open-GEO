import {
  adTrafficChartRule,
  adTrafficRefusalWarning,
  USABLE_AD_TRAFFIC_FIELDS,
  type AdTrafficField,
} from "@/shared/ad-traffic-fields";

/**
 * The ad forecast, read into the shape the product is allowed to show.
 *
 * ## Why the reader lives here and not beside the client
 *
 * `check-vendor-imports` refuses a vendor-path binding outside the metered
 * client, and it refused this one — correctly. A reader is not a vendor call:
 * it takes a response the client already fetched and shapes it, which makes it
 * product code on the wrong side of the seam when it sits in
 * `src/server/lib/dataforseo/`. Its siblings `readCategoryTrend` and
 * `readTrendSeries` already live with their features for the same reason.
 *
 * The **client** keeps the vendor path, the validation and the envelope; this
 * module keeps the decision about what a forecast may show. The guardrail's
 * field rule stays in `@/shared/ad-traffic-fields`, one level further from the
 * vendor, because a chart surface needs it too.
 */

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
