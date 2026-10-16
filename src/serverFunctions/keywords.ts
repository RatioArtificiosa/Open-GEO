import { createServerFn } from "@tanstack/react-start";
import {
  adTrafficCrossCheckSchema,
  deleteSavedKeywordTagSchema,
  researchKeywordsSchema,
  saveKeywordsSchema,
  getSavedKeywordsSchema,
  exportSavedKeywordsSchema,
  removeSavedKeywordsSchema,
  refreshSavedKeywordMetricsSchema,
  reconcileKeywordVolumesSchema,
  serpAnalysisSchema,
  updateSavedKeywordTagSchema,
  updateSavedKeywordTagsSchema,
} from "@/types/schemas/keywords";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { readAdTrafficForecast } from "@/shared/ad-traffic-forecast-read";
import { USABLE_AD_TRAFFIC_FIELDS } from "@/shared/ad-traffic-fields";
import { reconcileVolumes } from "@/server/features/keywords/services/reconcile-volumes";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { resolveMarket } from "@/shared/keyword-locations";

function shouldUseKeywordE2eFixtures() {
  return import.meta.env.VITE_E2E_KEYWORD_FIXTURES === "1";
}

async function getKeywordE2eFixtures() {
  return import("../../e2e/fixtures/keyword-research-fixtures");
}

export const researchKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(researchKeywordsSchema)
  .handler(async ({ data, context }) => {
    const input = {
      ...data,
      ...resolveMarket(data, context.project),
      projectId: context.projectId,
    };
    if (shouldUseKeywordE2eFixtures()) {
      const fixtures = await getKeywordE2eFixtures();
      return fixtures.getKeywordResearchFixture(input);
    }

    return KeywordResearchService.research(input, context);
  });

export const saveKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(saveKeywordsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.saveKeywords({
      ...data,
      ...resolveMarket(data, context.project),
      projectId: context.projectId,
    });
  });

export const getSavedKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getSavedKeywordsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.getSavedKeywords({
      ...data,
      projectId: context.projectId,
    });
  });

export const exportSavedKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(exportSavedKeywordsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.exportSavedKeywords({
      ...data,
      projectId: context.projectId,
    });
  });

export const updateSavedKeywordTags = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateSavedKeywordTagsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.updateSavedKeywordTags({
      ...data,
      projectId: context.projectId,
    });
  });

export const updateSavedKeywordTag = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateSavedKeywordTagSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.updateSavedKeywordTag({
      ...data,
      projectId: context.projectId,
    });
  });

export const deleteSavedKeywordTag = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(deleteSavedKeywordTagSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.deleteSavedKeywordTag({
      ...data,
      projectId: context.projectId,
    });
  });

export const removeSavedKeywords = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(removeSavedKeywordsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.removeSavedKeywords(context.projectId, data);
  });

export const refreshSavedKeywordMetrics = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(refreshSavedKeywordMetricsSchema)
  .handler(async ({ context }) => {
    return KeywordResearchService.refreshSavedKeywordMetrics(
      { projectId: context.projectId },
      context,
    );
  });

/**
 * The app's own entry point to the volume reconciliation, so the "Data Honesty" panel is
 * not the MCP tool's private privilege. Both go through `reconcileVolumes`, which is where
 * the comparison rule lives.
 */
export const reconcileKeywordVolumes = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(reconcileKeywordVolumesSchema)
  .handler(async ({ data, context }) =>
    reconcileVolumes({
      billing: context,
      keywords: data.keywords,
      locationCode: context.project.locationCode,
      languageCode: context.project.languageCode,
      countryIsoCode: data.countryIsoCode,
    }),
  );

export const getSerpAnalysis = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(serpAnalysisSchema)
  .handler(async ({ data, context }) =>
    KeywordResearchService.getSerpAnalysis(
      {
        ...data,
        ...resolveMarket(data, context.project),
        projectId: context.projectId,
      },
      context,
    ),
  );

/**
 * Ad-traffic cross-check for the page (CL-723 surface).
 *
 * What a Google Ads plan for these keywords is expected to return — clicks,
 * average CPC and cost — beside the organic numbers, never as a forecast of
 * its own. The deprecation guardrail travels in the response: impressions
 * and ctr are refused by name rather than charted as flat lines that never
 * happened.
 */
export const getAdTrafficCrossCheck = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(adTrafficCrossCheckSchema)
  .handler(async ({ data, context }) => {
    const market = resolveMarket(data, context.project);
    const client = createDataforseoClient(context);
    const rows = await client.keywords.adTrafficForecast({
      keywords: data.keywords,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      dateFrom: data.dateFrom,
      dateTo: data.dateTo,
    });
    return readAdTrafficForecast(rows, [...USABLE_AD_TRAFFIC_FIELDS]);
  });
