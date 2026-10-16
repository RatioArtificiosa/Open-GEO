import { describe, expect, it } from "vitest";
import {
  estimateAiKeywordVolume,
  estimateBacklinksHistory,
  estimateBacklinksList,
  estimateBusinessListings,
  estimateCategoryItems,
  estimateClickstreamVolumes,
  estimateContentListings,
  estimateContentSearch,
  estimateKeywordOverview,
  estimatePhraseTrends,
  estimateRankedKeywords,
  estimateRelevantPages,
  estimateSearchIntent,
  estimateSerpCompetitors,
  estimateTechnologies,
  estimateWhois,
} from "@/server/lib/dataforseo/client-estimates";
import { resolveInternalListLimit } from "@/server/lib/dataforseo/content-analysis";
import {
  countUnits,
  daysInclusive,
  requestPlusUnits,
  trendPeriods,
} from "@/server/lib/dataforseo/estimates";

/**
 * A4 estimator completeness: every named estimator driven directly.
 *
 * These are the exact functions `client.ts` passes to the credit gate, so a
 * price-book change fails here and forces the estimator's review instead of
 * silently underquoting. Expected values are hand-computed from the book
 * (shown in comments), never copied from implementation output.
 */
describe("countUnits", () => {
  it("mirrors request defaults and floors fractions", () => {
    expect(countUnits(10, 100)).toBe(10);
    expect(countUnits(undefined, 100)).toBe(100);
    expect(countUnits(2.9, 100)).toBe(2);
    expect(countUnits(-5, 100)).toBe(1);
    expect(countUnits(0, 100)).toBe(1);
  });

  it("never propagates NaN or infinity into money", () => {
    expect(countUnits(Number.NaN, 100)).toBe(100);
    expect(countUnits(Number.POSITIVE_INFINITY, 100)).toBe(100);
    expect(countUnits(2000, 100, 1000)).toBe(1000);
  });
});

describe("requestPlusUnits", () => {
  it("adds the request fee to scaled units, with the clickstream multiplier", () => {
    // 0.012 + 10 × 0.00012
    expect(requestPlusUnits(0.012, 0.00012, 10)).toBeCloseTo(0.0132, 6);
    // doubled request fee: 2 × 0.012 + 10 × 0.00012
    expect(requestPlusUnits(0.012, 0.00012, 10, 2)).toBeCloseTo(0.0252, 6);
  });
});

describe("named estimators (the gate's actual inputs)", () => {
  it("whois bills the request plus per returned domain", () => {
    // 0.12 + 5 × 0.0012 ; default 10 → 0.12 + 10 × 0.0012
    expect(estimateWhois({ limit: 5 })).toBeCloseTo(0.126, 6);
    expect(estimateWhois({})).toBeCloseTo(0.132, 6);
  });

  it("technologies bills the request plus per row", () => {
    // 0.012 + 10 × 0.0012
    expect(estimateTechnologies({})).toBeCloseTo(0.024, 6);
  });

  it("business listings bills the request plus per listing", () => {
    // 0.012 + 20 × 0.00036
    expect(estimateBusinessListings({ limit: 20 })).toBeCloseTo(0.0192, 6);
  });

  it("search_intent bills per keyword sent", () => {
    // 0.012 + 1000 × 0.00012 (raw length; dedupe can only overquote)
    expect(
      estimateSearchIntent({
        keywords: Array.from({ length: 1000 }, () => "x"),
      }),
    ).toBeCloseTo(0.132, 6);
  });

  it("keyword_overview bills per keyword with the clickstream double", () => {
    // 0.012 + 700 × 0.00012 ; flagged: 2 × 0.012 + 700 × 0.00012
    expect(
      estimateKeywordOverview({
        keywords: Array.from({ length: 700 }, () => "x"),
      }),
    ).toBeCloseTo(0.096, 6);
    expect(
      estimateKeywordOverview({
        keywords: Array.from({ length: 700 }, () => "x"),
        includeClickstreamData: true,
      }),
    ).toBeCloseTo(0.108, 6);
  });

  it("ranked lists bill per item against the required limit", () => {
    // 0.012 + 100 × 0.00012
    expect(estimateRankedKeywords({ limit: 100 })).toBeCloseTo(0.024, 6);
    expect(estimateRelevantPages({ limit: 100 })).toBeCloseTo(0.024, 6);
    expect(estimateSerpCompetitors({ limit: 100 })).toBeCloseTo(0.024, 6);
  });

  it("category endpoints add the clickstream request-fee double", () => {
    // 0.012 + 50 × 0.00012 ; flagged: + 0.012
    expect(estimateCategoryItems({ limit: 50 })).toBeCloseTo(0.018, 6);
    expect(
      estimateCategoryItems({ limit: 50, includeClickstreamData: true }),
    ).toBeCloseTo(0.03, 6);
  });

  it("backlinks list endpoints bill per row against the sent limit", () => {
    // 0.024 + 100 × 0.000036
    expect(estimateBacklinksList({})).toBeCloseTo(0.0276, 6);
    expect(estimateBacklinksList({ limit: 10 })).toBeCloseTo(0.02436, 6);
  });

  it("backlinks history bills per day in range", () => {
    // 0.024 + 365 × 0.000036
    expect(
      estimateBacklinksHistory({
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
      }),
    ).toBeCloseTo(0.03714, 6);
  });

  it("content endpoints bill per internal-list citation", () => {
    // 0.024 + 10 × 0.000036
    expect(estimateContentListings({})).toBeCloseTo(0.02436, 6);
    expect(estimateContentSearch({ limit: 10 })).toBeCloseTo(0.02436, 6);
  });

  it("phrase trends multiply periods by the internal list", () => {
    // Jan 2025, monthly: 1 period × 10 citations → 0.024 + 10 × 0.000036
    expect(
      estimatePhraseTrends({
        dateFrom: "2025-01-01",
        dateTo: "2025-01-31",
        dateGroup: "month",
      }),
    ).toBeCloseTo(0.02436, 6);
  });

  it("clickstream bulk bills per keyword sent", () => {
    // 0.012 + 500 × 0.00012
    expect(
      estimateClickstreamVolumes({
        keywords: Array.from({ length: 500 }, () => "x"),
      }),
    ).toBeCloseTo(0.072, 6);
  });

  it("ai keyword batches wire the tested helper (task fee plus rate)", () => {
    // 1 keyword: $0.01 task fee + 1 × 0.0001
    expect(estimateAiKeywordVolume({ keywords: ["x"] })).toBeCloseTo(0.0101, 6);
  });
});

describe("daysInclusive", () => {
  it("counts whole days inclusive across a year", () => {
    expect(daysInclusive("2025-01-01", "2025-12-31")).toBe(365);
    expect(daysInclusive("2025-06-15", "2025-06-15")).toBe(1);
    expect(daysInclusive("2024-02-28", "2024-03-01")).toBe(3);
  });

  it("returns null for reversed or impossible bounds", () => {
    expect(daysInclusive("2025-12-31", "2025-01-01")).toBeNull();
    expect(daysInclusive("2026-02-31", "2026-03-01")).toBeNull();
    expect(daysInclusive("not-a-date", "2026-03-01")).toBeNull();
  });
});

describe("trendPeriods", () => {
  it("rounds weeks up and counts calendar months", () => {
    expect(trendPeriods("2025-01-01", "2025-01-31", "day")).toBe(31);
    expect(trendPeriods("2025-01-01", "2025-01-31", "week")).toBe(5);
    expect(trendPeriods("2025-01-01", "2025-03-31", "month")).toBe(3);
    expect(trendPeriods("2025-01-01", "2025-01-01", "month")).toBe(1);
  });

  it("returns null when the window is not real", () => {
    expect(trendPeriods("2025-03-01", "2025-01-01", "day")).toBeNull();
    expect(trendPeriods("garbage", "2025-01-01", "month")).toBeNull();
  });
});

describe("resolveInternalListLimit", () => {
  it("mirrors the request default, floor, and vendor cap", () => {
    expect(resolveInternalListLimit(undefined)).toBe(10);
    expect(resolveInternalListLimit(0)).toBe(1);
    expect(resolveInternalListLimit(-4)).toBe(1);
    expect(resolveInternalListLimit(2.7)).toBe(2);
    expect(resolveInternalListLimit(50)).toBe(20);
  });

  it("defaults garbage instead of billing a rejection for it", () => {
    expect(resolveInternalListLimit(Number.NaN)).toBe(10);
  });
});
