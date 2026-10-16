import type { BillingCustomerContext } from "@/server/billing/subscription";
import { fetchAdTrafficForecast } from "@/server/lib/dataforseo/adTraffic";
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from "@/server/lib/dataforseo/ai";
import type { AiKeywordVolumeInput } from "@/server/lib/dataforseo/ai-keywords";
import { fetchAiKeywordVolume } from "@/server/lib/dataforseo/ai-keywords";
import {
  fetchLlmNewLost,
  fetchLlmTargetMetrics,
  fetchLlmTopMentioned,
} from "@/server/lib/dataforseo/ai-mentions";
import { fetchAiModeAnswer } from "@/server/lib/dataforseo/ai-mode";
import {
  fetchAiSummary,
  postSerpTaskForSummary,
} from "@/server/lib/dataforseo/ai-summary";
import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from "@/server/lib/dataforseo/backlinks";
import {
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
} from "@/server/lib/dataforseo/business";
import {
  estimateTripadvisorReviews,
  estimateTrustpilotReviews,
} from "@/server/lib/dataforseo/client-estimates";
import {
  postTripadvisorReviewsTask,
  postTrustpilotReviewsTask,
} from "@/server/lib/dataforseo/reviews";
import { fetchClickstreamVolumes } from "@/server/lib/dataforseo/clickstream";
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
import {
  fetchContentAnalysisSummary,
  fetchPhraseTrends,
} from "@/server/lib/dataforseo/content-analysis";
import { fetchContentSearch } from "@/server/lib/dataforseo/content-analysis-search";
import { fetchSentimentAnalysis } from "@/server/lib/dataforseo/content-analysis-sentiment";
import { fetchDataforseoTrendsExplore } from "@/server/lib/dataforseo/dataforseoTrends";
import { fetchDataforseoTrendsDemography } from "@/server/lib/dataforseo/dataforseoTrendsDemography";
import { fetchDataforseoTrendsMergedData } from "@/server/lib/dataforseo/dataforseoTrendsMerged";
import { fetchDataforseoTrendsSubregion } from "@/server/lib/dataforseo/dataforseoTrendsSubregion";
import {
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from "@/server/lib/dataforseo/google-ads";
import { fetchGoogleTrendsExplore } from "@/server/lib/dataforseo/googleTrends";
import {
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
} from "@/server/lib/dataforseo/labs";
import {
  fetchCategoriesForDomain,
  fetchKeywordsForCategories,
} from "@/server/lib/dataforseo/labsCategories";
import { fetchDomainMetricsByCategories } from "@/server/lib/dataforseo/labsDomainMetrics";
import {
  fetchCompetitorsDomain,
  fetchHistoricalRankOverview,
  fetchSubdomains,
  historicalMonthsSpanned,
  standardLabsItemEstimate,
} from "@/server/lib/dataforseo/labsDomainOverview";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";
import { postLlmResponseTasks } from "@/server/lib/dataforseo/llm-responses-queue";
import {
  fetchOnPageContentParsing,
  postOnPageTaskForContentParsing,
} from "@/server/lib/dataforseo/on-page-content-parsing";
import {
  fetchOnPageWaterfall,
  postOnPageCrawlTaskForWaterfall,
} from "@/server/lib/dataforseo/on-page-waterfall";
import { fetchSearchIntent } from "@/server/lib/dataforseo/search-intent";
import {
  fetchLiveSerp,
  fetchLocalSerp,
  fetchRankCheckSerp,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";
import { fetchDomainTechnologies } from "@/server/lib/dataforseo/technologies";
import { fetchWhoisOverview } from "@/server/lib/dataforseo/whois";
import { mapDataforseoPathToCreditFeature } from "@/shared/billing-credit-features";
import {
  DFS_LABS,
  estimateQueuedLlmResponsesPost,
} from "@/shared/dataforseo-pricing";
import { getLlmScraperTask, postLlmScraperTasks } from "./ai-scraper";
import { meter, meterEnvelope } from "./client-meter";

export { mapDataforseoPathToCreditFeature };

export function createDataforseoClient(customer: BillingCustomerContext) {
  return {
    business: {
      // Estimate: per-request fee plus per listing; `limit` is required.
      businessListings: meter(
        customer,
        fetchBusinessListingsSearch,
        "local_seo",
        estimateBusinessListings,
      ),
      questionsAnswers: meter(customer, fetchQuestionsAnswers, "local_seo"),
      myBusinessInfo: meter(customer, fetchMyBusinessInfo, "local_seo"),
      // task_post is where DataForSEO charges; collection runs unmetered
      // through fetchBusinessDataTaskResult (see index.ts).
      reviewsTaskPost: meter(customer, postGoogleReviewsTask, "local_seo"),
      updatesTaskPost: meter(customer, postMyBusinessUpdatesTask, "local_seo"),
      // task_post is where DataForSEO charges (per 20 / per 10 reviews);
      // collection runs unmetered through the reviews readers.
      trustpilotReviewsTaskPost: meter(
        customer,
        postTrustpilotReviewsTask,
        "local_seo",
        estimateTrustpilotReviews,
      ),
      tripadvisorReviewsTaskPost: meter(
        customer,
        postTripadvisorReviewsTask,
        "local_seo",
        estimateTripadvisorReviews,
      ),
    },
    backlinks: {
      summary: meter(customer, fetchBacklinksSummary),
      // Estimates mirror `limit ?? 100` (lists) and the inclusive day range
      // (history); see client-estimates.ts.
      rows: meter(
        customer,
        fetchBacklinksRows,
        undefined,
        estimateBacklinksList,
      ),
      referringDomains: meter(
        customer,
        fetchReferringDomains,
        undefined,
        estimateBacklinksList,
      ),
      domainPages: meter(
        customer,
        fetchDomainPagesSummary,
        undefined,
        estimateBacklinksList,
      ),
      history: meter(
        customer,
        fetchBacklinksHistory,
        undefined,
        estimateBacklinksHistory,
      ),
    },
    keywords: {
      related: meter(customer, fetchRelatedKeywords),
      suggestions: meter(customer, fetchKeywordSuggestions),
      ideas: meter(customer, fetchKeywordIdeas),
      // Google Ads endpoints for countries Labs doesn't support.
      adsIdeas: meter(customer, fetchAdsKeywordIdeas),
      adsSearchVolume: meter(customer, fetchAdsSearchVolume),
      // The ad forecast, and the landmine it carries: `impressions` and `ctr`
      // are deprecated upstream and always null. Metered like its siblings, and
      // read through `readAdTrafficForecast` — which names any deprecated field
      // a caller asked for rather than dropping it silently — so a chart can
      // never be built from an empty axis that reads as flat interest.
      adTrafficForecast: meter(customer, fetchAdTrafficForecast),
      // Clickstream-measured volume: the arbitration source that checks a volume we
      // already show. Metered here rather than called directly, because a call that
      // skips this wrapper is spend nobody attributes — and it is billed **per request**,
      // not per keyword, which is why the reconciliation passes one batch.
      // DataForSEO Trends lives under the keywords-data API, not where its name suggests — and
      // its Google sibling is a different index with a different vocabulary for `type`.
      trendsExplore: meter(customer, fetchDataforseoTrendsExplore),
      googleTrendsExplore: meter(customer, fetchGoogleTrendsExplore),
      trendsDemography: meter(customer, fetchDataforseoTrendsDemography),
      trendsSubregion: meter(customer, fetchDataforseoTrendsSubregion),
      // All three views in one request, so they cannot disagree about the window they describe.
      trendsMerged: meter(customer, fetchDataforseoTrendsMergedData),
      // Estimate: per-request fee plus per keyword sent (validated upstream).
      clickstreamVolumes: meter(
        customer,
        fetchClickstreamVolumes,
        "keyword_research",
        estimateClickstreamVolumes,
      ),
    },
    domain: {
      rankOverview: meter(customer, fetchDomainRankOverview),
      /**
       * The envelope-returning sibling, for the nightly ETV capture.
       *
       * The capture's report carries `actualCostUsd` read from
       * `response.billing.costUsd`, and that is the figure an operator reconciles
       * against the DataForSEO invoice. Routing it through `rankOverview` would
       * strip the billing and report a cost of `undefined` — while the budget
       * still works, because it runs on the price-book estimate. Nothing would
       * fail and the number would quietly stop being true.
       *
       * Same gate, same credit feature, same estimate — only the return type
       * differs, so the two cannot disagree about whether a call is permitted.
       */
      rankOverviewEnvelope: meterEnvelope(customer, fetchDomainRankOverview),
      rankedKeywords: meter(
        customer,
        fetchRankedKeywords,
        undefined,
        estimateRankedKeywords,
      ),
      relevantPages: meter(
        customer,
        fetchRelevantPages,
        undefined,
        estimateRelevantPages,
      ),
      // WHOIS and technologies are both billed at request time, so both are metered. WHOIS is the
      // expensive one (~$0.12) and technologies the cheap one (~$0.012) that carries the contact
      // fields the lead list is built from.
      //
      // WHOIS is the clearest case for an estimate: it is the priciest single read in the platform
      // and the only one whose whole price is a per-request fee with no per-row component, so the
      // number is both large and certain. A wallet holding one credit admitted it without a floor.
      whoisOverview: meter(
        customer,
        fetchWhoisOverview,
        undefined,
        estimateWhois,
      ),
      domainTechnologies: meter(
        customer,
        fetchDomainTechnologies,
        undefined,
        estimateTechnologies,
      ),
      // The three missing domain-overview endpoints (CL-401 remainder),
      // each metered with an estimator that matches its billing shape:
      // historical bills per domain-month over the requested span
      // (single-sided bounds resolve against the request clock); the other
      // two bill per request plus per returned item, quoted at the stated
      // limit or the family ceiling.
      historicalRankOverview: meter(
        customer,
        fetchHistoricalRankOverview,
        undefined,
        (input: { dateFrom?: string; dateTo?: string; now?: Date }) =>
          DFS_LABS.historicalRank.perRequest +
          DFS_LABS.historicalRank.perUnit *
            Math.max(
              historicalMonthsSpanned(
                input.dateFrom,
                input.dateTo,
                // Mirrors the request: fetch defaults an absent date_to to
                // today via its own clock, so the estimator uses the same
                // clock rather than pricing a six-month fiction.
                (input.now ?? new Date()).toISOString().slice(0, 10),
              ),
              1,
            ),
      ),
      subdomains: meter(
        customer,
        fetchSubdomains,
        undefined,
        (input: { limit?: number }) => standardLabsItemEstimate(input.limit),
      ),
      competitorsDomain: meter(
        customer,
        fetchCompetitorsDomain,
        undefined,
        (input: { limit?: number }) => standardLabsItemEstimate(input.limit),
      ),
      // The categories a domain ranks in. Metered with everything else in Labs, and the
      // `includeClickstreamData` flag doubles the vendor's price — a caller's decision, never a
      // default.
      // Estimate: tested helper plus the clickstream request-fee double.
      categoriesForDomain: meter(
        customer,
        fetchCategoriesForDomain,
        undefined,
        estimateCategoryItems,
      ),
      // The drill-down: keywords relevant to a set of categories. `categoryIntersection` is
      // required rather than defaulted, because the vendor's own default (`true`) silently means
      // "keywords in ALL of these categories", which is not what a caller passing several
      // categories usually means.
      keywordsForCategories: meter(
        customer,
        fetchKeywordsForCategories,
        undefined,
        estimateCategoryItems,
      ),
      // The comparison read: who ranks in a set of categories and how their traffic moved between
      // two months. Priced at `heavyHistorical` — about 10× the standard Labs rate, and billed
      // **per returned row**, so the estimate scales with the task rather than being a constant.
      // A wallet with a handful of credits could previously start a read priced at several dollars.
      domainMetricsByCategories: meter(
        customer,
        fetchDomainMetricsByCategories,
        undefined,
        (input) =>
          DFS_LABS.heavyHistorical.perRequest +
          DFS_LABS.heavyHistorical.perUnit * Math.max(input.limit, 1),
      ),
    },
    serp: {
      live: meter(customer, fetchLiveSerp),
      rankCheck: meter(customer, fetchRankCheckSerp, "rank_tracking"),
      // Posts up to 100 queued rank check tasks; one metered charge covers the
      // whole batch (DataForSEO bills task_post at post time, collection is
      // free).
      rankCheckTaskPost: meter(customer, postRankCheckTasks, "rank_tracking"),
      local: meter(customer, fetchLocalSerp, "local_seo"),
      // Google AI Mode: the answer-change monitor (G6). Cites only, no retrieval.
      aiMode: meter(customer, fetchAiModeAnswer, "rank_tracking"),
      /**
       * The envelope-returning sibling, for the nightly AI Mode capture.
       *
       * Same reason as the other two: report.actualCostUsd is read from
       * response.billing.costUsd, and the unwrapping form would charge the org
       * correctly while recording a cost of undefined — which is
       * indistinguishable from a correctly metered capture.
       */
      aiModeEnvelope: meterEnvelope(
        customer,
        fetchAiModeAnswer,
        "rank_tracking",
      ),
      // "Ask the SERP anything". Two billed steps, so both are metered: the
      // SERP post that yields a task id, and the summary asked against it.
      serpTaskForSummary: meter(customer, postSerpTaskForSummary),
      aiSummary: meter(customer, fetchAiSummary),
      // Content Analysis: what the open web says about a keyword. Metered as
      // AI citations — **the same answer `mapDataforseoPathToCreditFeature`
      // gives for this path**, because the meter's `defaultFeature` wins
      // whenever a caller does not pass one, so the two must agree or the
      // mapping fix is bypassed by every call that does not opt out.
      contentSummary: meter(
        customer,
        fetchContentAnalysisSummary,
        "ai_citations",
        estimateContentListings,
      ),
      // The same citation data with a time axis. Also `ai_citations`, and for
      // the same reason: it measures citing pages, not prompts.
      contentPhraseTrends: meter(
        customer,
        fetchPhraseTrends,
        "ai_citations",
        estimatePhraseTrends,
      ),
      // Two overlapping distributions over the same corpus. `ai_citations`
      // again — citing pages classified by sentiment, still not prompts.
      contentSentiment: meter(
        customer,
        fetchSentimentAnalysis,
        "ai_citations",
        estimateContentListings,
      ),
      // The individual citing pages. Same feature: citing pages, not prompts.
      // Estimate folds per-row internal lists into the row count (see above).
      contentSearch: meter(
        customer,
        fetchContentSearch,
        "ai_citations",
        estimateContentSearch,
      ),
    },
    labs: {
      // Callers (e.g. the keyword-metrics MCP tool) can attribute the spend to
      // their own feature by passing `creditFeature` in the input; defaults to
      // rank_tracking when omitted.
      // Estimate: per keyword sent, clickstream doubling the request fee.
      keywordOverview: meter(
        customer,
        fetchKeywordOverview,
        "rank_tracking",
        estimateKeywordOverview,
      ),
      // Estimate: single post, the limit caps items.
      serpCompetitors: meter(
        customer,
        fetchSerpCompetitors,
        undefined,
        estimateSerpCompetitors,
      ),
      // Intent is a property of the keyword rather than of the market, so the
      // endpoint takes neither location nor language; the caller that omits
      // both is doing it right, not being careless.
      // Estimate: per keyword sent (validation dedupes; safe-side overquote).
      searchIntent: meter(
        customer,
        fetchSearchIntent,
        undefined,
        estimateSearchIntent,
      ),
    },
    lighthouse: {
      live: meter(customer, fetchLighthouseResult),
    },
    // OnPage: the two halves of a page parse. **Both metered**, which is the
    // opposite of the `task_get` collectors — a `content_parsing` read carries
    // its own cost and the vendor prices it separately, so calling it free
    // undercharges every audit by an amount the ledger never sees. No
    // `defaultFeature` on either: `mapDataforseoPathToCreditFeature` already
    // sends every `on_page` path to `site_audit`, and a default here would
    // override that for any caller that omits `creditFeature`.
    onPage: {
      taskForContentParsing: meter(customer, postOnPageTaskForContentParsing),
      contentParsing: meter(customer, fetchOnPageContentParsing),
      // The crawl whose pages the waterfall is read for. Metered, because the POST is where
      // the vendor charges and the price depends on the flags the caller set.
      waterfallTask: meter(customer, postOnPageCrawlTaskForWaterfall),
      // **Deliberately unmetered.** The vendor does not charge for the waterfall read — "your
      // account will not be charged for using this function" — so metering it would bill a
      // customer for something nobody was charged for. This is the `task_get` case, not the
      // `content_parsing` one: a free read of a task already paid for at post time.
      waterfall: fetchOnPageWaterfall,
    },
    aiSearch: {
      mentionsSearch: meter(customer, fetchLlmMentionsSearch),
      aggregatedMetrics: meter(customer, fetchLlmAggregatedMetrics),
      // The dimensional breakdown for one target — the only LLM Mentions
      // endpoint that returns the brand-entity buckets (`brand_entities_title`
      // / `brand_entities_category`), so the brand-framing tool reads them
      // here rather than off `aggregated_metrics`'s total, which does not
      // carry them.
      targetMetrics: meter(customer, fetchLlmTargetMetrics),
      topPages: meter(customer, fetchLlmTopPages),
      crossAggregatedMetrics: meter(customer, fetchLlmCrossAggregatedMetrics),
      /**
       * The two GEO live reads, and the third instance of the CL-202 class.
       *
       * `geoLiveReads` called `fetchLlmNewLost` and `fetchLlmTopMentioned`
       * directly, gated only by `customerHasPaidPlan`. A plan-tier gate is not
       * a meter: the vendor charged the platform's own account for every read,
       * no org balance was read, and no credit was deducted — while the panels
       * themselves were being served as a paid feature. `POST /v3/geo` is
       * where those two reads are reached from.
       *
       * Metered here, not merely passed through, because both endpoints bill
       * per request and the customer is told the panels cost credits.
       */
      newLost: meter(customer, fetchLlmNewLost),
      topMentioned: meter(customer, fetchLlmTopMentioned),
      llmResponse: meter(customer, fetchLlmResponse),
      /**
       * The Standard-queue sibling of `llmResponse` — the queued patrol path's POST.
       *
       * **Why it exists is CL-202, and the failure it closed was silent.**
       * `postBatch` imported `postLlmResponseTasks` from the section module
       * directly, so the queued path never went through this client: no
       * `assertUsageCreditsAvailable`, no `trackUsageCreditSpend`, no vendor
       * figure recorded. The platform's vendor account paid for queued captures
       * of orgs whose balance was never read — including zero-credit orgs —
       * while `postBatch` read `response.billing.costUsd` into its budget
       * figure, which is why the run log looked metered.
       *
       * `meterEnvelope`, not `meter`, because `postBatch` reads the receipt:
       * `advanceUsd` is the vendor's own post-time figure and the run log
       * carries it verbatim. Same gate, same credit feature, same estimate as
       * every other entry — only the return type differs.
       *
       * The estimate is per **task**, not per request: the vendor charges the
       * $0.01 prepayment per task at POST time, on top of the per-request fee.
       * A whole batch is therefore floored at the batch's own size.
       */
      llmResponsesTaskPost: meterEnvelope(
        customer,
        postLlmResponseTasks,
        undefined,
        (input) => estimateQueuedLlmResponsesPost(input.tasks.length),
      ),
      // AI demand for a topic: the "high AI demand, low Google demand" signal.
      // Estimate: tested batch helper (task fee plus per-keyword rate).
      keywordVolume: meter(
        customer,
        (input: AiKeywordVolumeInput) => fetchAiKeywordVolume(input),
        undefined,
        estimateAiKeywordVolume,
      ),
      /**
       * The envelope-returning sibling, for the nightly AI keyword capture.
       *
       * Same reason as `rankOverviewEnvelope`: `report.actualCostUsd` is read from
       * `response.billing.costUsd`, and the unwrapping form would charge the org
       * correctly while recording a cost of `undefined` — indistinguishable from a
       * correctly metered capture, from the tests and from the log.
       */
      keywordVolumeEnvelope: meterEnvelope(
        customer,
        (input: AiKeywordVolumeInput) => fetchAiKeywordVolume(input),
        undefined,
        estimateAiKeywordVolume,
      ),
      // LLM Scraper: authentic ChatGPT Search and Gemini answers, scraped rather than
      // generated. The POST is where the vendor charges, so it is metered; the `task_get`
      // collection is not — reading a task already paid for is the `waterfall` case above,
      // not the `content_parsing` one, and metering it would bill a second time for one answer.
      scraperTask: meter(customer, postLlmScraperTasks),
      scraperTaskResult: getLlmScraperTask,
    },
  } as const;
}
