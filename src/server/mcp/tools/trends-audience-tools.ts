import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  DEMOGRAPHY_COMPARISON_CAVEAT,
  DEMOGRAPHY_PER_KEYWORD_CAVEAT,
  readDemographyComparison,
  readKeywordDemography,
} from "@/server/features/trends/demography";
import {
  readSubregionComparison,
  readSubregionInterests,
  SUBREGION_COMPARISON_CAVEAT,
  SUBREGION_PER_KEYWORD_CAVEAT,
} from "@/server/features/trends/subregion";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";

/**
 * The audience and geography tools: who searches, and where.
 *
 * Split from `trends-tools.ts` once that module passed the repository's 400-line budget. The cut is
 * by view group — the explore tool answers "is interest rising", these answer "who" and "where" —
 * which is the shape a fourth tool would also have fitted.
 */

/**
 * Who searches for a term: the age and gender split of its interest.
 *
 * ## Two blocks that look alike and answer opposite questions
 *
 * The vendor returns per-keyword profiles whose scores are shares of **that keyword's own peak**,
 * and a comparison block whose scores are shares of the **requested keywords' total** within each
 * bucket. Reading one for the other produces a confident comparison that means nothing, so both
 * are returned under their own names with a caveat each — and the comparison is **null when only
 * one keyword was asked for**, which is what the vendor sends and is an answer rather than a gap.
 *
 * ## Price
 *
 * One request, billed the same at one keyword or five.
 */
const demographyInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe(
      "Keywords to break down by age and gender, up to 5. One request is billed the same at one keyword or five.",
    ),
  type: z
    .enum(["web", "news", "ecommerce"])
    .optional()
    .describe("Which index to read: web (default), news, or ecommerce."),
  timeRange: z
    .enum([
      "past_4_hours",
      "past_day",
      "past_7_days",
      "past_30_days",
      "past_90_days",
      "past_12_months",
      "past_5_years",
    ])
    .optional()
    .describe(
      "A preset window. Cannot be combined with dateFrom/dateTo, because the vendor ignores it when either date is set.",
    ),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start of the window, yyyy-mm-dd."),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End of the window, yyyy-mm-dd."),
  locationCode: z
    .number()
    .int()
    .optional()
    .describe(
      "Country-level location code. Defaults to the project's own market; this product does not request global results.",
    ),
} as const;

type DemographyArgs = z.infer<z.ZodObject<typeof demographyInputSchema>>;

export const getSearchDemographyTool = {
  name: "get_search_demography",
  config: {
    title: "Get the age and gender split of interest",
    description:
      "Returns how interest in up to five keywords splits by age band and gender, plus a comparison across the keywords when there is more than one. Use it to see who a market actually is. Per-keyword scores are shares of that keyword's own peak; comparison scores are shares across the request, so the two blocks are not on the same ruler. A score of 0 means the vendor had no data. Charges credits once per request.",
    inputSchema: demographyInputSchema,
    outputSchema: z
      .object({
        keywords: z.array(
          z.looseObject({
            keyword: z.string(),
            age: z.array(
              z.looseObject({
                bucket: z.string(),
                value: z.number().nullable(),
              }),
            ),
            gender: z.array(
              z.looseObject({
                bucket: z.string(),
                value: z.number().nullable(),
              }),
            ),
          }),
        ),
        /** Null for a single keyword, which is what the vendor sends. */
        comparison: z
          .looseObject({
            age: z.record(z.string(), z.array(z.number().nullable())),
            gender: z.record(z.string(), z.array(z.number().nullable())),
          })
          .nullable(),
        perKeywordCaveat: z.string(),
        comparisonCaveat: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: DemographyArgs, context) => {
    const client = createDataforseoClient(context.billing);
    const items = await client.keywords.trendsDemography({
      keywords: args.keywords,
      type: args.type,
      timeRange: args.timeRange,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      locationCode: args.locationCode ?? context.project.locationCode,
    });

    const item = items[0] ?? {};
    const keywords = readKeywordDemography(item);
    const comparison = readDemographyComparison(item);
    const requestCostUsd =
      DFS_KEYWORDS.dfsTrends.subregionOrDemography.perRequest;

    return mcpResponse({
      text: `${keywords.length} keyword${keywords.length === 1 ? "" : "s"} broken down by age and gender, about $${requestCostUsd.toFixed(4)} for the request whatever it carried. ${DEMOGRAPHY_PER_KEYWORD_CAVEAT} ${comparison === null ? "No comparison: the vendor returns one only when more than one keyword is asked for." : DEMOGRAPHY_COMPARISON_CAVEAT}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/trends`,
      ),
      structuredContent: {
        keywords,
        comparison,
        perKeywordCaveat: DEMOGRAPHY_PER_KEYWORD_CAVEAT,
        comparisonCaveat: DEMOGRAPHY_COMPARISON_CAVEAT,
      },
    });
  }),
};

/**
 * Where a term is popular, with the three rulers kept apart.
 *
 * The response carries three normalised blocks: locations within a keyword, keywords within a
 * location, and one across everything. Only the last can be read between places, and a surface that
 * mixed them would show a dozen strongholds per keyword. The tool returns them under their own names
 * with a caveat each, and the comparison blocks are **null for a single keyword** — the vendor's
 * answer rather than a gap.
 */
const regionsInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe(
      "Keywords to place geographically, up to 5. One request is billed the same at one keyword or five.",
    ),
  type: z
    .enum(["web", "news", "ecommerce"])
    .optional()
    .describe("Which index to read: web (default), news, or ecommerce."),
  timeRange: z
    .enum([
      "past_4_hours",
      "past_day",
      "past_7_days",
      "past_30_days",
      "past_90_days",
      "past_12_months",
      "past_5_years",
    ])
    .optional()
    .describe(
      "A preset window. Cannot be combined with dateFrom/dateTo, because the vendor ignores it when either date is set.",
    ),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start of the window, yyyy-mm-dd."),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End of the window, yyyy-mm-dd."),
  locationCode: z
    .number()
    .int()
    .optional()
    .describe(
      "Country-level location code. Defaults to the project's own market; this product does not request global results.",
    ),
} as const;

type RegionsArgs = z.infer<z.ZodObject<typeof regionsInputSchema>>;

export const getSearchRegionsTool = {
  name: "get_search_regions",
  config: {
    title: "Get where a term is popular",
    description:
      "Returns how interest in up to five keywords splits across locations, plus comparisons across the keywords when there is more than one. Use it to find regional strongholds and gaps. Three blocks come back and they are not on one ruler: per-keyword location scores compare places within a keyword, the comparison block compares keywords within a place, and only the across-all-locations block can be read between places. A score of 0 means the vendor had no data. Charges credits once per request.",
    inputSchema: regionsInputSchema,
    outputSchema: z
      .object({
        keywords: z.array(
          z.looseObject({
            keyword: z.string(),
            locations: z.array(
              z.looseObject({ geo: z.string(), value: z.number().nullable() }),
            ),
          }),
        ),
        /** Null for a single keyword, which is what the vendor sends. */
        comparison: z
          .looseObject({
            withinLocation: z.array(
              z.looseObject({
                geo: z.string(),
                values: z.array(z.number().nullable()),
              }),
            ),
            acrossAllLocations: z.array(
              z.looseObject({
                geo: z.string(),
                values: z.array(z.number().nullable()),
              }),
            ),
          })
          .nullable(),
        perKeywordCaveat: z.string(),
        comparisonCaveat: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: RegionsArgs, context) => {
    const client = createDataforseoClient(context.billing);
    const items = await client.keywords.trendsSubregion({
      keywords: args.keywords,
      type: args.type,
      timeRange: args.timeRange,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      locationCode: args.locationCode ?? context.project.locationCode,
    });

    const item = items[0] ?? {};
    const keywords = readSubregionInterests(item);
    const comparison = readSubregionComparison(item);
    const requestCostUsd =
      DFS_KEYWORDS.dfsTrends.subregionOrDemography.perRequest;

    return mcpResponse({
      text: `${keywords.length} keyword${keywords.length === 1 ? "" : "s"} placed by region, about $${requestCostUsd.toFixed(4)} for the request whatever it carried. ${SUBREGION_PER_KEYWORD_CAVEAT} ${comparison === null ? "No comparison: the vendor returns one only when more than one keyword is asked for." : SUBREGION_COMPARISON_CAVEAT}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/trends`,
      ),
      structuredContent: {
        keywords,
        comparison,
        perKeywordCaveat: SUBREGION_PER_KEYWORD_CAVEAT,
        comparisonCaveat: SUBREGION_COMPARISON_CAVEAT,
      },
    });
  }),
};
