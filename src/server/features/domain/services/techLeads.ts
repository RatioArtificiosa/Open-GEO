import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import {
  type DomainTechnologiesRow,
  sliceByTechnology,
  technologyNames,
} from "@/server/lib/dataforseo/technologies";
import { AppError } from "@/server/lib/errors";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import type { CreditFeature } from "@/shared/billing-credit-features";

/**
 * Tech-slicing lead lists (CL-408 surface).
 *
 * The audit-to-outreach step the technologies client was built for: a WHOIS
 * prospecting filter finds candidate domains, one technologies read per
 * candidate recovers its stack and its contacts, and `sliceByTechnology`
 * keeps the rows running every required technology and none of the excluded
 * ones. Each step goes through the metered `dataforseo.domain` namespace —
 * WHOIS first (the $0.12 read), then at most `maxCandidates` technology
 * reads — so the credit gate prices the whole list before the first call.
 *
 * A candidate whose technologies read fails is reported in `failed` rather
 * than failing the list: one dead domain must not void the prospects already
 * paid for, and a failure restated as an empty list would read as "no demand".
 */

// Lets a caller attribute spend to its own feature (e.g. the SAM agent).
// Applied to the DataForSEO calls, not the cache key, so cached results are
// shared across callers.
type MeteringOverrides = {
  creditFeature?: CreditFeature;
};

/** Lead lists are refreshed every 12 hours, like the other domain reads. */
const TECH_LEADS_TTL_SECONDS = 12 * 60 * 60;

/** One technologies read per candidate caps the per-list spend. */
export const TECH_LEADS_MAX_CANDIDATES = 25;
const TECH_LEADS_DEFAULT_CANDIDATES = 10;

const prospectSchema = z.object({
  domain: z.string(),
  technologies: z.array(z.string()),
  emails: z.array(z.string()),
  phoneNumbers: z.array(z.string()),
  socialUrls: z.array(z.string()),
  countryIsoCode: z.string().nullable(),
  title: z.string().nullable(),
});

export type TechLeadProspect = z.infer<typeof prospectSchema>;

const failedSchema = z.object({
  domain: z.string(),
  reason: z.string(),
});

export type TechLeadsResult = {
  prospects: TechLeadProspect[];
  /** Candidates the WHOIS filter returned, before slicing and failures. */
  examined: number;
  failed: z.infer<typeof failedSchema>[];
};

function toProspect(row: DomainTechnologiesRow): TechLeadProspect {
  return {
    domain: row.domain,
    technologies: technologyNames(row),
    emails: row.emails ?? [],
    phoneNumbers: row.phone_numbers ?? [],
    socialUrls: row.social_graph_urls ?? [],
    countryIsoCode: row.country_iso_code ?? null,
    title: row.title ?? null,
  };
}

export async function findTechLeads(
  input: {
    organizationId: string;
    projectId: string;
    /** Matched as `%pattern%` against the WHOIS domain field. */
    domainPattern: string;
    /** At least one: a lead list with no required technology is the internet. */
    requiredTech: string[];
    excludedTech?: string[];
    maxCandidates?: number;
  },
  billingCustomer: BillingCustomerContext,
  metering: MeteringOverrides = {},
): Promise<TechLeadsResult> {
  const pattern = input.domainPattern.trim().toLowerCase();
  if (pattern.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "findTechLeads needs a domain pattern: an unfiltered WHOIS call returns the internet's largest domains, billed",
    );
  }
  const required = input.requiredTech
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  if (required.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "findTechLeads needs at least one required technology: slicing on nothing keeps everything",
    );
  }
  const excluded = (input.excludedTech ?? [])
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const maxCandidates = input.maxCandidates ?? TECH_LEADS_DEFAULT_CANDIDATES;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "findTechLeads needs maxCandidates of at least 1",
    );
  }
  if (maxCandidates > TECH_LEADS_MAX_CANDIDATES) {
    throw new AppError(
      "VALIDATION_ERROR",
      `findTechLeads reads one technologies row per candidate: ${maxCandidates} candidates exceeds the cap of ${TECH_LEADS_MAX_CANDIDATES}`,
    );
  }

  const cacheKey = await buildCacheKey("domain:tech-leads", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    pattern,
    required,
    excluded,
    maxCandidates,
  });

  const cachedRaw = await getCached(cacheKey);
  const cached = z
    .object({
      prospects: z.array(prospectSchema),
      examined: z.number(),
      failed: z.array(failedSchema),
    })
    .safeParse(cachedRaw);
  if (cached.success && cached.data.examined > 0) {
    return cached.data;
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const candidates = await dataforseo.domain.whoisOverview({
    filters: [["domain", "like", `%${pattern}%`]],
    limit: maxCandidates,
    ...metering,
  });

  // The meter unwraps the envelope: the row array arrives directly.
  const domains = candidates
    .map((row) => (typeof row.domain === "string" ? row.domain : null))
    .filter((domain): domain is string => domain !== null);

  // Settle-all on purpose: each technologies read is independently billed,
  // so a failure after the WHOIS call must report what it cost's
  // surroundings rather than voiding them. Fail-fast would bill the WHOIS
  // read and return nothing for it.
  const settled = await Promise.allSettled(
    domains.map((domain) =>
      dataforseo.domain.domainTechnologies({ target: domain, ...metering }),
    ),
  );

  const rows: DomainTechnologiesRow[] = [];
  const failed: z.infer<typeof failedSchema>[] = [];
  settled.forEach((outcome, index) => {
    const domain = domains[index] ?? `candidate ${index + 1}`;
    if (outcome.status === "fulfilled") {
      for (const row of outcome.value) {
        rows.push(row);
      }
    } else {
      failed.push({
        domain,
        reason:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : "technologies read failed",
      });
    }
  });

  const prospects = sliceByTechnology(rows, {
    required,
    excluded,
  }).map(toProspect);

  const result: TechLeadsResult = {
    prospects,
    examined: domains.length,
    failed,
  };
  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(
      cacheKey,
      result,
      TECH_LEADS_TTL_SECONDS,
      billingCustomer.organizationId,
    ).catch((error: unknown) => {
      console.error("domain.tech-leads.cache-write failed:", error);
    }),
  );
  return result;
}

export const TechLeadsService = { findTechLeads } as const;
