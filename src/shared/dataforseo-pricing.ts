// DataForSEO price book — read off rendered pricing pages, never recalled.
// Source of truth: OPENGEO_MASTER_REFERENCE.md §A.1 (Addendum A).
//
// Prices are USD per request ("task") plus, where the vendor bills per row/item,
// a per-unit rate. Queues: Standard < Priority < Live.
//
// ## What has been re-read, and when
//
// A blanket "verified on <date>" is a claim about rows nobody checked, so this
// names what was actually looked at:
//
//   - **AI Optimization** (LLM Mentions, AI Keyword Search Volume) — 2026-10-04.
//     The AI Keyword page publishes its own arithmetic — `1,000*0.01 +
//     1,000,000*0.0001 = $110` — which settles the model this file assumes:
//     **the request fee and the per-item fee both apply**. The LLM Mentions
//     caveat's "$1.10 for 1,000 rows" was checked against that rule rather than
//     against the page's own calculator widget, which shows a different row
//     count and reads as a contradiction.
//   - **OnPage** (every tier, Lighthouse, content parsing) — 2026-10-04. The
//     tiers are **bundles**: `enable_browser_rendering` "must be set with
//     `enable_javascript` and `load_resources`" and is priced
//     `Basic + 33 x Base`, so it replaces the two individual add-ons, while
//     `calculate_keyword_density` is an independent add-on that stacks. `Basic`
//     is a shared component, not a per-option charge.
//   - **Everything else** — as at the original pass on 2026-09-28. Not re-checked
//     since; treat those rows as the least-verified part of this file rather than
//     as covered by the two dates above.
//
// This file is deliberately data, not logic: the estimator below is trivial, but
// the numbers are the product. Changing one of these values changes what the
// pricing slider promises a user, so treat edits as pricing changes and re-verify
// against the vendor's pricing page before shipping.
//
// **Reading the page beats reasoning about it.** The 1,020x crawl-multiplier bug
// and the `Math.max` fix that replaced it were both settled by re-reading what
// DataForSEO prints, not by working it out from the tier names.

import { ETV_BEARING_LABS_ENDPOINTS } from "@/shared/etv-versioning";

/** Which DataForSEO queue/priority a call runs on. */
export type DfsQueue = "standard" | "priority" | "live";

export type DfsPrice = {
  /**
   * USD per request/task. Optional because a few endpoints bill purely per unit
   * with no task fee — `historical_serps` is the one we rely on.
   */
  perRequest?: number;
  /** USD per returned row/item, where the vendor bills per unit. */
  perUnit?: number;
  /** Human unit name for the per-unit rate ("row", "keyword", "page"). */
  unitName?: string;
  /** Notes that change how a caller must compute cost. */
  caveat?: string;
};

const money = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// AI Optimization — the GEO engine
// ---------------------------------------------------------------------------
export const DFS_AI_OPTIMIZATION = {
  /**
   * LLM Mentions (all endpoints, Standard and Lite alike).
   * Lite is the SAME price as Standard — it changes the response shape (flat
   * rows, no `aggregated_metrics`), not the cost. Do not use Lite to save money.
   */
  llmMentions: {
    perRequest: money(0.1),
    perUnit: money(0.001),
    unitName: "row",
    caveat:
      // **No monthly minimum.** DataForSEO removed the $100/month commitment on
      // LLM Mentions and Backlinks on 2026-07-01; both are pay-as-you-go now.
      //
      // The old caveat asserted the opposite, which would have had a self-hoster
      // believe they needed a $100 top-up to use the GEO engine at all — and **a
      // price book's most expensive misstatement is one about whether it is usable.**
      "Pay-as-you-go: the $100/month minimum was removed 2026-07-01. Lite " +
      "endpoints cost the SAME as Standard — they change the response shape " +
      "(flat rows, no aggregated_metrics), not the price. Each 'row' is one " +
      "mention/domain record. 1,000 rows = $1.10, and a brand checked daily " +
      "for a month = $3.30.",
  } satisfies DfsPrice,

  /**
   * AI Keyword Data — AI search volume + 12-month trend.
   *
   * **Live mode only**, so a caller cannot trade cost for latency or queue it.
   * A request carries at most 1,000 keywords and **the task fee is added**, not
   * amortised by filling the batch — `estimateAiKeywordBatch` does that sum.
   */
  aiKeywordSearchVolume: {
    perRequest: money(0.01),
    perUnit: money(0.0001),
    unitName: "keyword",
    caveat:
      "Live mode only. Pay-as-you-go; a $50 minimum initial top-up, and credits " +
      "do not expire.",
  } satisfies DfsPrice,

  /** LLM Responses — generation, charged on top of the provider's own bill. */
  llmResponses: {
    live: {
      perRequest: money(0.0006),
      caveat:
        "Plus the LLM provider's own token cost. Not a flat price — the base " +
        "fee is $0.0006, the rest depends on model, tokens and web search.",
    },
    standard: {
      perRequest: money(0.0002),
      caveat:
        "Plus a $0.01 automatic prepayment covering the provider cost; unused " +
        "prepayment is refunded.",
    },
  },

  /** LLM Scraper — authentic ChatGPT Search / Gemini answers. 4-25x cheaper
   *  than driving the raw LLM APIs, which is why patrols use it. */
  llmScraper: {
    standard: { perRequest: money(0.0012) } satisfies DfsPrice,
    priority: { perRequest: money(0.0024) } satisfies DfsPrice,
    live: { perRequest: money(0.004) } satisfies DfsPrice,
    unitName: "results page",
  },
} as const;

/**
 * The price of one GEO answer, from this price book rather than a literal at the
 * call site.
 *
 * A patrol's spend cap is only a cap while it tracks the real price. A caller that
 * hard-codes `$0.0012` is correct until the vendor moves, and then the cap silently
 * stops being one — with nothing in any log, because the arithmetic is unchanged
 * and its input is a constant nobody reviews.
 *
 * So the price is read from the same table the pricing slider reads, and the two
 * cannot disagree. This is the whole argument for keeping prices as data.
 */
export function geoAnswerUnitCostUsd(queue: DfsQueue = "standard"): number {
  return DFS_AI_OPTIMIZATION.llmScraper[queue].perRequest ?? 0;
}

// ---------------------------------------------------------------------------
// SERP
// ---------------------------------------------------------------------------
export const DFS_SERP = {
  /** Google Organic and the standard verticals (Images, Maps, Local Finder,
   *  News, Events, Jobs, Datasets, Ads, Finance, YouTube, Bing/Yahoo/Baidu/
   *  Naver/Seznam). One page = 10 results; billed per 10 results of depth. */
  standardPage: { perRequest: money(0.0006) } satisfies DfsPrice,
  priorityPage: { perRequest: money(0.0012) } satisfies DfsPrice,
  livePage: { perRequest: money(0.002) } satisfies DfsPrice,

  /** Google AI Mode — double the base price. */
  aiMode: {
    standardPage: { perRequest: money(0.0012) } satisfies DfsPrice,
    priorityPage: { perRequest: money(0.0024) } satisfies DfsPrice,
    livePage: { perRequest: money(0.004) } satisfies DfsPrice,
  },

  /** Extra SERP elements on News (answer box, knowledge graph, …). */
  newsExtraElements: {
    standard: { perRequest: money(0.00465) } satisfies DfsPrice,
    priority: { perRequest: money(0.0093) } satisfies DfsPrice,
    live: { perRequest: money(0.0155) } satisfies DfsPrice,
  },

  /** "Ask the SERP anything" — a summary generated against a stored task. */
  aiSummary: { perRequest: money(0.01) } satisfies DfsPrice,
} as const;

// ---------------------------------------------------------------------------
// Keyword data
// ---------------------------------------------------------------------------
export const DFS_KEYWORDS = {
  /** Google Ads — flat per task, up to 1,000 keywords included. The cheapest
   *  bulk volume source in the platform; never route 1,000 keywords via Bing. */
  googleAds: {
    standard: { perRequest: money(0.06) } satisfies DfsPrice,
    live: { perRequest: money(0.09) } satisfies DfsPrice,
    caveat: "Flat per task, up to 1,000 keywords. $60 per 1M keywords.",
  },
  /** Bing Ads — same price, smaller batch. */
  bingAds: {
    standard: { perRequest: money(0.06) } satisfies DfsPrice,
    live: { perRequest: money(0.09) } satisfies DfsPrice,
    caveat:
      "200 keywords per task for `keywords_for_keywords` — hence $300 per 1M. Bing `search_volume` takes 1,000, so 200 is one endpoint's number; the conservative reading stands, and nothing here routes to Bing.",
  },
  /** Google Ads ad traffic forecast. NOTE: `impressions` and `ctr` come back
   *  null (deprecated upstream) — only clicks/average_cpc/cost are usable. */
  adTrafficForecast: {
    standard: { perRequest: money(0.06) } satisfies DfsPrice,
    live: { perRequest: money(0.09) } satisfies DfsPrice,
    caveat:
      "Future click/cost estimate. `impressions` and `ctr` are deprecated and " +
      "always null.",
  },
  googleTrends: {
    standard: { perRequest: money(0.0027) } satisfies DfsPrice,
    live: { perRequest: money(0.011) } satisfies DfsPrice,
    caveat: "Up to 5 keywords per request.",
  },
  dfsTrends: {
    explore: { perRequest: money(0.0012) } satisfies DfsPrice,
    subregionOrDemography: { perRequest: money(0.0024) } satisfies DfsPrice,
    mergedData: { perRequest: money(0.006) } satisfies DfsPrice,
    caveat: "Up to 5 keywords per request.",
  },
  clickstream: {
    bulk: {
      perRequest: money(0.012),
      perUnit: money(0.00012),
      unitName: "keyword",
    } satisfies DfsPrice,
    /** Sampling/arbitration endpoints — expensive per call, use on a sample. */
    global: { perRequest: money(0.18) } satisfies DfsPrice,
    dfs: { perRequest: money(0.18) } satisfies DfsPrice,
  },
} as const;

// ---------------------------------------------------------------------------
// Labs (keyword research, competitors, market analysis)
// ---------------------------------------------------------------------------
export const DFS_LABS = {
  /** Most Google Labs endpoints: keyword_suggestions, ranked_keywords,
   *  domain_rank_overview, competitors_domain, serp_competitors, etc. */
  standard: {
    perRequest: money(0.012),
    perUnit: money(0.00012),
    unitName: "item",
    caveat:
      "$132 per 1M items. 1,000 items per request is the FAMILY figure: `keyword_overview` takes 700 (80 chars / 10 words), and the caps live in `@/shared/volume-routing`.",
  } satisfies DfsPrice,
  /** search_intent is tiered the same way but called out separately because it
   *  powers the What-to-Build module. */
  searchIntent: {
    perRequest: money(0.012),
    perUnit: money(0.00012),
    unitName: "keyword",
  } satisfies DfsPrice,
  /** historical_rank_overview — priced per month-of-history returned. */
  historicalRank: {
    perRequest: money(0.12),
    perUnit: money(0.0012),
    unitName: "domain-month",
    caveat:
      "Each item is one month of history, so cost scales with the range " +
      "requested. Historical endpoints are EXCLUDED from the new ETV model, so " +
      "this series stays on the legacy formula — see ETV_VERSION.",
  } satisfies DfsPrice,
  /** historical SERP snapshots — the cheapest historical data available. */
  historicalSerps: {
    perUnit: money(0.00012),
    unitName: "SERP-month",
    caveat: "No task fee; billed per snapshot returned.",
  } satisfies DfsPrice,
  /** historical_bulk_traffic_estimation and domain_metrics_by_categories. */
  heavyHistorical: {
    perRequest: money(0.12),
    perUnit: money(0.0012),
    unitName: "domain",
  } satisfies DfsPrice,
  /** Amazon / App Store / Google Play Labs. */
  vertical: {
    perRequest: money(0.012),
    perUnit: money(0.00012),
    unitName: "item",
  } satisfies DfsPrice,
  /** `include_clickstream_data: true` DOUBLES the request cost. */
  clickstreamMultiplier: 2,
} as const;

// ---------------------------------------------------------------------------
// Backlinks & Content Analysis — identical pricing shape
// ---------------------------------------------------------------------------
export const DFS_ROWS = {
  backlinks: {
    perRequest: money(0.024),
    perUnit: money(0.000036),
    unitName: "row",
    caveat: "1,000 rows = $0.06.",
  } satisfies DfsPrice,
  contentAnalysis: {
    perRequest: money(0.024),
    perUnit: money(0.000036),
    unitName: "citation",
    caveat: "1,000 rows = $0.06.",
  } satisfies DfsPrice,
} as const;

// ---------------------------------------------------------------------------
// On-Page — additive multipliers on the Basic per-page price
// ---------------------------------------------------------------------------
export const DFS_ONPAGE = {
  basePage: money(0.00015),
  /**
   * Total multiplier **for that tier alone**, priced by DataForSEO on
   * 2026-10-04 as `Basic + N x Base`:
   *
   * - Load resources — "All in Basic + images/CSS/scripts" → 1 + 2 = **3**
   * - Load JavaScript — "All in Basic + JS" → 1 + 9 = **10**
   * - Browser rendering — "All in Basic + resources + JS + rendering" → 1 + 33 = **34**
   * - Keyword density — "All in Basic + density" → 1 + 1 = **2**
   *
   * **These are tier totals, not increments to be stacked.** Each already
   * contains the tiers above it, which is why rendering is 34× rather than
   * 2 + 9 + 24 — see `estimateCrawl`, which was multiplying them and so quoted a
   * 50-page crawl at $7.65 instead of $0.26.
   */
  loadResources: 3, // $0.00045/page
  loadJavaScript: 10, // $0.0015/page
  browserRendering: 34, // $0.0051/page — only for Core Web Vitals
  keywordDensity: 2, // $0.0003/page
  instantPages: money(0.00015),
  pageScreenshot: money(0.0048),
  contentParsing: money(0.00015),
  lighthouse: money(0.005),
} as const;

// ---------------------------------------------------------------------------
// Commerce, apps, local, domain intelligence
// ---------------------------------------------------------------------------
export const DFS_COMMERCE = {
  amazonAsins: {
    standard: money(0.0015),
    priority: money(0.003),
    live: money(0.005),
  },
  googleShoppingProducts: { standard: money(0.001), priority: money(0.002) },
  googleShoppingReviews: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "10 reviews",
  },
  appDataInfo: { standard: money(0.0006), priority: money(0.0012) },
  appStoreReviews: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "25 reviews",
  },
  googlePlayReviews: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "150 reviews",
  },
} as const;

export const DFS_LOCAL = {
  businessListings: { perRequest: money(0.012), perItem: money(0.00036) },
  gmbInfo: {
    standard: money(0.0015),
    priority: money(0.003),
    live: money(0.0054),
  },
  googleReviews: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "10 reviews",
  },
  googleExtendedReviews: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "20 reviews",
  },
  googleQA: {
    standard: money(0.00075),
    priority: money(0.0015),
    live: money(0.0025),
  },
  hotels: {
    standard: money(0.0008),
    priority: money(0.0016),
    live: money(0.004),
  },
  trustpilotSearch: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "10 listings",
  },
  trustpilotReviews: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "20 reviews",
  },
  tripadvisorReviews: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "10 reviews",
  },
  tripadvisorSearch: {
    standard: money(0.00075),
    priority: money(0.0015),
    unit: "30 listings",
  },
} as const;

export const DFS_DOMAIN = {
  technologies: { perRequest: money(0.012), perItem: money(0.0012) },
  whois: { perRequest: money(0.12), perItem: money(0.0012), unit: "domain" },
} as const;

// ---------------------------------------------------------------------------
// ETV formula versioning — the 2026-11-01 deadline
//
// The price facts here are verified against the vendor's own announcement page
// (dataforseo.com/update/new-etv-calculation-in-dataforseo-labs-api, fetched
// 2026-09-28). The decision logic lives in `@/shared/etv-versioning`; this block
// is only the schedule, so there is one place to look for "when does this change".
// ---------------------------------------------------------------------------
export const ETV_VERSION = {
  /**
   * DataForSEO announced a new ETV model (layout-aware CTR for AI
   * Overviews / shopping / snippets, intent-aware, clickstream-normalised),
   * defaulting on 2026-11-01.
   */
  improvedDefaultFrom: "2026-11-01",
  /**
   * Accounts registered on or after this date already default to the new model,
   * so they get no transition window and have no legacy baseline to compare
   * against.
   */
  newDefaultFromRegistration: "2026-09-01",
  /**
   * The vendor's parameter is `use_new_etv`.
   *
   * It is NOT `use_improved_etv` — that name circulates in support-chat
   * summaries and appears in no documentation page. Sending it is a silent
   * no-op, not an error, so the mistake would not have been caught by a test.
   */
  paramName: "use_new_etv",
  /**
   * Endpoints the vendor states carry the new ETV. Historical-returning
   * endpoints are explicitly EXCLUDED, so a historical series stays legacy and
   * cannot be restated.
   */
  historicalEndpointsExcluded: [
    "historical_rank_overview",
    "historical_bulk_traffic_estimation",
  ],
  /**
   * `estimated_paid_traffic_cost` derives from organic ETV and paid CPC, so it
   * moves with the change even though it is not an `etv` field.
   */
  alsoAffectsFields: ["estimated_paid_traffic_cost"],
  /**
   * Endpoints that carry the NEW ETV, **derived from the module that acts on it** rather
   * than restated here.
   *
   * ## Why this is a reference and not a list
   *
   * This file once declared nine endpoints; `etv-versioning.ts` declares eight. **The
   * difference was `categories_for_domain`, which appears nowhere else in `src`** — not
   * in `labs.ts`, not in the versioning module, not in a test. So this was a second copy
   * of a fact that could not track the first, on the item with a **2026-11-01 deadline**
   * attached: a maintainer reading this list would conclude nine endpoints need stamping,
   * find eight in the module that does the stamping, and have no way to tell which governs.
   *
   * **The module's list is authoritative** and always was — its docstring states the
   * criterion (*"the Labs endpoints that carry an `etv` field"*), and
   * `resolveEtvMode` keys off it. So this points there.
   *
   * `categories_for_domain` is **not dropped silently**: it is a real vendor endpoint that
   * may well accept the flag, and it is recorded on `DFS_LABS` where its *price* lives.
   * `[V 2026-10-06]` **That comment used to end "with a note that we do not call it", and as
   * of CL-406 we do** — `labsCategories.ts` calls this endpoint. So the distinction stops
   * being catalogue trivia and becomes a live gap: **the endpoint returns `etv` and is not on
   * the versioned list, so the category ETVs we now store carry no formula version**, and the
   * vendor switches models on 2026-11-01. Verifying whether it accepts `use_new_etv` is
   * CL-712a's work rather than a guess to make here, which is exactly why that row exists.
   * **The distinction that matters** is between a catalogue
   * fact and a statement about what this product does, and this file mixes both.
   */
  endpointsWithNewEtv: ETV_BEARING_LABS_ENDPOINTS,
  caveat:
    "No backfill is documented, and historical endpoints are excluded from the " +
    "new model, so a historical series stays legacy and cannot be restated. " +
    "Values computed under the two formulas may not be directly comparable, and " +
    "a series can show a discontinuity at the cutover even when rankings did not " +
    "change. We therefore version-stamp every stored ETV value and never trend " +
    "across the boundary unlabelled.",
} as const;

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

export type EstimateInput = {
  price: DfsPrice;
  /** Number of requests/tasks. Usually 1. */
  requests?: number;
  /** Rows / keywords / pages / items returned, when the price bills per unit. */
  units?: number;
  /** Multiply the request cost (e.g. Labs `include_clickstream_data`). */
  requestMultiplier?: number;
};

export type CostEstimate = {
  requestCostUsd: number;
  unitCostUsd: number;
  totalUsd: number;
  /** Human-readable breakdown for the pricing UI. */
  lines: { label: string; usd: number }[];
  caveats: string[];
};

/** Compute a cost from a price entry. Pure, deterministic, no I/O. */
export function estimateCost(input: EstimateInput): CostEstimate {
  const requests = input.requests ?? 1;
  const units = input.units ?? 0;
  const mult = input.requestMultiplier ?? 1;
  const perRequest = input.price.perRequest ?? 0;
  const requestCostUsd = perRequest * requests * mult;
  const unitCostUsd = (input.price.perUnit ?? 0) * units;
  const unitName = input.price.unitName ?? "item";

  const lines = [
    {
      label: `${requests} request${requests === 1 ? "" : "s"}`,
      usd: round(requestCostUsd),
    },
  ];
  if (units > 0) {
    lines.push({
      label: `${units} ${unitName}${units === 1 ? "" : "s"}`,
      usd: round(unitCostUsd),
    });
  }
  if (mult !== 1) {
    lines.push({
      label: `× ${mult} (clickstream data)`,
      usd: round(requestCostUsd * (1 - 1 / mult)),
    });
  }

  return {
    requestCostUsd: round(requestCostUsd),
    unitCostUsd: round(unitCostUsd),
    totalUsd: round(requestCostUsd + unitCostUsd),
    lines,
    caveats: input.price.caveat ? [input.price.caveat] : [],
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Cost of monitoring `brands` brands once per day for `days`.
 * The headline number behind the pricing slider and the Base-tier viability.
 */
export function estimateDailyBrandMonitoring(input: {
  brands: number;
  days: number;
  /** Rows returned per brand per check (top-mentioned domains, etc.). */
  rowsPerBrand?: number;
}): CostEstimate {
  const rows = input.rowsPerBrand ?? 10;
  return estimateCost({
    price: DFS_AI_OPTIMIZATION.llmMentions,
    requests: input.brands * input.days,
    units: input.brands * input.days * rows,
  });
}

/** Cost of an LLM Scraper patrol: one page per prompt, on the given queue. */
export function estimateScraperPatrol(input: {
  prompts: number;
  queue?: DfsQueue;
}): CostEstimate {
  const queue = input.queue ?? "standard";
  return estimateCost({
    price:
      queue === "live"
        ? DFS_AI_OPTIMIZATION.llmScraper.live
        : queue === "priority"
          ? DFS_AI_OPTIMIZATION.llmScraper.priority
          : DFS_AI_OPTIMIZATION.llmScraper.standard,
    requests: input.prompts,
  });
}

/** Cost of an On-Page crawl, honouring the additive pricing multipliers. */
export function estimateCrawl(input: {
  pages: number;
  loadResources?: boolean;
  loadJavaScript?: boolean;
  browserRendering?: boolean;
  keywordDensity?: boolean;
  lighthousePages?: number;
}): CostEstimate {
  // **Two rules, not one** — and the first version of this fix had one rule
  // (`Math.max`) and was wrong, which is the harder mistake to see.
  //
  // 1. **Browser rendering is a bundle.** DataForSEO's `enable_browser_rendering`
  //    documentation says it *"must be set with `enable_javascript` and
  //    `load_resources`"*, and the price page prices it as `Basic + 33×Base`. So it
  //    **replaces** the two individual add-ons rather than adding to them.
  // 2. **Everything else is an independent add-on.** Keyword density is its own
  //    `Basic + 1×Base` and stacks with whatever else is on, which is why the
  //    all-four total is `0.00015 + 33×0.00015 + 1×0.00015 = $0.00525`.
  //
  // The original code multiplied, which reached 1,020x — **$0.153 per page where
  // the real cost is $0.0051**, quoting a 50-page crawl at $7.65 instead of $0.26.
  // `Math.max` fixed that and quietly dropped the keyword-density charge
  // whenever it was combined with anything, which CodeRabbit caught.
  // **In Base units, counting Basic exactly once.** Each option's published
  // formula already contains Basic, so summing the multipliers counts Basic once
  // per option. Adding the *increments* is the only form that is right:
  // resources contributes 2 (not 3), JavaScript 9 (not 10), density 1 (not 2).
  //
  // An earlier version subtracted 1 per option from the multipliers, which
  // removed the duplicated Basic but also removed the vendor's own Basic from
  // the total — pricing resources + JavaScript at $0.00165 instead of $0.00195.
  const baseUnits = input.browserRendering
    ? // The bundle **replaces** resources and JavaScript: the vendor requires both
      // alongside it and prices all three as 34 units, not 34 on top of them.
      DFS_ONPAGE.browserRendering
    : 1 +
      (input.loadResources ? DFS_ONPAGE.loadResources - 1 : 0) +
      (input.loadJavaScript ? DFS_ONPAGE.loadJavaScript - 1 : 0);
  const perPage = round(
    DFS_ONPAGE.basePage *
      (baseUnits + (input.keywordDensity ? DFS_ONPAGE.keywordDensity - 1 : 0)),
  );

  const crawl = round(perPage * input.pages);
  const lighthouse = round(
    DFS_ONPAGE.lighthouse * (input.lighthousePages ?? 0),
  );
  const lines = [{ label: `crawl ${input.pages} pages`, usd: crawl }];
  if (input.lighthousePages)
    lines.push({
      label: `Lighthouse ${input.lighthousePages} pages`,
      usd: lighthouse,
    });
  return {
    requestCostUsd: crawl,
    unitCostUsd: lighthouse,
    totalUsd: round(crawl + lighthouse),
    lines,
    caveats: input.browserRendering
      ? [
          "Browser rendering is 34× the base page price and already includes resource and JavaScript loading — DataForSEO requires both alongside it and sells it as one bundle, so they are not charged again. Keyword density is a separate add-on and does stack. It is the only mode that yields Core Web Vitals, so it stays an explicit line item.",
        ]
      : input.loadResources && input.loadJavaScript
        ? [
            "Resource loading and JavaScript are separate add-ons at the vendor, so this is priced as both: $0.00045 + $0.0015 per page.",
          ]
        : input.keywordDensity && (input.loadResources || input.loadJavaScript)
          ? [
              "Keyword density is an independent add-on and is charged on top of the load options.",
            ]
          : [],
  };
}

// ---------------------------------------------------------------------------
// Nightly capture budgets — POLICY, kept here rather than in each runner
// ---------------------------------------------------------------------------

/**
 * The AI keyword's **per-keyword** price, USD.
 *
 * ## Verified against the pricing page, 2026-10-04
 *
 * The page publishes its own arithmetic — `1,000*0.01 + 1,000,000*0.0001 = $110`
 * — so the per-item rate is **$0.0001**. The previous `$0.002` was twenty times
 * that, described as deliberately conservative. **Twenty times conservative is not
 * caution; it is a twentieth of the feature.**
 *
 * ## The request fee is separate, and callers must add it
 *
 * A call also pays a **request fee** on top, so a batch of *n* keywords costs
 * `n * this + the request fee` — a full 1,000-keyword batch is
 * **$0.11, not $0.10**. This constant is the right basis only for a
 * *per-keyword* estimate, which is what the MCP tool's credit quote uses
 * ($0.1 credits a keyword). Anything budgeting a **batch** or a **night**
 * must add the request fee, and a batch is dominated by it.
 *
 * Billing reads the task's own `cost`, so this bounds a planner and a dry run
 * and never charges anyone.
 */
export const AI_KEYWORD_UNIT_COST_USD = 0.0001;
