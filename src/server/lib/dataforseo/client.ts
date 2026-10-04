import {
  type CreditFeature,
  mapDataforseoPathToCreditFeature,
} from "@/shared/billing-credit-features";
import {
  assertUsageCreditsAvailable,
  getOrCreateOrganizationCustomer,
  trackUsageCreditSpend,
} from "@/server/billing/subscription";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  DataforseoChargedTaskError,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import {
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
} from "@/server/lib/dataforseo/business";
import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from "@/server/lib/dataforseo/backlinks";
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
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from "@/server/lib/dataforseo/google-ads";
import {
  fetchLiveSerp,
  fetchLocalSerp,
  fetchRankCheckSerp,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";
import {
  fetchOnPageContentParsing,
  postOnPageTaskForContentParsing,
} from "@/server/lib/dataforseo/on-page-content-parsing";
import {
  fetchAiSummary,
  postSerpTaskForSummary,
} from "@/server/lib/dataforseo/ai-summary";
import {
  fetchContentAnalysisSummary,
  fetchPhraseTrends,
} from "@/server/lib/dataforseo/content-analysis";
import { fetchSentimentAnalysis } from "@/server/lib/dataforseo/content-analysis-sentiment";
import { fetchContentSearch } from "@/server/lib/dataforseo/content-analysis-search";
import { fetchAiModeAnswer } from "@/server/lib/dataforseo/ai-mode";
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from "@/server/lib/dataforseo/ai";
import { fetchLlmTargetMetrics } from "@/server/lib/dataforseo/ai-mentions";
import { fetchAiKeywordVolume } from "@/server/lib/dataforseo/ai-keywords";
import type { AiKeywordVolumeInput } from "@/server/lib/dataforseo/ai-keywords";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";

export { mapDataforseoPathToCreditFeature };

/**
 * Wraps a section fetcher with billing metering. Each entry on the client is
 * `meter(customer, fetchX, defaultFeature?)`, which returns a function with
 * the fetcher's own input type and resolves to its unwrapped `.data`.
 *
 * `defaultFeature` is the fallback credit feature; a caller can override it per
 * call by passing `creditFeature` in the input (e.g. an MCP tool attributing
 * spend to its own feature). The extra field is ignored by the fetchers, which
 * read named fields rather than spreading the input.
 */
function meter<I, T>(
  customer: BillingCustomerContext,
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  defaultFeature?: CreditFeature,
): (input: I & { creditFeature?: CreditFeature }) => Promise<T> {
  return (input) =>
    meterDataforseoCall(
      customer,
      () => fetcher(input),
      input.creditFeature ?? defaultFeature,
    );
}

export function createDataforseoClient(customer: BillingCustomerContext) {
  return {
    business: {
      businessListings: meter(
        customer,
        fetchBusinessListingsSearch,
        "local_seo",
      ),
      questionsAnswers: meter(customer, fetchQuestionsAnswers, "local_seo"),
      myBusinessInfo: meter(customer, fetchMyBusinessInfo, "local_seo"),
      // task_post is where DataForSEO charges; collection runs unmetered
      // through fetchBusinessDataTaskResult (see index.ts).
      reviewsTaskPost: meter(customer, postGoogleReviewsTask, "local_seo"),
      updatesTaskPost: meter(customer, postMyBusinessUpdatesTask, "local_seo"),
    },
    backlinks: {
      summary: meter(customer, fetchBacklinksSummary),
      rows: meter(customer, fetchBacklinksRows),
      referringDomains: meter(customer, fetchReferringDomains),
      domainPages: meter(customer, fetchDomainPagesSummary),
      history: meter(customer, fetchBacklinksHistory),
    },
    keywords: {
      related: meter(customer, fetchRelatedKeywords),
      suggestions: meter(customer, fetchKeywordSuggestions),
      ideas: meter(customer, fetchKeywordIdeas),
      // Google Ads endpoints for countries Labs doesn't support.
      adsIdeas: meter(customer, fetchAdsKeywordIdeas),
      adsSearchVolume: meter(customer, fetchAdsSearchVolume),
    },
    domain: {
      rankOverview: meter(customer, fetchDomainRankOverview),
      rankedKeywords: meter(customer, fetchRankedKeywords),
      relevantPages: meter(customer, fetchRelevantPages),
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
      ),
      // The same citation data with a time axis. Also `ai_citations`, and for
      // the same reason: it measures citing pages, not prompts.
      contentPhraseTrends: meter(customer, fetchPhraseTrends, "ai_citations"),
      // Two overlapping distributions over the same corpus. `ai_citations`
      // again — citing pages classified by sentiment, still not prompts.
      contentSentiment: meter(customer, fetchSentimentAnalysis, "ai_citations"),
      // The individual citing pages. Same feature: citing pages, not prompts.
      contentSearch: meter(customer, fetchContentSearch, "ai_citations"),
    },
    labs: {
      // Callers (e.g. the keyword-metrics MCP tool) can attribute the spend to
      // their own feature by passing `creditFeature` in the input; defaults to
      // rank_tracking when omitted.
      keywordOverview: meter(customer, fetchKeywordOverview, "rank_tracking"),
      serpCompetitors: meter(customer, fetchSerpCompetitors),
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
      llmResponse: meter(customer, fetchLlmResponse),
      // AI demand for a topic: the "high AI demand, low Google demand" signal.
      keywordVolume: meter(customer, (input: AiKeywordVolumeInput) =>
        fetchAiKeywordVolume(input),
      ),
    },
  } as const;
}

async function meterDataforseoCall<T>(
  customer: BillingCustomerContext,
  execute: () => Promise<DataforseoApiResponse<T>>,
  creditFeature?: CreditFeature,
): Promise<T> {
  const isHostedMode = await isHostedServerAuthMode();

  if (!isHostedMode) {
    const result = await execute();
    return result.data;
  }

  const billingCustomer = await getOrCreateOrganizationCustomer(customer);

  const { monthlyRemaining } = await assertUsageCreditsAvailable(
    billingCustomer.id,
  );

  let result: DataforseoApiResponse<T>;
  try {
    result = await execute();
  } catch (error) {
    if (error instanceof DataforseoChargedTaskError) {
      // A malformed request (DataForSEO "Invalid Field: ...") that DataForSEO
      // did not bill returns no value to the customer, so don't charge — surface
      // it as a non-reportable VALIDATION_ERROR. If DataForSEO still billed us
      // (costUsd > 0), fall through to the normal charge + capture path so the
      // spend stays metered and visible instead of silently eaten.
      if (error.isInvalidField && error.billing.costUsd <= 0) {
        throw new AppError("VALIDATION_ERROR", error.message);
      }
      await trackDataforseoCost({
        customer,
        customerId: billingCustomer.id,
        billing: error.billing,
        monthlyRemaining,
        creditFeature,
      });
    }
    throw error;
  }

  await trackDataforseoCost({
    customer,
    customerId: billingCustomer.id,
    billing: result.billing,
    monthlyRemaining,
    creditFeature,
  });

  return result.data;
}

async function trackDataforseoCost(args: {
  customer: BillingCustomerContext;
  customerId: string;
  billing: DataforseoApiCallCost;
  monthlyRemaining: number;
  creditFeature?: CreditFeature;
}) {
  await trackUsageCreditSpend({
    customer: args.customer,
    customerId: args.customerId,
    creditFeature:
      args.creditFeature ?? mapDataforseoPathToCreditFeature(args.billing.path),
    costUsd: args.billing.costUsd,
    monthlyRemaining: args.monthlyRemaining,
    properties: {
      provider: "dataforseo",
      paths: [args.billing.path.join("/")],
      fromCache: false,
    },
  });
}
