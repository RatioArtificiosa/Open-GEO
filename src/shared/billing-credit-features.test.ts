import { describe, expect, it } from "vitest";
import {
  creditFeatureLabel,
  mapDataforseoPathToCreditFeature,
  type CreditFeature,
} from "./billing-credit-features";

/**
 * The path → billing-feature mapper.
 *
 * This file exists mostly because the mapper had **no test of its own** and no
 * test of its `default` branch. Both facts mattered: the `ai_optimization` rule
 * was a two-branch `if` written when the module had two products, and it silently
 * mis-billed a third one that arrived later.
 *
 * The two tests to keep in mind while reading:
 *
 * - `ai_keyword_data` must not be `ai_prompt_responses`. It calls no model; it
 *   reads a statistical dataset. Getting this wrong overstated prompt spend by
 *   orders of magnitude on the exact traffic the free tools attract.
 * - The `default` branch must be pinned. An unmapped path billing as
 *   `site_audit` is a guess that looks like a fact in a customer-facing
 *   breakdown, and nothing caught it because nothing exercised it.
 */

describe("mapDataforseoPathToCreditFeature", () => {
  it("bills AI keyword demand as demand, not as a model prompt", () => {
    // The bug this file was written for. `ai_keyword_data/keywords_search_volume`
    // is ~$0.06 per 1,000 keywords and calls no model at all; `llm_responses` is
    // ~$0.002 per prompt. Billing the first as the second inflated prompt spend
    // by ~30x on a feature the free tools run on every visit.
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "ai_optimization",
        "ai_keyword_data",
        "keywords_search_volume",
        "live",
      ]),
    ).toBe("ai_demand");
  });

  it("bills the keyword-data metadata lookup as demand too", () => {
    // `locations_and_languages` is free and shared by all three AI products. It
    // is fetched *for* demand research, and a `metadata` feature would appear in
    // a customer breakdown as a line nobody can act on.
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "ai_optimization",
        "locations_and_languages",
        "live",
      ]),
    ).toBe("ai_demand");
  });

  it("still bills brand-mention lookups as citations", () => {
    for (const endpoint of [
      "search",
      "aggregated_metrics",
      "target_metrics",
      "historical",
      "top_pages",
      "cross_aggregated_metrics",
    ]) {
      expect(
        mapDataforseoPathToCreditFeature([
          "v3",
          "ai_optimization",
          "llm_mentions",
          endpoint,
          "live",
        ]),
      ).toBe("ai_citations");
    }
  });

  it("bills content analysis as citations, not as site audit or backlinks", () => {
    // Content Analysis answers "which domains cite this keyword, and how were
    // those pages classified" — citation data. It falls through to the
    // `default` of `site_audit` otherwise, and a customer would read a line
    // saying we spent their credits crawling pages, which this never does.
    // `backlinks` would be equally wrong: it renders as "Backlinks" beside a
    // call that never touched a backlink.
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "content_analysis",
        "summary",
        "live",
      ]),
    ).toBe("ai_citations");
  });

  it("still bills actual model calls as prompt responses", () => {
    // Every provider's `/llm_responses` endpoint. This is the branch that must
    // not widen: adding `ai_demand` was the fix for a mis-billing, and the
    // temptation it creates is to make the default broader still.
    for (const provider of ["chat_gpt", "claude", "gemini", "perplexity"]) {
      expect(
        mapDataforseoPathToCreditFeature([
          "v3",
          "ai_optimization",
          provider,
          "llm_responses",
          "live",
        ]),
      ).toBe("ai_prompt_responses");
    }
  });

  it("prepends v3 so a path with or without it classifies the same", () => {
    // The provider returns both forms: `task.path` includes `v3`, while a
    // reconstructed path from stored properties may not.
    expect(
      mapDataforseoPathToCreditFeature([
        "ai_optimization",
        "llm_mentions",
        "search",
        "live",
      ]),
    ).toBe("ai_citations");
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "ai_optimization",
        "llm_mentions",
        "search",
        "live",
      ]),
    ).toBe("ai_citations");
  });

  it("falls back to site_audit for a module it does not know", () => {
    // Pinned because it was previously untested, and a guess that reads like a
    // measurement in a customer-facing breakdown is a bad thing to leave
    // unverified. If a new module is added, this is the test that should fail —
    // which is the point: a new endpoint should be a *deliberate* classification.
    expect(
      mapDataforseoPathToCreditFeature(["v3", "some_new_module", "live"]),
    ).toBe("site_audit");
    expect(mapDataforseoPathToCreditFeature([])).toBe("site_audit");
  });

  it("keeps the classic SEO modules where they were", () => {
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "on_page",
        "lighthouse",
        "live",
        "json",
      ]),
    ).toBe("site_audit");
    expect(
      mapDataforseoPathToCreditFeature(["v3", "backlinks", "summary", "live"]),
    ).toBe("backlinks");
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "keywords_data",
        "google_ads",
        "search_volume",
        "live",
      ]),
    ).toBe("keyword_research");
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "serp",
        "google",
        "organic",
        "live",
        "advanced",
      ]),
    ).toBe("keyword_research");
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "serp",
        "google",
        "maps",
        "live",
        "advanced",
      ]),
    ).toBe("local_seo");
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "business_data",
        "business_listings",
        "search",
        "live",
      ]),
    ).toBe("local_seo");
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "dataforseo_labs",
        "google",
        "domain_rank_overview",
        "live",
      ]),
    ).toBe("domain_overview");
    expect(
      mapDataforseoPathToCreditFeature([
        "v3",
        "dataforseo_labs",
        "google",
        "related_keywords",
        "live",
      ]),
    ).toBe("keyword_research");
  });

  it("only ever returns a declared feature", () => {
    // The union is the contract a billing breakdown is built from. A stray
    // string would render as "Other" and quietly lose the spend.
    const declared: CreditFeature[] = [
      "keyword_research",
      "domain_overview",
      "backlinks",
      "site_audit",
      "rank_tracking",
      "ai_citations",
      "ai_demand",
      "ai_prompt_responses",
      "local_seo",
      "agent",
    ];
    const paths = [
      [
        "v3",
        "ai_optimization",
        "ai_keyword_data",
        "keywords_search_volume",
        "live",
      ],
      ["v3", "ai_optimization", "llm_mentions", "search", "live"],
      ["v3", "ai_optimization", "chat_gpt", "llm_responses", "live"],
      ["v3", "on_page", "lighthouse", "live", "json"],
      ["v3", "unknown"],
    ];
    for (const path of paths) {
      expect(declared).toContain(mapDataforseoPathToCreditFeature(path));
    }
  });
});

describe("creditFeatureLabel", () => {
  it("labels the new feature, so spend is attributable", () => {
    // A feature with no label renders as "Other" in the breakdown, which is how
    // the mis-billing would have stayed invisible for so long.
    expect(creditFeatureLabel("ai_demand")).toBe("AI Demand");
  });

  it("keeps the legacy keys that historical events still carry", () => {
    // These are not in the union any more, but old usage rows have them, and
    // dropping the labels would rewrite last month's breakdown as "Other".
    expect(creditFeatureLabel("ai_search")).toBe("AI Search");
    expect(creditFeatureLabel("onboarding")).toBe("Onboarding");
  });

  it("labels an unknown key as Other rather than throwing", () => {
    expect(creditFeatureLabel("something_new")).toBe("Other");
  });
});
