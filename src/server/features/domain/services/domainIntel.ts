import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { type EtvProvenance, resolveEtvMode } from "@/shared/etv-versioning";
import type { ResearchScope } from "@/shared/researchScope";

/**
 * First real callers for the three CL-401 domain-overview endpoints.
 *
 * `fetchHistoricalRankOverview`, `fetchSubdomains` and
 * `fetchCompetitorsDomain` shipped metered with per-item estimators and no
 * reader — built into the void, the row's own warning. These three functions
 * are the readers: each goes through the metered `dataforseo.domain`
 * namespace (never the raw fetch), each caches for 12 hours like the
 * overview, and each refuses nothing the vendor would bill.
 *
 * All three reads are domain-wide: none of the endpoints takes a scope
 * filter, so every scope shares one cache entry per hostname and callers
 * label the metrics domain-wide — the same rule `getOverview` documents.
 */

// Lets a caller attribute spend to its own feature (e.g. the SAM agent).
// Applied to the DataForSEO call, not the cache key, so cached results are
// shared across callers.
type MeteringOverrides = {
  creditFeature?: CreditFeature;
};

/** Domain intel reads are refreshed every 12 hours, like the overview. */
const DOMAIN_INTEL_TTL_SECONDS = 12 * 60 * 60;

const monthRowSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  organicTraffic: z.number().nullable(),
  organicKeywords: z.number().nullable(),
});

type MonthRow = z.infer<typeof monthRowSchema>;

const etvProvenanceSchema = z.object({
  formulaVersion: z.enum(["legacy", "new"]).nullable(),
  useNewEtv: z.boolean(),
  requestedAt: z.string(),
});

const trafficRowSchema = z.object({
  name: z.string(),
  organicTraffic: z.number().nullable(),
  organicKeywords: z.number().nullable(),
});

export type DomainTrafficRow = z.infer<typeof trafficRowSchema>;

type IntelInput = {
  organizationId: string;
  projectId: string;
  domain: string;
  scope?: ResearchScope;
  locationCode?: number;
  locationName?: string;
  languageCode?: string;
  languageName?: string;
};

function roundOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

function readOrganic(item: {
  metrics?: { organic?: { etv?: unknown; count?: unknown } | null } | null;
}): { organicTraffic: number | null; organicKeywords: number | null } {
  return {
    organicTraffic: roundOrNull(item.metrics?.organic?.etv),
    organicKeywords: roundOrNull(item.metrics?.organic?.count),
  };
}

export type HistoricalRanksResult = {
  months: MonthRow[];
  /** Legacy by vendor definition — historical endpoints are excluded from the new ETV model. */
  etv: EtvProvenance;
  scope: ResearchScope;
  displayTarget: string;
};

async function getHistoricalRanks(
  input: IntelInput & {
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
  billingCustomer: BillingCustomerContext,
  metering: MeteringOverrides = {},
): Promise<HistoricalRanksResult> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);

  // A fully-open window is resolved explicitly: the vendor defaults a missing
  // date_to to today, and a resolved six-month window touches seven calendar
  // months (pinned in labsDomainOverview.test.ts) while the flat estimator
  // default quotes six. Quoting and billing the same explicit window keeps
  // the estimate above the actual instead of $0.0012 below it.
  const dateTo = input.dateTo ?? new Date().toISOString().slice(0, 10);

  const cacheKey = await buildCacheKey("domain:historical", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain: target.hostname,
    locationCode: input.locationCode,
    locationName: input.locationName,
    languageCode: input.languageCode,
    languageName: input.languageName,
    dateFrom: input.dateFrom,
    dateTo,
    limit: input.limit,
  });

  const cachedRaw = await getCached(cacheKey);
  const cached = z
    .object({ months: z.array(monthRowSchema), etv: etvProvenanceSchema })
    .safeParse(cachedRaw);
  if (cached.success && cached.data.months.length > 0) {
    return {
      months: cached.data.months,
      etv: cached.data.etv,
      scope: target.scope,
      displayTarget: target.display,
    };
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const items = await dataforseo.domain.historicalRankOverview({
    target: target.hostname,
    locationCode: input.locationCode,
    locationName: input.locationName,
    languageCode: input.languageCode,
    languageName: input.languageName,
    dateFrom: input.dateFrom,
    dateTo,
    limit: input.limit,
    ...metering,
  });

  const mode = resolveEtvMode({ endpoint: "historical_rank_overview" });
  const etv: EtvProvenance = {
    formulaVersion: mode.version,
    useNewEtv: mode.useNewEtv,
    requestedAt: new Date().toISOString(),
  };

  const months: MonthRow[] = items
    .map((item) => {
      const year = typeof item.year === "number" ? Math.trunc(item.year) : null;
      const month =
        typeof item.month === "number" ? Math.trunc(item.month) : null;
      // A month without a year and month is not plottable — dropped rather
      // than filed under a made-up date.
      if (year === null || month === null || month < 1 || month > 12) {
        return null;
      }
      return { year, month, ...readOrganic(item) };
    })
    .filter((row): row is MonthRow => row !== null);

  if (months.length > 0) {
    // waitUntil, not void: workerd cancels unregistered pending I/O once the
    // response is sent, so a fire-and-forget put never persists the cache.
    waitUntil(
      setCached(
        cacheKey,
        { months, etv },
        DOMAIN_INTEL_TTL_SECONDS,
        billingCustomer.organizationId,
      ).catch((error: unknown) => {
        console.error("domain.historical.cache-write failed:", error);
      }),
    );
  }

  return {
    months,
    etv,
    scope: target.scope,
    displayTarget: target.display,
  };
}

export type DomainListResult = {
  rows: DomainTrafficRow[];
  scope: ResearchScope;
  displayTarget: string;
};

async function getSubdomains(
  input: IntelInput & { limit?: number; offset?: number },
  billingCustomer: BillingCustomerContext,
  metering: MeteringOverrides = {},
): Promise<DomainListResult> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);

  const cacheKey = await buildCacheKey("domain:subdomains", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain: target.hostname,
    locationCode: input.locationCode,
    locationName: input.locationName,
    languageCode: input.languageCode,
    languageName: input.languageName,
    limit: input.limit,
    offset: input.offset,
  });

  const cachedRaw = await getCached(cacheKey);
  const cached = z.array(trafficRowSchema).safeParse(cachedRaw);
  if (cached.success && cached.data.length > 0) {
    return {
      rows: cached.data,
      scope: target.scope,
      displayTarget: target.display,
    };
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const items = await dataforseo.domain.subdomains({
    target: target.hostname,
    locationCode: input.locationCode,
    locationName: input.locationName,
    languageCode: input.languageCode,
    languageName: input.languageName,
    limit: input.limit,
    offset: input.offset,
    ...metering,
  });

  const rows: DomainTrafficRow[] = items
    .map((item) => {
      // An unnamed row cannot be listed — dropped rather than rendered blank.
      if (typeof item.subdomain !== "string" || item.subdomain.length === 0) {
        return null;
      }
      return { name: item.subdomain, ...readOrganic(item) };
    })
    .filter((row): row is DomainTrafficRow => row !== null);

  if (rows.length > 0) {
    // waitUntil, not void: workerd cancels unregistered pending I/O once the
    // response is sent, so a fire-and-forget put never persists the cache.
    waitUntil(
      setCached(
        cacheKey,
        rows,
        DOMAIN_INTEL_TTL_SECONDS,
        billingCustomer.organizationId,
      ).catch((error: unknown) => {
        console.error("domain.subdomains.cache-write failed:", error);
      }),
    );
  }

  return { rows, scope: target.scope, displayTarget: target.display };
}

async function getCompetitors(
  input: IntelInput & { limit?: number; offset?: number },
  billingCustomer: BillingCustomerContext,
  metering: MeteringOverrides = {},
): Promise<DomainListResult> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);

  const cacheKey = await buildCacheKey("domain:competitors", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain: target.hostname,
    locationCode: input.locationCode,
    locationName: input.locationName,
    languageCode: input.languageCode,
    languageName: input.languageName,
    limit: input.limit,
    offset: input.offset,
  });

  const cachedRaw = await getCached(cacheKey);
  const cached = z.array(trafficRowSchema).safeParse(cachedRaw);
  if (cached.success && cached.data.length > 0) {
    return {
      rows: cached.data,
      scope: target.scope,
      displayTarget: target.display,
    };
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const items = await dataforseo.domain.competitorsDomain({
    target: target.hostname,
    locationCode: input.locationCode,
    locationName: input.locationName,
    languageCode: input.languageCode,
    languageName: input.languageName,
    limit: input.limit,
    offset: input.offset,
    ...metering,
  });

  const rows: DomainTrafficRow[] = items
    .map((item) => {
      if (typeof item.domain !== "string" || item.domain.length === 0) {
        return null;
      }
      return { name: item.domain, ...readOrganic(item) };
    })
    .filter((row): row is DomainTrafficRow => row !== null);

  if (rows.length > 0) {
    // waitUntil, not void: workerd cancels unregistered pending I/O once the
    // response is sent, so a fire-and-forget put never persists the cache.
    waitUntil(
      setCached(
        cacheKey,
        rows,
        DOMAIN_INTEL_TTL_SECONDS,
        billingCustomer.organizationId,
      ).catch((error: unknown) => {
        console.error("domain.competitors.cache-write failed:", error);
      }),
    );
  }

  return { rows, scope: target.scope, displayTarget: target.display };
}

export const DomainIntel = {
  getHistoricalRanks,
  getSubdomains,
  getCompetitors,
} as const;
