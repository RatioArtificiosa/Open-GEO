/**
 * The ad-forecast guardrail: which fields of a Google Ads traffic forecast can
 * be charted, and which must never be.
 *
 * ## The landmine, and why a rule exists for it
 *
 * `google_ads/ad_traffic_by_keywords` returns `clicks`, `average_cpc` and
 * `cost` — and also `impressions` and `ctr`, which are **deprecated upstream
 * and always null**. A chart built from a row of nulls is a published nothing:
 * an empty chart with axes, a legend and a trend line through no data, telling a
 * reader "your impressions were flat" when the truth is "the vendor stopped
 * returning them". The rule is cheap and it exists to prevent that one specific
 * artifact.
 *
 * ## Why a refused field is never silently dropped
 *
 * The tempting implementation filters the deprecated names out and returns the
 * rest — and the chart then shows three series with no explanation of why a
 * caller asked for four. A reader who requested `impressions` and sees three
 * series concludes the request was answered. So the rule **names** what it
 * refused, and the name travels with the answer.
 *
 * ## Why the warning is null when nothing was refused
 *
 * A warning on every response is a warning nobody reads. The rule fires only
 * when a caller actually asked for a deprecated field, which is the case it can
 * prevent.
 */

/** The two fields the vendor returns null, deprecated upstream. */
export const DEPRECATED_AD_TRAFFIC_FIELDS = ["impressions", "ctr"] as const;

/** The fields that carry a measurement. */
export const USABLE_AD_TRAFFIC_FIELDS = [
  "clicks",
  "average_cpc",
  "cost",
] as const;

/** Every field the endpoint returns, usable or not. */
export const AD_TRAFFIC_FIELDS = [
  ...USABLE_AD_TRAFFIC_FIELDS,
  ...DEPRECATED_AD_TRAFFIC_FIELDS,
] as const;

export type AdTrafficField = (typeof AD_TRAFFIC_FIELDS)[number];

/**
 * The rule's verdict, for a caller that wants the parts rather than the
 * sentence.
 *
 * Not exported: nothing outside this module names it, and a consumer reaches it
 * as `ReturnType<typeof adTrafficChartRule>` when it does. An export no other
 * file uses is a name that drifts from the thing it names.
 */
type AdTrafficChartRule = {
  /** The requested fields that carry a measurement. */
  chartable: AdTrafficField[];
  /** The requested fields that are deprecated and always null. Never dropped silently. */
  refused: AdTrafficField[];
  /** True when the caller asked for at least one deprecated field. */
  hasRefusal: boolean;
};

/** True when a field is one the vendor deprecated and always returns null. */
export function isDeprecatedAdTrafficField(field: string): boolean {
  return (DEPRECATED_AD_TRAFFIC_FIELDS as readonly string[]).includes(field);
}

/**
 * True when a field carries a measurement.
 *
 * Separated from `isDeprecatedAdTrafficField` so the rule's push is a narrowing
 * on a guard's result rather than a cast on a `string` — the repo bans the
 * latter, and the guard is the fact the cast would have asserted.
 *
 * Module-private: no other file names it, and a guard exported for symmetry is
 * a name that drifts from the thing it names.
 */
function isUsableAdTrafficField(field: string): field is AdTrafficField {
  return (USABLE_AD_TRAFFIC_FIELDS as readonly string[]).includes(field);
}

/**
 * Apply the rule to the fields a caller wants to chart.
 *
 * An unknown field is **not** refused by this rule — it is nobody's deprecated
 * field, and a second list to maintain is a second thing to forget. The caller's
 * own schema decides what exists; this decides what is chartable.
 *
 * The guard functions answer the membership question and the push is a
 * narrowing on their result, not an assertion on a `string`: a field that has
 * just been proven to be one of the five is one of the five, and writing that
 * as `as` would be a cast the type checker has to trust rather than a fact it
 * can check.
 */
export function adTrafficChartRule(
  requested: readonly string[],
): AdTrafficChartRule {
  const chartable: AdTrafficField[] = [];
  const refused: AdTrafficField[] = [];
  for (const field of requested) {
    if (isDeprecatedAdTrafficField(field)) {
      refused.push(field === "impressions" ? "impressions" : "ctr");
      continue;
    }
    if (isUsableAdTrafficField(field)) {
      chartable.push(field);
    }
  }
  return { chartable, refused, hasRefusal: refused.length > 0 };
}

/**
 * The sentence that must travel with any answer that refused a field.
 *
 * Null when nothing was refused — the rule fires only when it can prevent
 * something. Named fields, not "some fields", for the same reason as everywhere
 * else: a reader who cannot see which field was refused cannot act on it.
 */
export function adTrafficRefusalWarning(
  rule: AdTrafficChartRule,
): string | null {
  if (!rule.hasRefusal) return null;
  const list = rule.refused.map((field) => `\`${field}\``).join(" and ");
  const verb = rule.refused.length === 1 ? "is" : "are";
  return (
    `${list} ${verb} deprecated by the vendor and always returned null, so nothing is charted for ${verb === "is" ? "it" : "them"}. ` +
    `Only ${USABLE_AD_TRAFFIC_FIELDS.join(", ")} carry a measurement — an empty impressions chart would read as flat interest when the truth is that the vendor stopped reporting it.`
  );
}
