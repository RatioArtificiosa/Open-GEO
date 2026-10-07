import { createServerFn } from "@tanstack/react-start";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { resolveLabsMarketSelector } from "@/server/lib/market";
import { getDomainCategoryProfile } from "@/server/features/market-analysis/CategoryProfileService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { getDomainCategoriesSchema } from "@/types/schemas/market";

/**
 * The app's entry point to a domain's category profile, so the Market Map is a screen rather than
 * something only an agent can see. It goes through the same service the MCP tool uses, so the two
 * cannot disagree about which categories are nameless or what a missing name means.
 */
export const getDomainCategories = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getDomainCategoriesSchema)
  .handler(async ({ data, context }) => {
    const market = resolveLabsMarketSelector({}, context.project);
    const client = createDataforseoClient(context);

    const profile = await getDomainCategoryProfile({
      client,
      target: data.target,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      limit: data.limit ?? 50,
      includeClickstreamData: data.includeClickstreamData,
    });

    return {
      target: profile.target,
      unresolvedCount: profile.unresolvedCount,
      categories: profile.entries.map((entry) => ({
        criterionIds: entry.categoryNames.map(
          (category) => category.criterionId,
        ),
        names: entry.categoryNames.map((category) => category.name),
        organicCount: entry.metrics?.organic?.count ?? null,
        organicEtv: entry.metrics?.organic?.etv ?? null,
        paidCount: entry.metrics?.paid?.count ?? null,
        paidEtv: entry.metrics?.paid?.etv ?? null,
      })),
    };
  });
