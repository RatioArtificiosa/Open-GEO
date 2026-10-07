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
