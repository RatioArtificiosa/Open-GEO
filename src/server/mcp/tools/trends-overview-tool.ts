import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  readTrendSeries,
  TREND_SCALE_CAVEAT,
} from "@/server/features/trends/trendSeries";
import {
  DEMOGRAPHY_PER_KEYWORD_CAVEAT,
  readKeywordDemography,
} from "@/server/features/trends/demography";
import { readSubregionInterests } from "@/server/features/trends/subregion";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";

/**
 * The whole trends picture in one request.
 *
 * ## Why this is one tool rather than three
 *
 * The merged endpoint returns all three views together, and that is its point: **one request means
 * one window**. The graph, the regions and the demography describe the same period, the same
 * location and the same moment of capture, so they cannot disagree — three separate calls could,
 * and the disagreement would be invisible in the output.
 *
 * It costs what the three cost separately. The saving is a shared frame, not money.
 *
 * ## No fourth reader
 *
 * Each element carries its own `type`, so this dispatches into the graph, subregion and demography
 * readers built for the separate endpoints. And every rule those carry holds here: each view has
 * its own normalisation, so they are not on one ruler, and `0` means the vendor had no data.
 */

const overviewInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe(
      "Keywords to chart, place and break down, up to 5. One request is billed the same at one keyword or five.",
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

type OverviewArgs = z.infer<z.ZodObject<typeof overviewInputSchema>>;

export const getTrendsOverviewTool = {
  name: "get_trends_overview",
  config: {
    title: "Get interest over time, by region and by audience",
    description:
      "Returns three views of the same keywords in one request: interest over time, the regional split, and the age and gender breakdown. Use it when you want the whole picture and want the three to describe the same period — a single request shares one window and one location, which separate calls cannot guarantee. Each view has its own normalisation, so they are not on one ruler, and 0 means the vendor had no data. Charges credits once per request.",
    inputSchema: overviewInputSchema,
    outputSchema: z
      .object({
        series: z.array(z.looseObject({ keyword: z.string() })),
        regions: z.array(z.looseObject({ keyword: z.string() })),
        demography: z.array(z.looseObject({ keyword: z.string() })),
        /** The three rulers, sent with the data so a caller cannot read one as another. */
        caveats: z.looseObject({
          scale: z.string(),
          perKeyword: z.string(),
        }),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: OverviewArgs, context) => {
    const client = createDataforseoClient(context.billing);
    const items = await client.keywords.trendsMerged({
      keywords: args.keywords,
      type: args.type,
      timeRange: args.timeRange,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      locationCode: args.locationCode ?? context.project.locationCode,
    });

    // Dispatched on the element's own `type`, which is what lets one request reuse three readers
    // rather than growing a fourth that knows all three shapes.
    const byType = new Map(items.map((item) => [item.type ?? "", item]));
    const series = readTrendSeries(byType.get("dataforseo_trends_graph") ?? {});
    const regions = readSubregionInterests(
      byType.get("subregion_interests") ?? {},
    );
    const demography = readKeywordDemography(byType.get("demography") ?? {});
    const requestCostUsd = DFS_KEYWORDS.dfsTrends.mergedData.perRequest;

    return mcpResponse({
      text: `Three views of ${args.keywords.length} keyword${args.keywords.length === 1 ? "" : "s"} from one request, about $${requestCostUsd.toFixed(4)}. They share one window and one location, which is why they are fetched together. ${TREND_SCALE_CAVEAT}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/trends`,
      ),
      structuredContent: {
        series: series.map((entry) => ({ keyword: entry.keyword })),
        regions: regions.map((entry) => ({ keyword: entry.keyword })),
        demography: demography.map((entry) => ({ keyword: entry.keyword })),
        caveats: {
          scale: TREND_SCALE_CAVEAT,
          perKeyword: DEMOGRAPHY_PER_KEYWORD_CAVEAT,
        },
      },
    });
  }),
};
