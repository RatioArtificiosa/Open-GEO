import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  readTrendSeries,
  TREND_SCALE_CAVEAT,
} from "@/server/features/trends/trendSeries";
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
