/**
 * Named metering estimators (A4 audit) — one per price-book entry with a
 * per-unit term whose count the request controls.
 *
 * Extracted from `client.ts` so the credit-gate wiring stays readable under
 * the max-lines budget AND so each estimator is directly unit-testable:
 * `estimates.test.ts` drives these functions, not a recomposition of their
 * formulas. Every estimator mirrors the request it prices (the `?? N`
 * matches the fetcher's own default); mirror points are commented.
 * Estimators never throw — unresolvable inputs take a documented ceiling
 * because the gate runs them before the fetch validates.
 */

import { resolveInternalListLimit } from "@/server/lib/dataforseo/content-analysis";
import {
  countUnits,
  daysInclusive,
  requestPlusUnits,
  trendPeriods,
} from "@/server/lib/dataforseo/estimates";
import { standardLabsItemEstimate } from "@/server/lib/dataforseo/labsDomainOverview";
import { estimateAiKeywordBatch } from "@/shared/ai-keyword-batch-cost";
import {
  DFS_DOMAIN,
  DFS_KEYWORDS,
  DFS_LABS,
  DFS_LOCAL,
  DFS_ROWS,
} from "@/shared/dataforseo-pricing";

/** Mirror: `limit: query.limit ?? 10` in fetchWhoisOverview. */
export function estimateWhois(input: { limit?: number }): number {
  return requestPlusUnits(
    DFS_DOMAIN.whois.perRequest,
    DFS_DOMAIN.whois.perUnit,
    countUnits(input.limit, 10),
  );
}

/** Mirror: `limit: input.limit ?? 10` in fetchDomainTechnologies. */
export function estimateTechnologies(input: { limit?: number }): number {
  return requestPlusUnits(
    DFS_DOMAIN.technologies.perRequest,
    DFS_DOMAIN.technologies.perUnit,
    countUnits(input.limit, 10),
  );
}

/** `limit` is required: the count is exact. */
export function estimateBusinessListings(input: { limit: number }): number {
  return requestPlusUnits(
    DFS_LOCAL.businessListings.perRequest,
    DFS_LOCAL.businessListings.perUnit,
    countUnits(input.limit, 1),
  );
}

/** Raw length: validation caps and dedupes, so this can only overquote. */
export function estimateClickstreamVolumes(input: {
  keywords: string[];
}): number {
  return requestPlusUnits(
    DFS_KEYWORDS.clickstream.bulk.perRequest,
    DFS_KEYWORDS.clickstream.bulk.perUnit,
    countUnits(input.keywords.length, 1),
  );
}

/** Mirror: `limit: input.limit ?? 100` in all three list fetchers. */
export function estimateBacklinksList(input: { limit?: number }): number {
  return requestPlusUnits(
    DFS_ROWS.backlinks.perRequest,
    DFS_ROWS.backlinks.perUnit,
    countUnits(input.limit, 100),
  );
}

/** Days in range, inclusive; unparseable bounds take a one-year ceiling. */
export function estimateBacklinksHistory(input: {
  dateFrom: string;
  dateTo: string;
}): number {
  return requestPlusUnits(
    DFS_ROWS.backlinks.perRequest,
    DFS_ROWS.backlinks.perUnit,
    daysInclusive(input.dateFrom, input.dateTo) ?? 366,
  );
}

/** `limit` is required: the count is exact. Reuses the tested helper. */
export function estimateRankedKeywords(input: { limit: number }): number {
  return standardLabsItemEstimate(input.limit);
}

/** `limit` is required: the count is exact. Reuses the tested helper. */
export function estimateRelevantPages(input: { limit: number }): number {
  return standardLabsItemEstimate(input.limit);
}

/** Single post: keywords do not multiply tasks, the limit caps items. */
export function estimateSerpCompetitors(input: { limit: number }): number {
  return standardLabsItemEstimate(input.limit);
}

/** Keywords sent (≤700 enforced upstream); clickstream doubles only the fee. */
export function estimateKeywordOverview(input: {
  keywords: string[];
  includeClickstreamData?: boolean;
}): number {
  return requestPlusUnits(
    DFS_LABS.standard.perRequest,
    DFS_LABS.standard.perUnit,
    countUnits(input.keywords.length, 1),
    input.includeClickstreamData ? DFS_LABS.clickstreamMultiplier : 1,
  );
}

/** Tested helper for the items; the flag doubles only the request fee. */
export function estimateCategoryItems(input: {
  limit: number;
  includeClickstreamData?: boolean;
}): number {
  return (
    standardLabsItemEstimate(input.limit) +
    (input.includeClickstreamData ? DFS_LABS.standard.perRequest : 0)
  );
}

/** Raw length: validation dedupes, so this can only overquote duplicates. */
export function estimateSearchIntent(input: { keywords: string[] }): number {
  return requestPlusUnits(
    DFS_LABS.searchIntent.perRequest,
    DFS_LABS.searchIntent.perUnit,
    countUnits(input.keywords.length, 1),
  );
}

/** Mirror: the shared internal-list formula (default 10, cap 20). */
export function estimateContentListings(input: {
  internalListLimit?: number;
}): number {
  return requestPlusUnits(
    DFS_ROWS.contentAnalysis.perRequest,
    DFS_ROWS.contentAnalysis.perUnit,
    resolveInternalListLimit(input.internalListLimit),
  );
}

/** Page rows mirror `limit ?? 100` (cap 1000); per-row internal lists fold
 * into the row count — funding-day reconciliation (Phase 8 item 8.4)
 * decides whether that fold holds. */
export function estimateContentSearch(input: { limit?: number }): number {
  return requestPlusUnits(
    DFS_ROWS.contentAnalysis.perRequest,
    DFS_ROWS.contentAnalysis.perUnit,
    countUnits(input.limit, 100, 1000),
  );
}

/** Periods in the window times the internal list; date_to defaults
 * server-side to today, so the estimator mirrors with its own clock (same
 * pattern as the historical estimator). Unresolvable windows take the
 * one-year ceiling. */
export function estimatePhraseTrends(input: {
  dateFrom: string;
  dateTo?: string;
  dateGroup?: "day" | "week" | "month";
  internalListLimit?: number;
}): number {
  const today = new Date().toISOString().slice(0, 10);
  const periods =
    trendPeriods(
      input.dateFrom,
      input.dateTo ?? today,
      input.dateGroup ?? "month",
    ) ?? 366;
  return requestPlusUnits(
    DFS_ROWS.contentAnalysis.perRequest,
    DFS_ROWS.contentAnalysis.perUnit,
    resolveInternalListLimit(input.internalListLimit) * periods,
  );
}

/** Wired to the tested batch helper: task fee plus per-keyword rate. */
export function estimateAiKeywordVolume(input: { keywords: string[] }): number {
  return estimateAiKeywordBatch(input.keywords.length).totalUsd;
}
