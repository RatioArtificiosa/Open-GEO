import type { FreeToolSlug } from "@/lib/free-tools/tool-pages";

/**
 * Spend controls for the free tools. These live away from the marketing
 * registry on purpose: a copy edit to a tool's name or blurb must not be able
 * to move a spend ceiling.
 *
 * Every number below counts BILLABLE DATAFORSEO CALLS PER DAY, not tool runs —
 * one traffic check is three calls, one competitor analysis with your own
 * domain is five. `null` means the tool makes no paid call at all.
 *
 * Reservations are atomic in a Durable Object per UTC day. Reserve before
 * contacting the provider, including attempts that subsequently fail.
 */
export const dataforseoCallsPerDay = {
  "backlink-checker": 1000,
  "competitor-keyword-finder": 2000,
  "keyword-generator": 2000,
  "website-traffic-checker": 3000,
  "competitor-analysis": 2500,
  "spam-score-checker": 600,
  "domain-age-checker": null,
  "serp-simulator": null,
} satisfies Record<FreeToolSlug, number | null>;

/** Ceiling across every paid tool combined, below the sum of the per-tool caps. */
export const ALL_TOOLS_CALLS_PER_DAY = 6000;

/** Ceiling for one visitor across every paid tool, on top of the 5/min limit. */
export const PER_IP_CALLS_PER_DAY = 40;

/** Conservative USD ceilings in millionths, at the routes' fixed result limits.
 * Revisit when provider pricing, endpoints, row limits, or SERP depth change.
 * No refunds: failed or partially completed upstream requests remain reserved.
 */
export const reservedMicroDollarsPerCall = {
  "backlink-checker": 25_000,
  "competitor-keyword-finder": 15_000,
  "keyword-generator": 15_000,
  "website-traffic-checker": 15_000,
  "competitor-analysis": 15_000,
  "spam-score-checker": 25_000,
} as const;
