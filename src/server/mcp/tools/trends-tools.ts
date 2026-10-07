import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  readTrendSeries,
  TREND_SCALE_CAVEAT,
} from "@/server/features/trends/trendSeries";
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
 * Search interest over time, from DataForSEO's own index.
 *
 * ## The caveat is part of the answer, not a footnote
 *
 * The scores this returns are **relative to the biggest peak within the request**. Asking for one
 * keyword and asking for that keyword beside a rival produce different numbers for it, and neither
 * is wrong. So the caveat travels in the structured response as `scaleCaveat` rather than only in
 * prose: a caller that compares two calls can be told plainly that it is comparing two rulers.
 *
 * ## And a `0` is not a zero
 *
 * The vendor defines a score of 0 as *"not enough data for this term"*, so the series carries
 * `null` there. A caller plotting the numbers would otherwise draw a collapse in interest on a week
 * nobody measured.
 *
 * ## Price
 *
 * One request bills the same **whatever it carries** — one keyword or five — so the schema asks for
 * an array and the tool states the fee once.
 */
const trendsInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe(
      "Keywords to chart, up to 5. One request is billed the same at one keyword or five, so batching is free here.",
    ),
  type: z
    .enum(["web", "news", "ecommerce"])
    .optional()
    .describe(
      "Which index to read: web (default), news, or ecommerce. Historical data starts 2004-01-01 for web and 2008-01-01 for the others.",
    ),
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
      "A preset window. Cannot be combined with dateFrom/dateTo: the vendor ignores it when either date is set, so both together are refused rather than silently resolved.",
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
      "Country-level location code. Omit for global results — which is a different measurement, not an error.",
    ),
} as const;

type TrendsArgs = z.infer<z.ZodObject<typeof trendsInputSchema>>;

export const getSearchTrendsTool = {
  name: "get_search_trends",
  config: {
    title: "Get search interest over time",
    description:
      "Returns relative search interest over time for up to five keywords, from DataForSEO's own trends index. Use it to see whether interest in a term is rising, seasonal, or fading. Scores are relative to the biggest peak in the request, so numbers from two different calls are not comparable, and a score of 0 means the vendor had no data rather than no interest. Charges credits once per request regardless of keyword count.",
    inputSchema: trendsInputSchema,
    outputSchema: z
      .object({
        series: z.array(
          z.looseObject({
            keyword: z.string(),
            average: z.number().nullable(),
            points: z.array(
              z.looseObject({
                dateFrom: z.string().nullable(),
                dateTo: z.string().nullable(),
                value: z.number().nullable(),
              }),
            ),
          }),
        ),
        /** Travels with the data, so a caller comparing calls is told not to. */
        scaleCaveat: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: TrendsArgs, context) => {
    const client = createDataforseoClient(context.billing);
    const items = await client.keywords.trendsExplore({
      keywords: args.keywords,
      type: args.type,
      timeRange: args.timeRange,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      locationCode: args.locationCode,
    });

    const series = readTrendSeries(items[0] ?? {});
    const requestCostUsd = DFS_KEYWORDS.dfsTrends.explore.perRequest;
    const measured = series.filter((entry) => entry.average !== null).length;

    return mcpResponse({
      text: `${series.length} series over ${series[0]?.points.length ?? 0} points, about $${requestCostUsd.toFixed(4)} for the request whatever it carried. ${measured === series.length ? "" : `${series.length - measured} have no average because the vendor returned no data for them. `}${TREND_SCALE_CAVEAT}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/trends`,
      ),
      structuredContent: {
        series,
        scaleCaveat: TREND_SCALE_CAVEAT,
      },
    });
  }),
};

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
    .describe("Country-level location code. Omit for global results."),
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
    .describe("Country-level location code. Omit for global results."),
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
