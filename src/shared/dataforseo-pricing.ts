// DataForSEO price book — VERIFIED 2026-09-28 from rendered pricing pages.
// Source of truth: OPENGEO_MASTER_REFERENCE.md §A.1 (Addendum A).
//
// Every figure here was read off a live pricing page in a browser, not recalled.
// Prices are USD per request ("task") plus, where the vendor bills per row/item,
// a per-unit rate. Queues: Standard < Priority < Live.
//
// This file is deliberately data, not logic: the estimator below is trivial, but
// the numbers are the product. Changing one of these values changes what the
// pricing slider promises a user, so treat edits as pricing changes and re-verify
// against the vendor's pricing page before shipping.

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
      "$100/month minimum commitment. Lite endpoints cost the SAME as Standard — " +
      "they change the response shape (flat rows, no aggregated_metrics), not " +
      "the price. Each 'row' is one mention/domain record. 1,000 rows = $1.10. " +
      "One brand checked daily for a month with 10 rows returned = $3.30.",
  } satisfies DfsPrice,

  /** AI Keyword Data — AI search volume + 12-month trend. */
  aiKeywordSearchVolume: {
    perRequest: money(0.01),
    perUnit: money(0.0001),
    unitName: "keyword",
    caveat: "1,000 keywords per request. 1M keywords = $110.",
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
  /** Bing Ads — same price, but only 200 keywords per task. */
  bingAds: {
    standard: { perRequest: money(0.06) } satisfies DfsPrice,
    live: { perRequest: money(0.09) } satisfies DfsPrice,
    caveat: "Only 200 keywords per task — hence $300 per 1M.",
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
    caveat: "$132 per 1M items. 1,000 items per request.",
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
  /** Multiplier, not an absolute price: Basic + N x Base. */
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
   * Endpoints the vendor states carry the NEW ETV. The historical ones are
   * deliberately absent: they are in `historicalEndpointsExcluded` instead, and
   * a test asserts the two lists stay disjoint. Listing both is how a caller
   * would end up stamping a historical value `new`.
   */
  endpointsWithNewEtv: [
    "categories_for_domain",
    "ranked_keywords",
    "serp_competitors",
    "competitors_domain",
    "domain_intersection",
    "subdomains",
    "relevant_pages",
    "domain_rank_overview",
    "page_intersection",
  ] as const,
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
  let perPage = DFS_ONPAGE.basePage;
  if (input.loadResources) perPage *= DFS_ONPAGE.loadResources;
  if (input.loadJavaScript) perPage *= DFS_ONPAGE.loadJavaScript;
  if (input.browserRendering) perPage *= DFS_ONPAGE.browserRendering;
  if (input.keywordDensity) perPage *= DFS_ONPAGE.keywordDensity;

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
          "Browser rendering is 34× the base page price — it is the only mode that yields Core Web Vitals, so it stays an explicit line item.",
        ]
      : [],
  };
}
