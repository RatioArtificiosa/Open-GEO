import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { research } from "./research";

/**
 * CL-400 walkthrough: the keyword research flow end to end.
 *
 * Seed → related → suggestions → (ideas only if needed) → rows carrying
 * volume, difficulty and intent from the overview-shaped bodies, persisted
 * with their intent. The unit tests pin each mapper; this file pins the
 * *join* — the waterfall order, the short-circuit that avoids billing a
 * third source, and the fact that intent survives to the stored row.
 *
 * Bodies below are the vendor's recorded shapes (`keyword_info`,
 * `keyword_properties`, `search_intent_info`), not hand-shaped ideals: the
 * unknown label and the null intent are the cases the flow must not choke
 * on, because the vendor sends both.
 */

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  related: vi.fn(),
  suggestions: vi.fn(),
  ideas: vi.fn(),
  adsIdeas: vi.fn(),
  upsertKeywordMetric: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
  buildCacheKey: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: mocks.buildCacheKey,
  getCached: mocks.getCached,
  setCached: mocks.setCached,
  CACHE_TTL: { researchResult: 3600 },
}));

vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: {
      upsertKeywordMetric: mocks.upsertKeywordMetric,
    },
  }),
);

const billing: BillingCustomerContext = {
  organizationId: "org_1",
  userEmail: "walkthrough@example.com",
  userId: "user_walkthrough",
};

const billed = (keyword: string, mainIntent: string | null) => ({
  keyword,
  keyword_info: {
    search_volume: 1000,
    cpc: 2.5,
    competition: 0.4,
    monthly_searches: [{ year: 2026, month: 9, search_volume: 1000 }],
  },
  keyword_properties: { keyword_difficulty: 30 },
  search_intent_info: { main_intent: mainIntent },
});

const relatedWrap = (keyword: string, mainIntent: string | null) => ({
  keyword_data: billed(keyword, mainIntent),
});

type PersistedRow = { keyword: string; intent: string | null };
let persisted: PersistedRow[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  persisted = [];
  mocks.buildCacheKey.mockImplementation(async (prefix: string) => prefix);
  mocks.getCached.mockResolvedValue(null);
  mocks.setCached.mockResolvedValue(undefined);
  mocks.upsertKeywordMetric.mockImplementation(async (params: PersistedRow) => {
    persisted.push({ keyword: params.keyword, intent: params.intent });
    return undefined;
  });
  mocks.createDataforseoClient.mockReturnValue({
    keywords: {
      related: mocks.related,
      suggestions: mocks.suggestions,
      ideas: mocks.ideas,
      adsIdeas: mocks.adsIdeas,
    },
  });
});

describe("keyword research walkthrough (CL-400)", () => {
  it("walks related -> suggestions, stops before ideas, and stores intent", async () => {
    // Related covers the seed and one neighbour: below the auto threshold
    // of five non-seed rows, so the flow must continue rather than settle.
    mocks.related.mockResolvedValue([
      relatedWrap("crm software", "commercial"),
      relatedWrap("crm software free", "commercial"),
    ]);
    // Suggestions completes the set, carrying every intent shape the vendor
    // sends: three known labels, one label the normaliser has never seen,
    // and one null. None may fail the row.
    mocks.suggestions.mockResolvedValue([
      billed("best crm software", "commercial"),
      billed("crm software pricing", "transactional"),
      billed("what is crm software", "informational"),
      billed("crm software buy now", "BUY_NOW"),
      billed("crm software xyz", null),
      billed("crm software comparison", "commercial"),
    ]);

    const result = await research(
      {
        projectId: "00000000-0000-4000-8000-000000000001",
        keywords: ["crm software"],
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billing,
    );

    // The waterfall: related tried and insufficient, suggestions sufficient,
    // ideas never billed.
    expect(mocks.related).toHaveBeenCalledTimes(1);
    expect(mocks.suggestions).toHaveBeenCalledTimes(1);
    expect(mocks.ideas).not.toHaveBeenCalled();
    expect(result.source).toBe("suggestions");
    expect(result.usedFallback).toBe(true);
    expect(result.diagnostics.sourceAttempts.map((a) => a.source)).toEqual([
      "related",
      "suggestions",
    ]);

    // Intent survives the join: known labels normalised, the unknown label
    // and the null both degrade to "unknown" rather than dropping the row.
    const byKeyword = new Map(result.rows.map((row) => [row.keyword, row]));
    expect(byKeyword.get("best crm software")?.intent).toBe("commercial");
    expect(byKeyword.get("crm software pricing")?.intent).toBe("transactional");
    expect(byKeyword.get("what is crm software")?.intent).toBe("informational");
    expect(byKeyword.get("crm software buy now")?.intent).toBe("unknown");
    expect(byKeyword.get("crm software xyz")?.intent).toBe("unknown");
    expect(byKeyword.get("best crm software")?.keywordDifficulty).toBe(30);
    expect(byKeyword.get("best crm software")?.searchVolume).toBe(1000);

    // And the stored rows carry the same intent the reader will show.
    const storedByKeyword = new Map(
      persisted.map((row) => [row.keyword, row.intent]),
    );
    expect(storedByKeyword.get("best crm software")).toBe("commercial");
    expect(storedByKeyword.get("crm software xyz")).toBe("unknown");
  });

  it("serves a Labs-unsupported market from Google Ads with unknown intent", async () => {
    // Iceland (2352) is not a Labs market: no difficulty, no intent —
    // asserted here so a Labs-shaped fixture can never make this path look
    // richer than the vendor makes it.
    mocks.adsIdeas.mockResolvedValue([
      {
        keyword: "hotel reykjavik",
        search_volume: 880,
        cpc: 1.2,
        competition_index: 55,
        monthly_searches: [],
      },
    ]);

    const result = await research(
      {
        projectId: "00000000-0000-4000-8000-000000000001",
        keywords: ["hotel reykjavik"],
        locationCode: 2352,
        languageCode: "is",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billing,
    );

    expect(result.source).toBe("google_ads");
    expect(mocks.related).not.toHaveBeenCalled();
    expect(mocks.suggestions).not.toHaveBeenCalled();
    expect(mocks.ideas).not.toHaveBeenCalled();
    expect(result.rows[0]).toMatchObject({
      keyword: "hotel reykjavik",
      searchVolume: 880,
      keywordDifficulty: null,
      intent: "unknown",
    });
  });
});
