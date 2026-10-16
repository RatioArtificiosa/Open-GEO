import { z } from "zod";
import { isValidDomainHost, researchScopeSchema } from "@/shared/researchScope";

/**
 * Extract and validate a bare hostname from user input that may be a full URL.
 * Strips protocol, www prefix, path, query-string, and hash.
 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  // Ensure URL() can parse the input by adding a protocol if missing
  if (!/^[a-z]+:\/\//.test(d)) d = `https://${d}`;
  const { hostname } = new URL(d); // throws on truly invalid input
  return hostname.replace(/^www\./, "");
}

/** Zod field: accepts a bare domain or full URL, outputs a clean hostname. */
export const domainField = z
  .string()
  .min(1)
  .max(253)
  .transform((val, ctx) => {
    try {
      const hostname = normalizeDomain(val);
      if (!hostname.includes(".") || !isValidDomainHost(hostname)) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid domain like example.com",
        });
        return z.NEVER;
      }
      return hostname;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Enter a valid domain like example.com",
      });
      return z.NEVER;
    }
  });

export const booleanSearchParamSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const domainOverviewSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().min(1, "Domain is required").max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
});

/* ------------------------------------------------------------------ */
/*  URL search params schema for /p/$projectId/domain                  */
/* ------------------------------------------------------------------ */

const domainSortModes = ["rank", "traffic", "volume", "score", "cpc"] as const;
const domainSortOrders = ["asc", "desc"] as const;
const domainTabs = ["keywords", "pages"] as const;

/** Strict yyyy-mm-dd, matching the calendar-date module the clients validate with. */
const calendarDateField = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "Use a real calendar date in yyyy-mm-dd format",
  );

const labsNameField = z.string().min(1).max(128);
const labsLanguageNameField = z.string().min(1).max(64);

/**
 * CL-401 first callers: the three domain-overview endpoints that shipped with
 * no reader. Location/language arrive as either/or pairs (code or name) —
 * mirroring the clients, which require one of each pair for
 * historical_rank_overview and competitors_domain and accept all-optional for
 * subdomains. Project-market codes fill an absent pair downstream.
 */
export const domainHistoricalSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().min(1, "Domain is required").max(2048),
  locationCode: z.number().int().positive().optional(),
  locationName: labsNameField.optional(),
  languageCode: z.string().min(2).max(8).optional(),
  languageName: labsLanguageNameField.optional(),
  dateFrom: calendarDateField.optional(),
  dateTo: calendarDateField.optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export const domainSubdomainsSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().min(1, "Domain is required").max(2048),
  locationCode: z.number().int().positive().optional(),
  locationName: labsNameField.optional(),
  languageCode: z.string().min(2).max(8).optional(),
  languageName: labsLanguageNameField.optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
});

/**
 * CL-408 lead lists: a WHOIS domain pattern plus the stack gap to slice on.
 * maxCandidates bounds the per-list spend (one technologies read per
 * candidate); the service cap is the backstop and this schema is the UI's.
 */
export const domainLeadsSchema = z.object({
  projectId: z.string().uuid(),
  domainPattern: z.string().min(1, "Domain pattern is required").max(128),
  requiredTech: z
    .array(z.string().min(1).max(64))
    .min(1, "At least one required technology")
    .max(10),
  excludedTech: z
    .array(z.string().min(1).max(64))
    .max(10)
    .optional(),
  maxCandidates: z.number().int().min(1).max(25).optional(),
});

export const domainCompetitorsSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().min(1, "Domain is required").max(2048),
  locationCode: z.number().int().positive().optional(),
  locationName: labsNameField.optional(),
  languageCode: z.string().min(2).max(8).optional(),
  languageName: labsLanguageNameField.optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
});

export const domainKeywordSuggestionsSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().min(1, "Domain is required").max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
});

export const DOMAIN_KEYWORDS_PAGE_SIZES = [50, 100, 200] as const;
export const DEFAULT_DOMAIN_KEYWORDS_PAGE_SIZE = 100;
export const MAX_DATAFORSEO_FILTER_CONDITIONS = 8;

const optionalNumber = z
  .union([
    z.number(),
    z.string().transform((value, ctx) => {
      const trimmed = value.trim();
      if (trimmed === "") return undefined;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: "custom", message: "Invalid number" });
        return z.NEVER;
      }
      return parsed;
    }),
  ])
  .optional();

const domainKeywordsFiltersSchema = z.object({
  include: z.string().optional(),
  exclude: z.string().optional(),
  minTraffic: optionalNumber,
  maxTraffic: optionalNumber,
  minVol: optionalNumber,
  maxVol: optionalNumber,
  minCpc: optionalNumber,
  maxCpc: optionalNumber,
  minKd: optionalNumber,
  maxKd: optionalNumber,
  minRank: optionalNumber,
  maxRank: optionalNumber,
});

export type DomainKeywordsFilters = z.infer<typeof domainKeywordsFiltersSchema>;

export const domainKeywordsPageRequestSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z
    .number()
    .int()
    .refine((value) =>
      (DOMAIN_KEYWORDS_PAGE_SIZES as readonly number[]).includes(value),
    )
    .default(DEFAULT_DOMAIN_KEYWORDS_PAGE_SIZE),
  sortMode: z.enum(domainSortModes).default("traffic"),
  sortOrder: z.enum(domainSortOrders).default("desc"),
  filters: domainKeywordsFiltersSchema.default({}),
  search: z.string().optional(),
});

const domainPagesSortModes = ["traffic", "keywords"] as const;

export const domainPagesPageRequestSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z
    .number()
    .int()
    .refine((value) =>
      (DOMAIN_KEYWORDS_PAGE_SIZES as readonly number[]).includes(value),
    )
    .default(DEFAULT_DOMAIN_KEYWORDS_PAGE_SIZE),
  sortMode: z.enum(domainPagesSortModes).default("traffic"),
  sortOrder: z.enum(domainSortOrders).default("desc"),
  filters: domainKeywordsFiltersSchema.default({}),
  search: z.string().optional(),
});

const optionalSearchNumberParam = z.coerce.number().optional().catch(undefined);
const optionalSearchPositiveIntParam = z.coerce
  .number()
  .int()
  .positive()
  .optional()
  .catch(undefined);
const filterStringParam = z.string().optional();
const filterNumberParam = optionalSearchNumberParam;

export const domainSearchSchema = z.object({
  domain: z.string().optional(),
  scope: researchScopeSchema.optional().catch(undefined),
  /** Legacy param: pre-scope URLs encoded "Include subdomains" here. */
  subdomains: booleanSearchParamSchema.optional(),
  sort: z.enum(domainSortModes).optional(),
  order: z.enum(domainSortOrders).optional(),
  tab: z.enum(domainTabs).optional(),
  loc: optionalSearchPositiveIntParam,
  page: optionalSearchPositiveIntParam,
  size: z.coerce
    .number()
    .int()
    .refine((value) =>
      (DOMAIN_KEYWORDS_PAGE_SIZES as readonly number[]).includes(value),
    )
    .optional()
    .catch(undefined),
  include: filterStringParam,
  exclude: filterStringParam,
  minTraffic: filterNumberParam,
  maxTraffic: filterNumberParam,
  minVol: filterNumberParam,
  maxVol: filterNumberParam,
  minCpc: filterNumberParam,
  maxCpc: filterNumberParam,
  minKd: filterNumberParam,
  maxKd: filterNumberParam,
  minRank: filterNumberParam,
  maxRank: filterNumberParam,
  pInclude: filterStringParam,
  pExclude: filterStringParam,
  pMinTraffic: filterNumberParam,
  pMaxTraffic: filterNumberParam,
  pMinVol: filterNumberParam,
  pMaxVol: filterNumberParam,
});

export type DomainSearchParams = z.infer<typeof domainSearchSchema>;
