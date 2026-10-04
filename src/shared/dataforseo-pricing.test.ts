import { describe, expect, it } from "vitest";
import {
  AI_KEYWORD_UNIT_COST_USD,
  DFS_AI_OPTIMIZATION,
  DFS_COMMERCE,
  DFS_DOMAIN,
  DFS_KEYWORDS,
  DFS_LABS,
  DFS_LOCAL,
  DFS_ONPAGE,
  DFS_ROWS,
  DFS_SERP,
  ETV_VERSION,
  estimateCost,
  estimateCrawl,
  estimateDailyBrandMonitoring,
  estimateScraperPatrol,
  NIGHTLY_BUDGET_USD,
  NIGHTLY_PROJECT_SWEEP_LIMIT,
  PER_PROJECT_NIGHTLY_CAP,
  type CostEstimate,
  type DfsPrice,
  type DfsQueue,
  type EstimateInput,
} from "@/shared/dataforseo-pricing";
import { ETV_BEARING_LABS_ENDPOINTS } from "@/shared/etv-versioning";

// These assertions are the contract. Every figure was read off a rendered
// DataForSEO pricing page on 2026-09-28 (see OPENGEO_MASTER_REFERENCE.md §A.1).
// If a price changes upstream, this test is what should fail first — loudly —
// rather than the pricing slider quietly promising the wrong number.
describe("dataforseo price book", () => {
  it("pins the LLM Mentions price that the whole GEO product is priced on", () => {
    const { perRequest, perUnit } = DFS_AI_OPTIMIZATION.llmMentions;
    expect(perRequest).toBe(0.1);
    expect(perUnit).toBe(0.001);
  });

  it("states that Lite costs the same as Standard (shape, not price)", () => {
    expect(DFS_AI_OPTIMIZATION.llmMentions.caveat).toMatch(
      /minimum commitment/i,
    );
    expect(DFS_AI_OPTIMIZATION.llmMentions.caveat).toMatch(
      /lite endpoints cost the same as standard/i,
    );
  });

  it("keeps the LLM Scraper Standard queue at 1/10th of Live", () => {
    expect(DFS_AI_OPTIMIZATION.llmScraper.standard.perRequest).toBe(0.0012);
    expect(DFS_AI_OPTIMIZATION.llmScraper.live.perRequest).toBe(0.004);
  });

  it("charges Google AI Mode double the base SERP price", () => {
    expect(DFS_SERP.aiMode.standardPage.perRequest).toBe(
      DFS_SERP.standardPage.perRequest * 2,
    );
  });

  it("keeps Google Ads flat per task at 1,000 keywords", () => {
    expect(DFS_LABS.standard.perRequest).toBe(0.012);
    expect(DFS_LABS.standard.perUnit).toBe(0.00012);
  });

  it("documents that clickstream data doubles a Labs request", () => {
    expect(DFS_LABS.clickstreamMultiplier).toBe(2);
  });

  it("warns that the ad forecast's impressions and ctr are dead fields", () => {
    // The warning lives on the ad-forecast entry, not on a queue price.
    expect(DFS_KEYWORDS.adTrafficForecast.caveat).toMatch(/impressions.*null/i);
  });

  it("records the 2026-11-01 ETV cutover so it cannot be forgotten", () => {
    expect(ETV_VERSION.improvedDefaultFrom).toBe("2026-11-01");
    expect(ETV_VERSION.caveat).toMatch(/version-stamp/i);
  });

  it("names the vendor's actual parameter", () => {
    // Regression guard. The name circulated in support-chat summaries as
    // `use_improved_etv`, which appears in no DataForSEO documentation page.
    // Sending it is a silent no-op, so nothing but this test would catch it.
    expect(ETV_VERSION.paramName).toBe("use_new_etv");
  });

  it("keeps the new-model and historical endpoint lists disjoint", () => {
    // DataForSEO excludes historical endpoints from the new model. Listing an
    // endpoint in both is how a stored historical value would get stamped `new`.
    for (const endpoint of ETV_VERSION.historicalEndpointsExcluded) {
      expect(ETV_VERSION.endpointsWithNewEtv).not.toContain(endpoint);
    }
  });

  it("agrees with the module that decides, endpoint for endpoint", () => {
    /**
     * **The check that was missing, and its absence is why the two lists disagreed for
     * as long as they existed.**
     *
     * ```
     * ETV_BEARING_LABS_ENDPOINTS     8 endpoints   ← what resolveEtvMode reads
     * ETV_VERSION.endpointsWithNewEtv  9 endpoints   ← 9th: categories_for_domain
     * ```
     *
     * Nothing failed, because the existing test asked whether the two lists in *this
     * object* were disjoint — which they were — and never whether *this object* and the
     * module named one entry earlier as the place the logic lives, agreed with each other.
     *
     * **The failure mode this had:** a maintainer reading the price book concludes nine
     * endpoints need stamping, finds eight in the module that does the stamping, and has
     * no way to tell which governs. **On the item with a 2026-11-01 deadline attached.**
     *
     * `endpointsWithNewEtv` is now a reference rather than a second literal, so this
     * cannot drift — **and the test is here so that if someone reintroduces a literal,
     * this is what says no.**
     */
    expect(ETV_VERSION.endpointsWithNewEtv).toEqual(ETV_BEARING_LABS_ENDPOINTS);

    // **And the count, pinned.** A disagreement of one endpoint is invisible to a
    // `toContain` check and obvious to a length, so both are asserted — the identity
    // above says they are the same list, and this says what that list is.
    expect(ETV_VERSION.endpointsWithNewEtv).toHaveLength(8);
    expect(ETV_VERSION.endpointsWithNewEtv).toContain("domain_rank_overview");
    expect(ETV_VERSION.endpointsWithNewEtv).not.toContain(
      "categories_for_domain",
    );
  });

  it("records that accounts registered after 2026-09-01 default to the new model", () => {
    // A new account has no legacy baseline, which changes what we can claim in
    // the UI about a before/after comparison.
    expect(ETV_VERSION.newDefaultFromRegistration).toBe("2026-09-01");
  });

  it("records that estimated_paid_traffic_cost moves with the change", () => {
    // It derives from organic ETV, so code reading it is affected even though
    // it never touches an `etv` field.
    expect(ETV_VERSION.alsoAffectsFields).toContain(
      "estimated_paid_traffic_cost",
    );
  });
});

describe("cost estimator", () => {
  it("adds request and row cost", () => {
    const e = estimateCost({
      price: DFS_AI_OPTIMIZATION.llmMentions,
      requests: 1,
      units: 1000,
    });
    expect(e.requestCostUsd).toBeCloseTo(0.1, 6);
    expect(e.unitCostUsd).toBeCloseTo(1.0, 6);
    expect(e.totalUsd).toBeCloseTo(1.1, 6);
  });

  it("returns to the published $1.10 for 1,000 rows", () => {
    expect(
      estimateCost({ price: DFS_AI_OPTIMIZATION.llmMentions, units: 1000 })
        .totalUsd,
    ).toBe(1.1);
  });

  it("applies the clickstream multiplier to the request only", () => {
    const plain = estimateCost({
      price: DFS_LABS.standard,
      requests: 1,
      units: 100,
    });
    const boosted = estimateCost({
      price: DFS_LABS.standard,
      requests: 1,
      units: 100,
      requestMultiplier: DFS_LABS.clickstreamMultiplier,
    });
    expect(boosted.requestCostUsd).toBeCloseTo(plain.requestCostUsd * 2, 6);
    expect(boosted.unitCostUsd).toBe(plain.unitCostUsd);
  });

  it("models a brand monitored daily at $3.30/month", () => {
    // 1 brand x 30 days x ($0.10 request + 10 rows x $0.001) = $3.30.
    // The row charge is real and easy to forget; the test pins it.
    const e = estimateDailyBrandMonitoring({ brands: 1, days: 30 });
    expect(e.totalUsd).toBeCloseTo(3.3, 6);
  });

  it("costs only the request fee when no rows are returned", () => {
    const e = estimateDailyBrandMonitoring({
      brands: 1,
      days: 30,
      rowsPerBrand: 0,
    });
    expect(e.totalUsd).toBeCloseTo(3.0, 6);
  });

  it("scales linearly with brand count", () => {
    const five = estimateDailyBrandMonitoring({ brands: 5, days: 30 });
    const one = estimateDailyBrandMonitoring({ brands: 1, days: 30 });
    expect(five.totalUsd).toBeCloseTo(one.totalUsd * 5, 6);
  });

  it("prices a crawler patrol on the Standard queue", () => {
    const e = estimateCost({
      price: DFS_AI_OPTIMIZATION.llmScraper.standard,
      requests: 25,
    });
    expect(e.totalUsd).toBeCloseTo(0.03, 6);
  });
});

describe("crawl tier bundling", () => {
  /**
   * The vendor sells OnPage tiers as **bundles**, priced by DataForSEO on
   * 2026-10-04 as `Basic + N x Base`:
   *
   * - Load resources — "All in Basic + resources" → 3x
   * - Load JavaScript — "All in Basic + JavaScript" → 10x
   * - Browser rendering — "All in Basic + resources + JS + rendering" → 34x
   *
   * The old estimator multiplied the multipliers, so a combination cost more than
   * any single tier: a 50-page crawl with all three flags was quoted at **$7.65
   * instead of $0.26**. **Options that cost more together than the most expensive
   * one alone is not a pricing model, it is a multiplication bug** — and only
   * asking that question finds it.
   */
  it("prices each tier at exactly the vendor's multiple of Basic", () => {
    expect(estimateCrawl({ pages: 1 }).requestCostUsd).toBeCloseTo(0.00015, 6);
    expect(
      estimateCrawl({ pages: 1, loadResources: true }).requestCostUsd,
    ).toBeCloseTo(0.00045, 6);
    expect(
      estimateCrawl({ pages: 1, loadJavaScript: true }).requestCostUsd,
    ).toBeCloseTo(0.0015, 6);
    expect(
      estimateCrawl({ pages: 1, browserRendering: true }).requestCostUsd,
    ).toBeCloseTo(0.0051, 6);
    expect(
      estimateCrawl({ pages: 1, keywordDensity: true }).requestCostUsd,
    ).toBeCloseTo(0.0003, 6);
  });

  it("does not stack loadJavaScript on loadResources — the vendor bundles them", () => {
    // Load JavaScript is "All in Basic + JS", so loading resources too adds
    // nothing. Stacked, it came to 30x and charged for work the vendor does not
    // bill twice.
    const combined = estimateCrawl({
      pages: 1,
      loadResources: true,
      loadJavaScript: true,
    });
    expect(combined.requestCostUsd).toBeCloseTo(0.0015, 6);
  });

  it("caps every combination at the highest tier requested", () => {
    // **The property that makes this a pricing model rather than arithmetic:** no
    // combination of flags may cost more than the most expensive single tier,
    // because each tier already contains the ones below it.
    const tiers = [
      { loadResources: true },
      { loadJavaScript: true },
      { browserRendering: true },
      { keywordDensity: true },
    ];
    const single = tiers.map(
      (tier) => estimateCrawl({ pages: 1, ...tier }).requestCostUsd,
    );
    const mostExpensive = Math.max(...single);

    for (const a of tiers) {
      for (const b of tiers) {
        const both = estimateCrawl({ pages: 1, ...a, ...b }).requestCostUsd;
        expect(both).toBeLessThanOrEqual(mostExpensive + 1e-9);
      }
    }
    const everything = estimateCrawl({
      pages: 1,
      loadResources: true,
      loadJavaScript: true,
      browserRendering: true,
      keywordDensity: true,
    });
    expect(everything.requestCostUsd).toBeCloseTo(0.0051, 6);
  });

  it("prices a real crawl at the vendor's number, not a multiple of it", () => {
    // The regression in the shape a customer would meet it.
    const crawl = estimateCrawl({
      pages: 50,
      loadResources: true,
      loadJavaScript: true,
      browserRendering: true,
    });
    expect(crawl.requestCostUsd).toBeCloseTo(50 * 0.0051, 6);
  });

  it("says why combining flags does not add their costs", () => {
    // The caveat is the user-facing half of the fix: without it, a customer
    // reading "load resources and JavaScript" cannot tell why the number matches
    // the JavaScript tier alone.
    const combined = estimateCrawl({
      pages: 1,
      loadResources: true,
      loadJavaScript: true,
    });
    expect(combined.caveats.join(" ")).toMatch(
      /already includes resource loading/i,
    );

    const rendering = estimateCrawl({ pages: 1, browserRendering: true });
    expect(rendering.caveats.join(" ")).toMatch(/one bundle/i);
  });

  it("still adds Lighthouse separately, because it is a separate product", () => {
    // Lighthouse is not an OnPage tier — it is its own API — so it keeps adding.
    const withLighthouse = estimateCrawl({
      pages: 10,
      loadJavaScript: true,
      lighthousePages: 10,
    });
    expect(withLighthouse.totalUsd).toBeCloseTo(10 * 0.0015 + 10 * 0.005, 6);
    expect(withLighthouse.lines).toHaveLength(2);
  });
});

describe("crawl estimator", () => {
  it("prices a basic crawl at the base page rate", () => {
    const e = estimateCrawl({ pages: 100 });
    expect(e.totalUsd).toBeCloseTo(DFS_ONPAGE.basePage * 100, 8);
  });

  it("charges 34x for browser rendering and says so", () => {
    const e = estimateCrawl({ pages: 10, browserRendering: true });
    expect(e.totalUsd).toBeCloseTo(DFS_ONPAGE.basePage * 34 * 10, 8);
    expect(e.caveats[0]).toMatch(/34×/);
  });

  it("adds Lighthouse as a separate line item", () => {
    const e = estimateCrawl({ pages: 100, lighthousePages: 20 });
    expect(e.unitCostUsd).toBeCloseTo(DFS_ONPAGE.lighthouse * 20, 6);
  });
});

// The remaining price-book families are pinned here so no figure can drift
// silently, and so the exports are exercised rather than merely declared.
describe("remaining price families", () => {
  it("prices backlinks and content analysis identically", () => {
    expect(DFS_ROWS.backlinks.perRequest).toBe(0.024);
    expect(DFS_ROWS.contentAnalysis.perRequest).toBe(0.024);
    expect(DFS_ROWS.backlinks.perUnit).toBe(0.000036);
  });

  it("prices commerce endpoints per published tier", () => {
    expect(DFS_COMMERCE.amazonAsins.standard).toBe(0.0015);
    expect(DFS_COMMERCE.googleShoppingProducts.standard).toBe(0.001);
  });

  it("prices local/reputation endpoints per published tier", () => {
    expect(DFS_LOCAL.businessListings.perRequest).toBe(0.012);
    expect(DFS_LOCAL.businessListings.perItem).toBe(0.00036);
    expect(DFS_LOCAL.gmbInfo.standard).toBe(0.0015);
  });

  it("prices domain intelligence per published tier", () => {
    expect(DFS_DOMAIN.whois.perRequest).toBe(0.12);
    expect(DFS_DOMAIN.whois.perItem).toBe(0.0012);
  });

  it("prices a scraper patrol on each queue", () => {
    expect(
      estimateScraperPatrol({ prompts: 10, queue: "standard" }).totalUsd,
    ).toBeCloseTo(0.012, 6);
    expect(
      estimateScraperPatrol({ prompts: 10, queue: "priority" }).totalUsd,
    ).toBeCloseTo(0.024, 6);
    expect(
      estimateScraperPatrol({ prompts: 10, queue: "live" }).totalUsd,
    ).toBeCloseTo(0.04, 6);
  });

  it("defaults a patrol to the cheap Standard queue", () => {
    const q: DfsQueue = "standard";
    expect(estimateScraperPatrol({ prompts: 1, queue: q }).totalUsd).toBe(
      estimateScraperPatrol({ prompts: 1 }).totalUsd,
    );
  });

  it("treats a per-unit-only price as zero request cost", () => {
    const perUnitOnly: DfsPrice = { perUnit: 0.00012, unitName: "SERP-month" };
    const input: EstimateInput = { price: perUnitOnly, requests: 3, units: 10 };
    const e = estimateCost(input);
    expect(e.requestCostUsd).toBe(0);
    expect(e.unitCostUsd).toBeCloseTo(0.0012, 6);
  });

  it("exposes a typed estimate so the pricing UI can consume it directly", () => {
    // The slider and the MCP cost-preview tool both render a CostEstimate, so the
    // type is part of the contract rather than an internal detail.
    const e: CostEstimate = estimateCost({
      price: DFS_AI_OPTIMIZATION.llmMentions,
      units: 10,
    });
    expect(e.lines.map((l) => l.label)).toEqual(["1 request", "10 rows"]);
    expect(e.caveats).toHaveLength(1);
  });
});

/**
 * The nightly budgets and caps, pinned like every other figure in this file.
 *
 * **This file's own rule, which the four exports below were breaking:**
 *
 * > The remaining price-book families are pinned here so no figure can drift silently.
 *
 * They moved here from the runners in the last hour, **into a file whose stated purpose is
 * that nothing in it moves unnoticed** — and were added without being pinned. So the
 * convention was broken by the very change that was supposed to follow it.
 *
 * **They are placeholders, and pinning a placeholder is still the point**: a pin makes a
 * change deliberate. `scripts/nightly-budgets.test.ts` asserts the *relationships*
 * between them (what a night can afford, whether the ceiling can bind); this file asserts
 * the *values*, so a reviewer changing one sees it.
 */
describe("nightly budgets and caps", () => {
  it("pins the two shared night budgets and the one per-project outlier", () => {
    expect(NIGHTLY_BUDGET_USD.etv).toBe(5);
    expect(NIGHTLY_BUDGET_USD.aiKeyword).toBe(5);
    // The outlier: AI Mode is **per project**, so dividing it across the night's projects
    // would make the bound depend on how many other customers are watching.
    expect(NIGHTLY_BUDGET_USD.aiMode).toBe(0.1);
  });

  it("pins the per-project nightly caps", () => {
    expect(PER_PROJECT_NIGHTLY_CAP.etvDomains).toBe(25);
    expect(PER_PROJECT_NIGHTLY_CAP.aiKeywords).toBe(25);
  });

  it("pins the sweep limit and the one unit price that has never been verified", () => {
    expect(NIGHTLY_PROJECT_SWEEP_LIMIT).toBe(25);
    // **The only figure here that no live call has confirmed.** It is the keyword
    // capture's ceiling denominator, so a wrong price makes the budget wrong in both
    // directions — and account verification is what would replace it.
    expect(AI_KEYWORD_UNIT_COST_USD).toBe(0.002);
  });
});
