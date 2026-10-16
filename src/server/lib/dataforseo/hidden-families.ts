import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import { DFS_COMMERCE, DFS_LOCAL } from "@/shared/dataforseo-pricing";

/**
 * The hidden families' typed client, breaker, and dry-run quote (C1/C6).
 *
 * ## What "hidden" means here
 *
 * The scope lock (`specs/0015-hidden-api-scope-lock.md`) binds six families to
 * later phases: Content Generation, Social Signals, Bing Local Pack,
 * Multi-platform reviews, Amazon, and ASO. No feature may be built on them
 * yet — but when one is, its client must already refuse the state every one
 * of them is in today: the vendor answers `50304` "temporarily unavailable"
 * for all ten recorded paths, which is a switched-off route, not an outage.
 *
 * ## The three pieces, and why each is shaped this way
 *
 * 1. **Typed paths.** Every path the lock's table names is a literal here, so
 *    a typo is a compile error rather than a billed 404. A path outside this
 *    table cannot be called through this module at all.
 * 2. **The disabled registry.** The first 50304 marks the path disabled and
 *    every later call refuses before the network — a retry loop against a
 *    switched-off route is an outage that costs spend and produces a support
 *    ticket. A success clears the mark, so a family the vendor enables later
 *    recovers without a deploy.
 * 3. **Documented-price quotes.** The dry run quotes only what the price book
 *    documents per endpoint and refuses the rest by name. A family price
 *    applied to an endpoint is wrong in whichever direction costs more, so
 *    products/sellers, searches, listings, local pack, content generation and
 *    social quote nothing rather than something plausible.
 */

/** Every hidden-family path the scope lock names, as literals. */
export const HIDDEN_FAMILY_PATHS = {
  contentGeneration: [
    "/v3/content_generation/generate_text/live",
    "/v3/content_generation/generate/live",
    "/v3/content_generation/paraphrase/live",
    "/v3/content_generation/check_grammar/live",
    "/v3/content_generation/generate_sub_topics/live",
    "/v3/content_generation/generate_meta_tags/live",
  ],
  socialSignals: [
    "/v3/business_data/social_media/reddit/live",
    "/v3/business_data/social_media/facebook/live",
    "/v3/business_data/social_media/pinterest/live",
  ],
  bingLocalPack: ["/v3/serp/bing/local_pack/live/regular"],
  reviews: [
    "/v3/business_data/google/reviews/task_post",
    "/v3/business_data/tripadvisor/reviews/task_post",
    "/v3/business_data/trustpilot/reviews/task_post",
  ],
  amazon: [
    "/v3/merchant/amazon/asin/live",
    "/v3/merchant/amazon/products/live",
    "/v3/merchant/amazon/sellers/live",
  ],
  aso: [
    "/v3/app_data/apple/app_searches/task_post",
    "/v3/app_data/apple/app_reviews/task_post",
    "/v3/app_data/google/app_searches/task_post",
    "/v3/app_data/google/app_reviews/task_post",
    "/v3/app_data/apple/app_listings/search/live",
    "/v3/app_data/google/app_listings/search/live",
  ],
} as const;

export type HiddenFamilyPath =
  (typeof HIDDEN_FAMILY_PATHS)[keyof typeof HIDDEN_FAMILY_PATHS][number];

/**
 * The documented per-call price per path, where the price book documents one.
 *
 * `null` is not "free" — it is "no documented price", and quoting it refuses
 * rather than guessing. Each entry names the book figure it reads so a
 * repriced endpoint shows as drift, not as a silently stale quote.
 */
const HIDDEN_FAMILY_PRICES: Record<
  HiddenFamilyPath,
  { usdPerCall: number; source: string; unit: string } | null
> = {
  "/v3/content_generation/generate_text/live": null,
  "/v3/content_generation/generate/live": null,
  "/v3/content_generation/paraphrase/live": null,
  "/v3/content_generation/check_grammar/live": null,
  "/v3/content_generation/generate_sub_topics/live": null,
  "/v3/content_generation/generate_meta_tags/live": null,
  "/v3/business_data/social_media/reddit/live": null,
  "/v3/business_data/social_media/facebook/live": null,
  "/v3/business_data/social_media/pinterest/live": null,
  "/v3/serp/bing/local_pack/live/regular": null,
  "/v3/business_data/google/reviews/task_post": {
    usdPerCall: DFS_LOCAL.googleReviews.standard,
    source: "DFS_LOCAL.googleReviews.standard",
    unit: "10 reviews",
  },
  "/v3/business_data/tripadvisor/reviews/task_post": null,
  "/v3/business_data/trustpilot/reviews/task_post": {
    usdPerCall: DFS_LOCAL.trustpilotReviews.standard,
    source: "DFS_LOCAL.trustpilotReviews.standard",
    unit: "20 reviews",
  },
  "/v3/merchant/amazon/asin/live": {
    usdPerCall: DFS_COMMERCE.amazonAsins.live,
    source: "DFS_COMMERCE.amazonAsins.live",
    unit: "request",
  },
  "/v3/merchant/amazon/products/live": null,
  "/v3/merchant/amazon/sellers/live": null,
  "/v3/app_data/apple/app_searches/task_post": null,
  "/v3/app_data/apple/app_reviews/task_post": {
    usdPerCall: DFS_COMMERCE.appStoreReviews.standard,
    source: "DFS_COMMERCE.appStoreReviews.standard",
    unit: "25 reviews",
  },
  "/v3/app_data/google/app_searches/task_post": null,
  "/v3/app_data/google/app_reviews/task_post": {
    usdPerCall: DFS_COMMERCE.googlePlayReviews.standard,
    source: "DFS_COMMERCE.googlePlayReviews.standard",
    unit: "150 reviews",
  },
  "/v3/app_data/apple/app_listings/search/live": null,
  "/v3/app_data/google/app_listings/search/live": null,
};

/**
 * Quote a hidden-family call without touching the network.
 *
 * `tasks` is the number of task_posts the caller will send: the book prices
 * per task, and each task returns up to `unit` rows. A caller reading 100
 * reviews at 10 per task quotes 10 tasks, not 1 — quoting one task for a
 * ten-task read would understate tenfold, which is the same lie as guessing.
 * Throws `VALIDATION_ERROR` naming the path when no documented price exists:
 * a quote the book cannot support is a number someone will budget against, and
 * an invented one is worse than a refusal.
 */
export function quoteHiddenFamilyCall(
  path: HiddenFamilyPath,
  tasks = 1,
): { usd: number; priceSource: string; unit: string } {
  const price = HIDDEN_FAMILY_PRICES[path];
  if (!price) {
    throw new AppError(
      "VALIDATION_ERROR",
      `No documented price for ${path}: refusing to quote rather than guessing. ` +
        `Read the vendor pricing page into the price book first.`,
    );
  }
  return {
    usd: price.usdPerCall * tasks,
    priceSource: price.source,
    unit: price.unit,
  };
}

/** Paths the vendor has switched off, with the reason and mark time. */
const disabledPaths = new Map<string, { reason: string; markedAt: number }>();

/**
 * How long a disabled mark stands before one re-probe is allowed.
 *
 * A mark with no expiry can never recover: the success-clears branch below
 * would be unreachable for exactly the paths it exists for. Entitlements
 * change by vendor decision on human timescales, so one probe per day bounds
 * the waste to a single empty call while letting an enabled family recover
 * without a deploy. The clock is a parameter everywhere it matters, so tests
 * advance time rather than sleeping.
 */
export const DISABLED_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** For tests: the shared registry must not leak between cases. */
export function resetHiddenFamilyDisabled(): void {
  disabledPaths.clear();
}

export function hiddenFamilyDisabledReason(
  path: HiddenFamilyPath,
  now: number = Date.now(),
): string | null {
  const entry = disabledPaths.get(path);
  if (!entry) return null;
  if (now - entry.markedAt >= DISABLED_RETRY_AFTER_MS) {
    disabledPaths.delete(path);
    return null;
  }
  return entry.reason;
}

function noteDisabled(
  path: HiddenFamilyPath,
  reason: string,
  now: number,
): void {
  disabledPaths.set(path, { reason, markedAt: now });
}

function disabledError(path: string, status: number): AppError {
  return new AppError(
    "UPSTREAM_FEATURE_DISABLED",
    `Route ${path} is disabled: the vendor answers ${status} "temporarily ` +
      `unavailable" for it, which means no entitlement on this account — not ` +
      `an outage, and not retried. Offering the family again is a vendor ` +
      `entitlement decision, not a retry.`,
    { path },
  );
}

/**
 * POST one hidden-family call, refusing a switched-off route before the network.
 *
 * - A marked path throws `UPSTREAM_FEATURE_DISABLED` without fetching: the
 *   breaker is open, and an open breaker that still calls is decoration.
 * - The post carries `maxServerErrorRetries: 0`: a billed live call that the
 *   vendor accepts and then drops must never be replayed, and a 50304 that
 *   arrives as HTTP 503 must not be retried into either.
 * - A 50304 at the envelope (tasks null) or on the task marks the path and
 *   throws disabled. The envelope case matters: `assertOk` alone reports it
 *   as `INTERNAL_ERROR`, which reads as broken rather than disabled.
 * - A success clears the mark, and an expired mark allows one re-probe: a
 *   breaker that never re-probes cannot recover, so the mark carries a
 *   timestamp and the clock is injectable. One empty call per day per path is
 *   the bounded price of noticing the vendor enabled the family.
 */
export async function fetchHiddenFamilyLive(
  path: HiddenFamilyPath,
  tasks: unknown[],
  now: number = Date.now(),
): Promise<{
  task: DataforseoTaskLike;
  billing: ReturnType<typeof buildTaskBilling>;
}> {
  const marked = hiddenFamilyDisabledReason(path, now);
  if (marked !== null) {
    throw new AppError("UPSTREAM_FEATURE_DISABLED", marked, { path });
  }
  try {
    const response = await dataforseoPost(path, tasks, {
      maxServerErrorRetries: 0,
      // A 50304 that arrives as HTTP 503 must still read as disabled: without
      // this classifier the HTTP ladder reports UPSTREAM_UNAVAILABLE and the
      // body carrying the entitlement verdict is never read.
      classify: (statusCode) =>
        statusCode === 50304 ? disabledError(path, statusCode) : null,
    });
    if (response !== null && response.status_code === 50304) {
      throw disabledError(path, 50304);
    }
    const task = assertOk(response);
    disabledPaths.delete(path);
    return { task, billing: buildTaskBilling(task) };
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === "UPSTREAM_FEATURE_DISABLED"
    ) {
      noteDisabled(path, error.message, now);
    }
    throw error;
  }
}
