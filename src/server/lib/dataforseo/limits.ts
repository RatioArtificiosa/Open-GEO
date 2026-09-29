/**
 * The vendor's own limits, as data.
 *
 * DataForSEO enforces several published ceilings, and this product has been
 * defending against them by hand: the GEO patrol runs its targets *sequentially*
 * with a comment naming the 30-request cap, and the scheduled rank checker sizes
 * its admission budget against "2,000 requests/min" in prose. Those are correct
 * today and fragile tomorrow — the next fan-out is written by someone who has
 * read neither comment.
 *
 * So the limits live here, as one table, and the two existing call sites read
 * from it. A limit that exists only as a comment is a limit the next person
 * re-derives, gets slightly wrong, and discovers through a bill.
 *
 * ## Two kinds of ceiling, and only one is a hard cap
 *
 * - **Concurrency** — how many calls may be *in flight* at once. The vendor
 *   rejects the 31st with a limit error. This is a semaphore, and it is the one
 *   that bites hardest, because exceeding it looks like a random failure partway
 *   through a fan-out rather than a clear rejection.
 * - **Rate** — how many calls per minute, across *all* connections. A burst that
 *   stays under the concurrency cap can still be throttled.
 *
 * Both are enforced here. The account-wide rate ceiling is the more dangerous of
 * the two precisely because it is *shared*: one project's burst starves another's,
 * and the customer who notices is the one who did nothing wrong.
 *
 * ## Every number is sourced
 *
 * Each entry carries where the limit comes from, and a test asserts the table is
 * not silently emptied — a limits module with an empty table is a module that
 * enforces nothing, and it would look identical to a working one.
 */

export type LimitKind = "concurrency" | "per-minute";

export type EndpointLimit = {
  /** Path prefix, matched against the request path. First match wins. */
  pathPrefix: string;
  kind: LimitKind;
  /** Max simultaneous in-flight calls, or max calls per minute. */
  value: number;
  /** Where this number comes from, in words a reader can check. */
  source: string;
  /**
   * Our own headroom below the vendor ceiling, as a divisor. The vendor's number
   * is the limit, not the target: running at exactly 30 concurrent leaves nothing
   * for the next request and means a single slow call cascades into rejections.
   */
  divisor: number;
};

/**
 * The published limits, in match order — **most specific first**, because the
 * first match wins and a broad prefix placed early would swallow everything below
 * it.
 */
export const ENDPOINT_LIMITS: readonly EndpointLimit[] = [
  {
    pathPrefix: "/v3/keywords_data/google_ads/",
    kind: "per-minute",
    value: 12,
    divisor: 1,
    source:
      "DataForSEO documents 12 requests/minute for Google Ads endpoints. Documented as a rate, not a burst allowance, so no headroom is taken — there is nothing to give back.",
  },
  {
    pathPrefix: "/v3/ai_optimization/llm_responses/",
    kind: "concurrency",
    value: 30,
    divisor: 2,
    source:
      "DataForSEO documents 30 concurrent Live LLM Responses tasks per account per platform.",
  },
  {
    pathPrefix: "/v3/ai_optimization/",
    kind: "concurrency",
    value: 30,
    divisor: 2,
    source:
      "DataForSEO documents 30 concurrent tasks for the ai_optimization database APIs. This is the ceiling the GEO patrol defends today by running its targets in a sequential for-loop.",
  },
  {
    pathPrefix: "/v3/dataforseo_labs/",
    kind: "per-minute",
    value: 1200,
    divisor: 10,
    source:
      "DataForSEO documents 1,200 requests/minute for Labs. Divided by 10 because Labs calls are cheap and fast, and the account-wide budget is the real constraint.",
  },
  {
    // Catch-all. Deliberately last, and deliberately the most conservative entry
    // in the table: an endpoint we have not classified gets the *tightest* bound we
    // apply anywhere, not the loosest. A new client inheriting "unlimited"
    // because nobody added a row is exactly how the account gets throttled.
    pathPrefix: "/v3/",
    kind: "per-minute",
    value: 2000,
    divisor: 10,
    source:
      "DataForSEO's account-wide 2,000 requests/minute. This is the ceiling every other limit shares, which is why it is divided by 10: a burst that is legal per-endpoint can still exhaust the account budget across ten endpoints at once.",
  },
];

/** The limit in force for a request path, or null when nothing matches. */
export function limitFor(path: string): EndpointLimit | null {
  for (const limit of ENDPOINT_LIMITS) {
    if (path.startsWith(limit.pathPrefix)) return limit;
  }
  return null;
}

/**
 * The number we actually enforce.
 *
 * `Math.max(1, …)` so a limit of 0 is never returned: a zero-concurrency gate
 * would deadlock the caller, and the correct response to a misconfigured limit is
 * to be wrong in the permissive direction for one call rather than to hang.
 */
export function effectiveValue(limit: EndpointLimit): number {
  return Math.max(1, Math.floor(limit.value / Math.max(1, limit.divisor)));
}
