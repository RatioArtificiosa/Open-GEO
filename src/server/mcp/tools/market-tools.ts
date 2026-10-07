import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { describeMetricsMovement } from "@/server/features/market-analysis/metric-movement";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import { getDomainCategoryProfile } from "@/server/features/market-analysis/CategoryProfileService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { resolveLabsMarketSelector } from "@/server/lib/market";

/**
 * The categories a domain ranks in, which is the shape of a market.
 *
 * ## What this answers, and what it refuses to fake
 *
 * A category profile is the question "what business is this site actually in, according to
 * Google", with the traffic attached to each answer. The vendor returns those categories as
 * **numeric criterion IDs and no labels**, so the names come from a taxonomy this product seeds
 * from a dated vendor CSV. When the two disagree, the category is returned **with `name: null`**
 * rather than dropped or invented, and `unresolvedCount` reports how many that happened to — a
 * reader looking at an unnamed category is seeing that our taxonomy is behind the vendor's, which
 * is a fact worth showing rather than a gap worth hiding.
 *
 * ## Price
 *
 * One Labs request, priced as the family is. **`includeClickstreamData` doubles it**, and buys
 * `clickstream_etv` plus age and gender distributions — so it is an explicit opt-in and never a
 * default.
 */

const inputSchema = {
  projectId: projectIdSchema,
  target: z
    .string()
    .min(1)
    .describe(
      "Domain or subdomain to profile, without scheme or www (example.com, not https://www.example.com).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum categories to return. Defaults to 50."),
  includeClickstreamData: z
    .boolean()
    .optional()
    .describe(
      "Adds clickstream traffic and age/gender distributions. Doubles the vendor's price for this request, so use it only when demography is the question.",
    ),
  locationCode: z
    .number()
    .int()
    .optional()
    .describe(
      "Country-level DataForSEO Labs location code. Defaults to the project's market.",
    ),
  languageCode: z
    .string()
    .optional()
    .describe(
      "Language code for the location. Defaults to the location's own.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getDomainCategoriesTool = {
  name: "get_domain_categories",
  config: {
    title: "Get a domain's categories",
    description:
      "Returns the product and service categories a domain ranks in, with organic and paid traffic per category. Use it to see what business a domain is actually in and where its traffic comes from. Categories are named from this product's taxonomy; any the taxonomy cannot name come back with a null name so the gap is visible rather than hidden. Charges credits, doubled if includeClickstreamData is set.",
    inputSchema,
    outputSchema: z
      .object({
        target: z.string(),
        categories: z.array(
          z.looseObject({
            criterionIds: z.array(z.number()),
            /** Parallel to criterionIds; a null entry is a category our taxonomy cannot name. */
            names: z.array(z.string().nullable()),
            organicCount: z.number().nullable(),
            organicEtv: z.number().nullable(),
            paidCount: z.number().nullable(),
            paidEtv: z.number().nullable(),
          }),
        ),
        /** Categories the vendor returned that this build cannot name. */
        unresolvedCount: z.number(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const market = resolveLabsMarketSelector(args, context.project);
    const client = createDataforseoClient(context.billing);
    const profile = await getDomainCategoryProfile({
      client,
      target: args.target,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      limit: args.limit ?? 50,
      includeClickstreamData: args.includeClickstreamData,
    });

    const categories = profile.entries
      .filter((entry) => entry.categoryNames.length > 0)
      .map((entry) => ({
        criterionIds: entry.categoryNames.map(
          (category) => category.criterionId,
        ),
        names: entry.categoryNames.map((category) => category.name),
        organicCount: entry.metrics?.organic?.count ?? null,
        organicEtv: entry.metrics?.organic?.etv ?? null,
        paidCount: entry.metrics?.paid?.count ?? null,
        paidEtv: entry.metrics?.paid?.etv ?? null,
      }));

    const unnamed =
      profile.unresolvedCount > 0
        ? ` ${profile.unresolvedCount} categor${profile.unresolvedCount === 1 ? "y" : "ies"} came back unnamed because this product's taxonomy predates them; they are listed with a null name rather than dropped.`
        : "";

    return mcpResponse({
      text: `${profile.target} ranks in ${categories.length} categor${categories.length === 1 ? "y" : "ies"} in this market.${unnamed}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/market`,
      ),
      structuredContent: {
        target: profile.target,
        categories,
        unresolvedCount: profile.unresolvedCount,
      },
    });
  }),
};

/**
 * The drill-down: what people actually search inside a set of categories.
 *
 * ## The one decision this tool makes for the caller
 *
 * The vendor's `category_intersection` defaults to **`true`**, which returns only keywords that
 * appear in **every** category named. That is rarely what "keywords for these categories" means,
 * and its failure mode is a short or empty list that reads like a failed request. This tool
 * therefore **defaults to `false`** — keywords in **any** of the named categories — states that in
 * the schema, and passes the choice through explicitly rather than letting the vendor's default
 * decide.
 *
 * ## Price
 *
 * One Labs request, and `includeClickstreamData` **doubles it**. `category_codes` takes at most 20
 * categories, and more than that is refused before the request rather than truncated, because
 * silently answering a narrower question is worse than an error.
 */
const keywordsInputSchema = {
  projectId: projectIdSchema,
  categoryCodes: z
    .array(z.number().int())
    .min(1)
    .max(20)
    .describe(
      "Criterion IDs to gather keywords for, from get_domain_categories (1 to 20).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum keywords to return. Defaults to 50."),
  categoryIntersection: z
    .boolean()
    .optional()
    .describe(
      "false (default): keywords appearing in ANY of these categories — usually what 'keywords for these categories' means. true: only keywords appearing in ALL of them, which is a much narrower question and can return nothing.",
    ),
  includeClickstreamData: z
    .boolean()
    .optional()
    .describe(
      "Adds clickstream volume, age and gender distributions per keyword. Doubles the vendor's price for this request.",
    ),
  locationCode: z
    .number()
    .int()
    .optional()
    .describe(
      "Country-level DataForSEO Labs location code. Defaults to the project's market.",
    ),
  languageCode: z
    .string()
    .optional()
    .describe(
      "Language code for the location. Defaults to the location's own.",
    ),
} as const;

type KeywordsArgs = z.infer<z.ZodObject<typeof keywordsInputSchema>>;

export const getCategoryKeywordsTool = {
  name: "get_category_keywords",
  config: {
    title: "Get keywords for categories",
    description:
      "Returns the keywords people search inside one or more product categories, with volume, CPC, difficulty and search intent per keyword. Use it after get_domain_categories to see what the demand looks like inside a category a domain ranks in — or in one it does not, to size a gap. Charges credits, doubled if includeClickstreamData is set.",
    inputSchema: keywordsInputSchema,
    outputSchema: z
      .object({
        categoryCodes: z.array(z.number()),
        categoryIntersection: z.boolean(),
        keywords: z.array(
          z.looseObject({
            keyword: z.string().nullable(),
            searchVolume: z.number().nullable(),
            cpc: z.number().nullable(),
            difficulty: z.number().nullable(),
            intent: z.string().nullable(),
          }),
        ),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: KeywordsArgs, context) => {
    const market = resolveLabsMarketSelector(args, context.project);
    const categoryIntersection = args.categoryIntersection ?? false;
    const client = createDataforseoClient(context.billing);

    const items = await client.domain.keywordsForCategories({
      categoryCodes: args.categoryCodes,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      categoryIntersection,
      limit: args.limit ?? 50,
      includeClickstreamData: args.includeClickstreamData,
    });

    const keywords = items.map((item) => ({
      keyword: item.keyword ?? null,
      searchVolume: item.keyword_info?.search_volume ?? null,
      cpc: item.keyword_info?.cpc ?? null,
      difficulty: item.keyword_properties?.keyword_difficulty ?? null,
      intent: item.search_intent_info?.main_intent ?? null,
    }));

    const scope = categoryIntersection
      ? "in all of the named categories"
      : "in any of the named categories";

    return mcpResponse({
      text: `${keywords.length} keyword${keywords.length === 1 ? "" : "s"} ${scope}.${keywords.length === 0 && categoryIntersection ? " Nothing matched across every category, which is what an intersection means: try categoryIntersection false to see each category's own demand." : ""}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/market`,
      ),
      structuredContent: {
        categoryCodes: args.categoryCodes,
        categoryIntersection,
        keywords,
      },
    });
  }),
};

/**
 * Who competes in a set of categories, and how their traffic moved between two months.
 *
 * ## This is the expensive one, and the tool says so
 *
 * `domain_metrics_by_categories` prices at `heavyHistorical`: **$0.12 a request plus $0.0012 a
 * domain**, roughly **ten times** its siblings. A caller who discovers that from a bill has been
 * failed by the tool, so the price is in the description, in the schema, and in the response as
 * the request-fee floor. The distinct per-domain part is stated rather than estimated, because the
 * number of domains returned is not knowable before the call.
 *
 * ## Movement is computed from the two months, not from the vendor's difference block
 *
 * The reference's own description of that block does not pin its sign, and its sample contradicts
 * itself — see `metric-movement.ts`. Direction therefore comes from `metrics_history`, the two
 * months the caller asked about, which are unambiguous.
 *
 * ## Every date rule is checked before the request
 *
 * The same month twice, a date before 2020-10-01, or a future date are all **billed** rejections
 * at the vendor. They are refused locally instead, which is why the schema is strict and the
 * client's guard names the rule it broke.
 */
const domainMetricsInputSchema = {
  projectId: projectIdSchema,
  categoryCodes: z
    .array(z.number().int())
    .min(1)
    .max(5)
    .describe(
      "Criterion IDs to compare, from get_domain_categories. This endpoint takes at most 5, not the 20 its sibling allows.",
    ),
  firstDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      "First month to compare, as yyyy-mm-dd. The month is what matters; the day is ignored by the vendor. Must be 2020-10-01 or later, and on a different month from secondDate.",
    ),
  secondDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      "Second month to compare, as yyyy-mm-dd. It may be earlier than firstDate; the pair is treated as two points, not a range.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Maximum domains to return, fewest-traffic last. Defaults to 25. The per-domain part of the price scales with what comes back.",
    ),
  topCategoriesCount: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Also collect domains from this many top categories beyond those requested. Cannot be less than the number of categoryCodes.",
    ),
  includeSubdomains: z
    .boolean()
    .optional()
    .describe(
      "Include subdomains alongside the main domain. The vendor defaults to true; set false for main domains only.",
    ),
  locationCode: z
    .number()
    .int()
    .optional()
    .describe(
      "Country-level DataForSEO Labs location code. Defaults to the project's market.",
    ),
  languageCode: z
    .string()
    .optional()
    .describe(
      "Language code for the location. Defaults to the location's own.",
    ),
} as const;

type DomainMetricsArgs = z.infer<z.ZodObject<typeof domainMetricsInputSchema>>;

export const getCategoryDomainMetricsTool = {
  name: "get_category_domain_metrics",
  config: {
    title: "Compare domains in categories over two months",
    description:
      "Returns the domains ranking in the given product categories with their estimated traffic at two points in time, and whether each grew or fell between them. Use it to see who owns a category's demand and whether that is shifting. This is the most expensive endpoint this product calls: about $0.12 per request plus $0.0012 per domain returned. Both dates are required, must be different months, and must be 2020-10-01 or later.",
    inputSchema: domainMetricsInputSchema,
    outputSchema: z
      .object({
        categoryCodes: z.array(z.number()),
        fromMonth: z.string().nullable(),
        toMonth: z.string().nullable(),
        /** The request fee, which is charged whatever comes back. The per-domain part is separate. */
        requestCostUsd: z.number(),
        perDomainCostUsd: z.number(),
        domains: z.array(
          z.looseObject({
            domain: z.string().nullable(),
            organicEtv: z.number().nullable(),
            etvChange: z.number().nullable(),
            growing: z.boolean().nullable(),
          }),
        ),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: DomainMetricsArgs, context) => {
    const market = resolveLabsMarketSelector(args, context.project);
    const client = createDataforseoClient(context.billing);

    const items = await client.domain.domainMetricsByCategories({
      categoryCodes: args.categoryCodes,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      firstDate: args.firstDate,
      secondDate: args.secondDate,
      topCategoriesCount: args.topCategoriesCount,
      includeSubdomains: args.includeSubdomains,
      limit: args.limit ?? 25,
    });

    const domains = items.map((item) => {
      const movement = describeMetricsMovement(item.metrics_history);
      return {
        domain: item.domain ?? null,
        organicEtv: item.organic_etv ?? null,
        etvChange: movement?.etvChange ?? null,
        growing: movement?.growing ?? null,
        fromMonth: movement?.fromMonth ?? null,
        toMonth: movement?.toMonth ?? null,
      };
    });

    const requestCostUsd = DFS_LABS.heavyHistorical.perRequest;
    const perDomainCostUsd = DFS_LABS.heavyHistorical.perUnit;
    const grew = domains.filter((domain) => domain.growing === true).length;
    const measurable = domains.filter(
      (domain) => domain.growing !== null,
    ).length;

    return mcpResponse({
      text: `${domains.length} domain${domains.length === 1 ? "" : "s"} in these categories, about $${requestCostUsd.toFixed(2)} + $${perDomainCostUsd.toFixed(4)} each. ${grew} of the ${measurable} with both months on record grew between them${domains.length > measurable ? `; ${domains.length - measurable} lack a reading for one of the months and are reported without a direction` : ""}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/market`,
      ),
      structuredContent: {
        categoryCodes: args.categoryCodes,
        fromMonth: domains[0]?.fromMonth ?? null,
        toMonth: domains[0]?.toMonth ?? null,
        requestCostUsd,
        perDomainCostUsd,
        domains,
      },
    });
  }),
};
