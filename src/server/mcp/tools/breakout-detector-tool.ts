import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  breakoutSignals,
  type BreakoutSignal,
} from "@/server/features/trends/breakoutSignals";
import {
  readTrendSeries,
  TREND_SCALE_CAVEAT,
} from "@/server/features/trends/trendSeries";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  creditsFor,
  dryRunInputSchema,
  dryRunResponse,
  wantsToSpend,
} from "@/server/mcp/dry-run";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";

/**
 * `breakout_detector` — which of these terms is actually breaking out.
 *
 * ## Why pure maths over a series we already fetch
 *
 * There is no breakout endpoint. A breakout is a **shape** — a steep approach
 * and a sustained elevation — and the merged Trends response already carries
 * the series the shape is read from, so this tool adds no vendor call of its
 * own beyond the one read it needs. The maths lives in
 * `features/trends/breakoutSignals.ts`, pure and separately tested.
 *
 * ## The two refusals that travel with every answer
 *
 * 1. **A spike that returned is not a breakout.** The verdict needs the
 *    persistence half of the shape: an elevation that lasted two steps is an
 *    event, and a detector that named it would teach its readers to ignore the
 *    third one.
 * 2. **A window shorter than a year has no year-over-year figure.** "Up 40% on
 *    last quarter" is a different claim from "up 40% year over year", and
 *    reporting the short one under the long name is the confident arithmetic
 *    this product refuses. The answer says why instead.
 *
 * ## Two signals are deliberately absent
 *
 * Regional peak offsets and related-query deltas are on the plan's list and
 * **are not computable from this response**: a subregion answer is a
 * whole-period share rather than a series per place, and the related-queries
 * list is a current snapshot rather than a history. The module documents both
 * gaps; a detector that invented those numbers would fail in a way nobody
 * could trace.
 */

const detectorInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe(
      "Terms to read, up to 5. One request is billed the same at one keyword or five, so a batch is free capacity.",
    ),
  type: z
    .enum(["web", "news", "ecommerce"])
    .optional()
    .describe("Which index to read. Defaults to web."),
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
      "A preset window. Ask for at least past_5_years if a year-over-year figure matters to you; shorter windows return the climb and persistence signals only.",
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
  ...dryRunInputSchema,
} as const;

type DetectorArgs = z.infer<z.ZodObject<typeof detectorInputSchema>>;

export const breakoutDetectorTool = {
  name: "breakout_detector",
  config: {
    title: "Which of these terms is breaking out",
    description:
      "Reads the merged Trends series for up to five keywords and reports the breakout shape for each: year-over-year change when the window holds a year, the climb rate into the peak, and how long the elevation held after it. A candidate is called only when the series climbed steeply AND stayed elevated — a two-step spike is reported as the event it is, with the persistence number visible. Shorter-than-a-year windows carry no year-over-year figure rather than a shorter comparison under the same name. Charges credits once per request; dry_run defaults to true.",
    inputSchema: detectorInputSchema,
    outputSchema: z
      .object({
        signals: z.array(
          z.looseObject({
            keyword: z.string(),
            isBreakoutCandidate: z.boolean(),
            yoyChangePercent: z.number().nullable(),
            climbRatePerStep: z.number().nullable(),
            persistenceSteps: z.number().nullable(),
            stillElevated: z.boolean(),
            peakDate: z.string().nullable(),
            summary: z.string(),
          }),
        ),
        caveat: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: DetectorArgs, context) => {
    if (!wantsToSpend(args.dry_run)) {
      return dryRunResponse({
        subject: "this breakout read",
        estimatedCredits: creditsFor(
          DFS_KEYWORDS.dfsTrends.mergedData.perRequest,
        ),
        unitSentence: `USD ${DFS_KEYWORDS.dfsTrends.mergedData.perRequest} per request, DataForSEO Trends merged — one request however many keywords, and the year-over-year signal needs a window of at least a year`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/trends`,
        ),
        structured: {},
      });
    }

    const client = createDataforseoClient(context.billing);
    const items = await client.keywords.trendsMerged({
      keywords: args.keywords,
      type: args.type,
      timeRange: args.timeRange,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      locationCode: args.locationCode ?? context.project.locationCode,
    });

    const byType = new Map(items.map((item) => [item.type ?? "", item]));
    const series = readTrendSeries(byType.get("dataforseo_trends_graph") ?? {});

    // The reader's points carry `dateFrom`, which is what lets the answer name
    // the peak's date; the detector works on the same points, unchanged. Typed
    // by the module's contract so a change to the signal's shape fails this
    // compile rather than quietly reshaping the wire's payload.
    const signals: BreakoutSignal[] = series.map((entry) =>
      breakoutSignals(
        entry.keyword,
        entry.points.map((point) => ({
          date: point.dateFrom ?? "",
          value: point.value,
        })),
      ),
    );

    const candidates = signals.filter((signal) => signal.isBreakoutCandidate);

    return mcpResponse({
      text: [
        candidates.length === 0
          ? `No breakout shape among ${args.keywords.length} keyword${args.keywords.length === 1 ? "" : "s"} in this window. The climb and persistence numbers are below.`
          : `Breakout candidate${candidates.length === 1 ? "" : "s"}: ${candidates.map((signal) => signal.keyword).join(", ")}.`,
        "",
        ...signals.map((signal) => `- ${signal.summary}`),
        "",
        TREND_SCALE_CAVEAT,
      ].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/trends`,
      ),
      structuredContent: {
        signals: signals.map((signal) => ({
          keyword: signal.keyword,
          isBreakoutCandidate: signal.isBreakoutCandidate,
          yoyChangePercent: signal.yoyChangePercent,
          climbRatePerStep: signal.climbRatePerStep,
          persistenceSteps: signal.persistenceSteps,
          stillElevated: signal.stillElevated,
          peakDate: signal.peakDate,
          summary: signal.summary,
        })),
        caveat: TREND_SCALE_CAVEAT,
      },
    });
  }),
};
