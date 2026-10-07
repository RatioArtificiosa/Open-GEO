import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
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
