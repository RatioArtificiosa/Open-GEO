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
  /**
   * **The tightest ceiling in the file, and the arithmetic is the reason.**
   * One question is *two* billable calls — a SERP post (~2 credits) and the
   * summary (10) — so a run costs ~12 credits against `backlink-checker`'s
   * single ~2.5-credit call. At the same run count this tool would spend five
   * times what the others do, so the ceiling is set per *call* like every other
   * tool here, which already accounts for the doubling.
   *
   * 200 is deliberately low: it is ~100 questions a day across all visitors,
   * which is far below the free budget. A higher number would spend real money
   * on LLM summarisation for anonymous traffic, and this is the one free tool
   * where the response is prose rather than rows — so it is the easiest to
   * farm and the least obviously valuable to a first-time visitor.
   */
  "ask-the-ai": 200,
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
  /**
   * A SERP post at depth 10 (~$0.002) plus `serp/ai_summary` (~$0.01) is
   * ~12 cents, so 12_000 microdollars per call is the ceiling for the pair.
   * **Not 10_000:** that is the summary alone, and the crawl is billed whether
   * or not the summary is ever requested — under-reserving here means the daily
   * dollar ceiling can be exceeded by exactly the calls nobody asked for.
   */
  "ask-the-ai": 12_000,
} as const;
