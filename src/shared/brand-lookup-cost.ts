/**
 * Raw vendor cost estimates for a Brand Lookup, in USD.
 *
 * These are **DataForSEO's published prices**, not ours, so they are safe in
 * shared (and therefore browser-bundled) code. What is *not* safe is the
 * multiplier applied on top of them. That lives on the server, in
 * `src/server/billing/costMarkup.ts`, and reaches the client through
 * `getBrandLookupCostEstimate` rather than being computed in the browser.
 */

/**
 * One brand lookup is 6 DataForSEO calls: aggregated_metrics, top_pages and
 * mentions_search, each once per platform. Rounded up with headroom because
 * mentions_search is row-priced at the full 100-row sample per platform.
 */
export const BRAND_LOOKUP_RAW_COST_USD = 0.85;

/**
 * Adding competitors triggers 2 extra cross_aggregated_metrics calls, one per
 * platform. Measured live (Jun 2026) at $0.101 each, so $0.202 total for a
 * 4-group comparison, via `pnpm billing:brand-lookup --competitors=...`.
 */
export const BRAND_LOOKUP_COMPETITOR_RAW_COST_USD = 0.2;
