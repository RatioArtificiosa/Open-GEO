import { createServerFn } from "@tanstack/react-start";
import { DomainService } from "@/server/features/domain/services/DomainService";
import { DomainIntel } from "@/server/features/domain/services/domainIntel";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { resolveLabsMarket } from "@/shared/keyword-locations";
import {
  domainCompetitorsSchema,
  domainHistoricalSchema,
  domainKeywordSuggestionsSchema,
  domainKeywordsPageRequestSchema,
  domainOverviewSchema,
  domainPagesPageRequestSchema,
  domainSubdomainsSchema,
} from "@/types/schemas/domain";

function shouldUseDomainE2eFixtures() {
  return import.meta.env.VITE_E2E_DOMAIN_FIXTURES === "1";
}

async function getDomainE2eFixtures() {
  return import("../../e2e/fixtures/domain-overview-fixtures");
}

export const getDomainOverview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainOverviewSchema)
  .handler(async ({ data, context }) => {
    const input = {
      ...data,
      ...resolveLabsMarket(data, context.project),
      projectId: context.projectId,
    };
    if (shouldUseDomainE2eFixtures()) {
      const fixtures = await getDomainE2eFixtures();
      return fixtures.getFixtureOverview(input.domain);
    }

    return DomainService.getOverview(input, context);
  });

export const getDomainKeywordSuggestions = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainKeywordSuggestionsSchema)
  .handler(async ({ data, context }) =>
    DomainService.getSuggestedKeywords(
      {
        ...data,
        ...resolveLabsMarket(data, context.project),
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
      context,
    ),
  );

export const getDomainKeywordsPage = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainKeywordsPageRequestSchema)
  .handler(async ({ data, context }) => {
    const input = {
      ...data,
      ...resolveLabsMarket(data, context.project),
      projectId: context.projectId,
    };
    if (shouldUseDomainE2eFixtures()) {
      const fixtures = await getDomainE2eFixtures();
      return fixtures.getFixtureKeywordsPage(input);
    }

    return DomainService.getKeywordsPage(input, context);
  });

export const getDomainPagesPage = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainPagesPageRequestSchema)
  .handler(async ({ data, context }) => {
    const input = {
      ...data,
      ...resolveLabsMarket(data, context.project),
      projectId: context.projectId,
    };
    if (shouldUseDomainE2eFixtures()) {
      const fixtures = await getDomainE2eFixtures();
      return fixtures.getFixturePagesPage(input);
    }

    return DomainService.getPagesPage(input, context);
  });

/**
 * CL-401 first callers (server half). The three domain-overview endpoints
 * that shipped with no reader. Each resolves the project market first —
 * historical_rank_overview and competitors_domain require one of each
 * location/language pair, and the market codes satisfy that — then reads
 * through the metered DomainIntel service. No e2e fixture branch: no spec
 * covers these paths, and a fixture here would be a second implementation
 * of the mapping the service tests already pin.
 */
export const getDomainHistoricalRanks = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainHistoricalSchema)
  .handler(async ({ data, context }) =>
    DomainIntel.getHistoricalRanks(
      {
        ...data,
        ...resolveLabsMarket(data, context.project),
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
      context,
    ),
  );

export const getDomainSubdomains = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainSubdomainsSchema)
  .handler(async ({ data, context }) =>
    DomainIntel.getSubdomains(
      {
        ...data,
        ...resolveLabsMarket(data, context.project),
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
      context,
    ),
  );

export const getDomainCompetitors = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainCompetitorsSchema)
  .handler(async ({ data, context }) =>
    DomainIntel.getCompetitors(
      {
        ...data,
        ...resolveLabsMarket(data, context.project),
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
      context,
    ),
  );
