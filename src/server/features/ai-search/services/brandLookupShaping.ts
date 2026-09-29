import { sortBy } from "remeda";
import {
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
  type LlmPlatform,
} from "@/server/lib/dataforseo/shared";
import type {
  LlmAggregatedTotal,
  LlmMentionItem,
  LlmTopPagesItem,
} from "@/server/lib/dataforseoLlmSchemas";
import { safeHostname, safeHttpUrl } from "@/server/features/ai-search/safeUrl";
import { deriveCitedSources } from "@/server/features/ai-search/services/citedSources";
import {
  computeShareOfVoice,
  roundOrNull,
  sumNullable,
  type CrossOutcome,
} from "@/server/features/ai-search/services/shareOfVoice";
import { computeSovMatrix } from "@/server/features/ai-search/services/sovMatrix";
import type { BrandLookupResult } from "@/types/schemas/ai-search";
import type { detectTarget } from "@/shared/targetDetection";
import {
  urlMatchesResearchTarget,
  type ResearchTarget,
} from "@/shared/researchScope";

const TOP_QUERIES_PER_PLATFORM = 25;
const TOP_SOURCES_PER_PLATFORM = 10;
const KEYWORDS_PER_SOURCE = 50;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;
const MAX_QUESTION_LENGTH = 500;
const MAX_BRAND_ENTITY_LENGTH = 200;

export type PlatformBundle = {
  aggregated: LlmAggregatedTotal;
  topPages: LlmTopPagesItem[];
  mentions: LlmMentionItem[];
  /** False when one of the sub-calls failed and fell back to empty data. */
  complete: boolean;
};

export type PlatformOutcome = {
  platform: LlmPlatform;
  status: "success" | "error";
  bundle: PlatformBundle | null;
};

export type ShapeArgs = {
  query: string;
  detected: ReturnType<typeof detectTarget>;
  /** Resolved research target for domain queries; null for brand keywords. */
  researchTarget: ResearchTarget | null;
  platformBundles: PlatformOutcome[];
  crossOutcomes: CrossOutcome[];
  /** Labels of the resolved competitor groups, as sent to cross_aggregated. */
  competitorKeys: string[];
  userLocationCode: number;
  userLanguageCode: string;
};

export function shapeResult(args: ShapeArgs): BrandLookupResult {
  // Post-filter page URLs only for URL scopes; domain/subdomains were already
  // scoped in the provider call, and brand-keyword queries have no target.
  const scope = args.researchTarget?.scope;
  const pageFilter =
    scope === "exact_url" || scope === "subfolder" ? args.researchTarget : null;
  const successfulBundles = args.platformBundles.filter(
    (b): b is PlatformOutcome & { bundle: PlatformBundle } =>
      b.status === "success" && b.bundle !== null,
  );

  const primaryLanguage = args.userLanguageCode.toLowerCase().split(/[-_]/)[0];
  const chatGptLocaleMatches =
    args.userLocationCode === CHATGPT_LOCATION_CODE &&
    primaryLanguage === CHATGPT_LANGUAGE_CODE;

  const perPlatform = args.platformBundles.map((outcome) => {
    if (outcome.status === "error" || !outcome.bundle) {
      return {
        platform: outcome.platform,
        status: "error" as const,
        mentions: null,
        aiSearchVolume: null,
      };
    }
    const platformGroup = outcome.bundle.aggregated.platform?.find(
      (entry) => entry.key === outcome.platform,
    );
    return {
      platform: outcome.platform,
      status: "success" as const,
      mentions: roundOrNull(platformGroup?.mentions),
      aiSearchVolume: roundOrNull(platformGroup?.ai_search_volume),
    };
  });

  const aggregatablePlatforms = perPlatform.filter(
    (p) => chatGptLocaleMatches || p.platform !== "chat_gpt",
  );
  // `mentions` is summable across platforms: a mention is a mention, and the
  // two platforms count the same kind of event.
  const totalMentions = sumNullable(
    aggregatablePlatforms.map((p) => p.mentions),
  );

  // `aiSearchVolume` is **not** summable across platforms, and the difference is
  // not subtle. Google's figure is real search volume; ChatGPT's is
  // People-Also-Ask modelled. We measured 12,621,380 against 63,850 for a single
  // keyword — a ratio of roughly 198×. Adding them yields a number that looks
  // authoritative and means nothing, and the tooltip could not rescue it
  // because a reader has already seen one figure by then.
  //
  // So the combined field is the **ChatGPT** figure only, and it is null when
  // ChatGPT is not in the result. The card's label says "ChatGPT" for exactly
  // this reason; `perPlatform` carries both, side by side, and is what a reader
  // compares.
  const chatGptVolume = aggregatablePlatforms.find(
    (p) => p.platform === "chat_gpt",
  )?.aiSearchVolume;
  const totalAiSearchVolume = chatGptVolume ?? null;

  const topPages = deriveCitedSources(
    successfulBundles.map((bundle) => ({
      platform: bundle.platform,
      topPages: bundle.bundle.topPages,
      mentions: bundle.bundle.mentions,
    })),
    {
      sourcesPerPlatform: TOP_SOURCES_PER_PLATFORM,
      keywordsPerSource: KEYWORDS_PER_SOURCE,
    },
    pageFilter,
  );

  const topQueries = shapeTopQueries(successfulBundles, pageFilter);
  const trendBundles = chatGptLocaleMatches
    ? successfulBundles
    : successfulBundles.filter((b) => b.platform !== "chat_gpt");
  const monthlyVolume = aggregateMonthlyVolume(trendBundles);
  const crossOutcomes = chatGptLocaleMatches
    ? args.crossOutcomes
    : args.crossOutcomes.filter((outcome) => outcome.platform !== "chat_gpt");
  const shareOfVoice = computeShareOfVoice(
    crossOutcomes,
    args.detected.value,
    args.competitorKeys,
  );
  /**
   * The per-platform breakdown behind the rolled-up `shareOfVoice` above.
   *
   * Both are returned because they answer different questions. `shareOfVoice` is
   * the "how am I doing against my rivals" number; the matrix is the "where" —
   * the per-platform cells that the rollup sums away. A brand at 60% entirely on
   * ChatGPT and a brand at 60% split evenly are the same number and different
   * businesses, and only the matrix tells them apart.
   *
   * `attemptedPlatforms` is the union of what the caller *asked for* and what
   * came back, not just the successes — a platform that failed has no successful
   * outcome to infer itself from, and dropping it would tell the reader we have
   * no data on it when in fact we never got to ask.
   */
  const sovMatrix = computeSovMatrix({
    outcomes: crossOutcomes,
    targetValue: args.detected.value,
    competitors: args.competitorKeys,
    attemptedPlatforms: [
      ...new Set([
        ...args.crossOutcomes.map((outcome) => outcome.platform),
        ...(shareOfVoice?.platforms ?? []),
      ]),
    ],
  });

  const hasData =
    (totalMentions ?? 0) > 0 ||
    topPages.length > 0 ||
    topQueries.length > 0 ||
    monthlyVolume.length > 0 ||
    (shareOfVoice?.entries.some((e) => e.mentions != null) ?? false);

  return {
    query: args.query,
    detectedTargetType: args.detected.type,
    resolvedTarget: args.researchTarget?.display ?? args.detected.value,
    scope: args.researchTarget?.scope ?? null,
    aggregatesAreDomainLevel: pageFilter !== null,
    fetchedAt: new Date().toISOString(),
    hasData,
    totalMentions,
    totalAiSearchVolume,
    perPlatform,
    shareOfVoice,
    sovMatrix,
    topPages,
    topQueries,
    monthlyVolume,
  };
}

function shapeTopQueries(
  bundles: Array<PlatformOutcome & { bundle: PlatformBundle }>,
  pageFilter: ResearchTarget | null,
): BrandLookupResult["topQueries"] {
  return sortBy(
    bundles.flatMap((bundle) =>
      sortBy(
        bundle.bundle.mentions
          .filter(
            (item): item is LlmMentionItem & { question: string } =>
              typeof item.question === "string" && item.question.length > 0,
          )
          // Under a URL scope a prompt only counts when the answer actually
          // cited a page in scope — a brand named in the answer text is
          // domain-level evidence we must not attribute to the page.
          .filter(
            (item) =>
              pageFilter === null ||
              (item.sources ?? []).some((source) => {
                const url = safeHttpUrl(source.url);
                return url != null && urlMatchesResearchTarget(url, pageFilter);
              }),
          )
          .map((item) => ({
            question: truncate(item.question, MAX_QUESTION_LENGTH),
            platform: bundle.platform,
            aiSearchVolume: roundOrNull(item.ai_search_volume),
            firstSeenAt: item.first_response_at ?? null,
            lastSeenAt: item.last_response_at ?? null,
            citedSources: shapeQuerySources(item),
            brandsMentioned: (item.brand_entities ?? [])
              .map((entity) => entity.title ?? "")
              .filter((title) => title.length > 0)
              .map((title) => truncate(title, MAX_BRAND_ENTITY_LENGTH))
              .slice(0, 20),
          })),
        [(query) => query.aiSearchVolume ?? 0, "desc"],
      ).slice(0, TOP_QUERIES_PER_PLATFORM),
    ),
    [(query) => query.aiSearchVolume ?? 0, "desc"],
  );
}

function shapeQuerySources(
  item: LlmMentionItem,
): BrandLookupResult["topQueries"][number]["citedSources"] {
  return (item.sources ?? [])
    .map((src) => {
      const safeUrl = safeHttpUrl(src.url);
      if (!safeUrl || safeUrl.length > MAX_URL_LENGTH) return null;
      return {
        url: safeUrl,
        domain: safeHostname(safeUrl),
        title:
          typeof src.title === "string"
            ? truncate(src.title, MAX_TITLE_LENGTH)
            : null,
      };
    })
    .filter((src): src is NonNullable<typeof src> => src !== null)
    .slice(0, 10);
}

function aggregateMonthlyVolume(
  bundles: Array<PlatformOutcome & { bundle: PlatformBundle }>,
): BrandLookupResult["monthlyVolume"] {
  const totals = new Map<string, number>();
  for (const outcome of bundles) {
    for (const mention of outcome.bundle.mentions) {
      for (const monthly of mention.monthly_searches ?? []) {
        if (monthly.search_volume == null) continue;
        const key = `${monthly.year}-${monthly.month}`;
        totals.set(key, (totals.get(key) ?? 0) + monthly.search_volume);
      }
    }
  }

  const entries = Array.from(totals.entries()).map(([key, volume]) => {
    const [yearStr, monthStr] = key.split("-");
    return {
      year: Number(yearStr),
      month: Number(monthStr),
      volume: Math.round(volume),
    };
  });

  return sortBy(
    entries,
    [(entry) => entry.year, "asc"],
    [(entry) => entry.month, "asc"],
  ).slice(-12);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
