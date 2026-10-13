import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  categoryMomentum,
  readCategoryTrend,
} from "@/server/features/trends/categoryMomentum";
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
 * `category_momentum` — is an industry's interest rising, cooling, or flat, with
 * no seed keyword.
 *
 * ## What it unlocks
 *
 * `google_trends/explore` takes a `category_code` with **no keywords**, so a
 * whole industry can be read before anyone knows which terms to track. The
 * product sentence is *"CRM is cooling; AI-visibility is accelerating"*, and the
 * verdict is the answer to it — with the two refusals that keep it honest
 * attached, because a direction called from noise is worse than no direction.
 *
 * ## What the verdict will not do
 *
 * 1. **A spike cannot carry it.** The level shift is a **median** of two halves
 *    of the window, not a mean: two enormous points at the end of a flat window
 *    move a mean far past any margin while leaving the median where it was, and
 *    the verdict named from that mean would be a climb two points long.
 * 2. **A shifted level that is already falling is not acceleration.** The
 *    verdict needs the recent half's *own* slope to agree in sign, so "elevated
 *    and turning" reads as steady, with the level shift visible in the numbers
 *    rather than hidden.
 * 3. **A category is compared with its own past, never with another category's
 *    level.** Scores inside one request are normalised to that request's own
 *    peak, so two categories' momentum is comparable and their scores never
 *    are. The caveat travels with every answer.
 *
 * ## The cost
 *
 * One task per request, billed the same whether the request carries keywords or
 * only a category. `dry_run` quotes it without spending.
 */

const momentumInputSchema = {
  projectId: projectIdSchema,
  categoryCode: z
    .number()
    .int()
    .positive()
    .describe(
      "A Google Trends category code from the vendor's categories list — a positive whole number. Ask for the industry's trend without naming any keyword.",
    ),
  type: z
    .enum(["web", "news", "youtube", "images", "froogle"])
    .optional()
    .describe("Which index to read. Defaults to web."),
  timeRange: z
    .enum([
      "past_hour",
      "past_4_hours",
      "past_day",
      "past_7_days",
      "past_30_days",
      "past_90_days",
      "past_12_months",
      "past_5_years",
      "2004_present",
      "2008_present",
    ])
    .optional()
    .describe(
      "A preset window. Longer windows give the verdict more points; the floor for a direction is six. Cannot be combined with dateFrom/dateTo.",
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
  languageCode: z
    .string()
    .optional()
    .describe("Language code for the category's own naming; defaults to en."),
  ...dryRunInputSchema,
} as const;

type MomentumArgs = z.infer<z.ZodObject<typeof momentumInputSchema>>;

export const categoryMomentumTool = {
  name: "category_momentum",
  config: {
    title: "Is this industry rising, cooling, or flat",
    description:
      "Reads a whole industry's interest from Google Trends by category, with no seed keyword, and calls the direction: accelerating, cooling, or steady. The verdict rests on the median of two halves of the window rather than a mean, so a two-point spike cannot carry it, and on the recent half's own slope, so a level that shifted up and is already falling reads as steady rather than accelerating. Fewer than six measured points produces no direction rather than a flat one. Scores are normalised to this request's own peak, so a category is compared with its own past and never with another category's level. Charges credits once per request; dry_run defaults to true.",
    inputSchema: momentumInputSchema,
    outputSchema: z
      .object({
        categoryCode: z.number(),
        direction: z
          .enum(["accelerating", "steady", "cooling"])
          .nullable()
          .describe("Null when the window cannot support a verdict."),
        changePercent: z
          .number()
          .nullable()
          .describe(
            "The recent half's median above the earlier half's, as a percentage.",
          ),
        slopePerStep: z.number().nullable(),
        recentSlopePerStep: z.number().nullable(),
        pointsMeasured: z.number(),
        summary: z.string(),
        basis: z.string(),
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
  handler: withMcpProjectAuth(async (args: MomentumArgs, context) => {
    if (!wantsToSpend(args.dry_run)) {
      return dryRunResponse({
        subject: "this category momentum read",
        estimatedCredits: creditsFor(
          DFS_KEYWORDS.googleTrends.standard.perRequest,
        ),
        unitSentence: `USD ${DFS_KEYWORDS.googleTrends.standard.perRequest} per request — one task, whether the request carries keywords or only a category`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structured: {},
      });
    }

    const client = createDataforseoClient(context.billing);
    const graph = await client.keywords.googleTrendsExplore({
      categoryCode: args.categoryCode,
      type: args.type,
      timeRange: args.timeRange,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      locationCode: args.locationCode ?? context.project.locationCode,
      languageCode: args.languageCode,
    });

    const momentum = categoryMomentum(readCategoryTrend(graph[0] ?? {}));

    const lines = [
      `Category momentum (category ${args.categoryCode}):`,
      "",
      momentum.summary,
    ];
    if (momentum.changePercent !== null) {
      lines.push(
        "",
        `Level shift ${momentum.changePercent.toFixed(1)}% (recent half's median against the earlier half's), recent slope ${(momentum.recentSlopePerStep ?? 0).toFixed(2)} points per step, whole-window slope ${(momentum.slopePerStep ?? 0).toFixed(2)}.`,
      );
    }
    lines.push("", momentum.caveat);

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: {
        categoryCode: args.categoryCode,
        direction: momentum.direction,
        changePercent:
          momentum.changePercent === null
            ? null
            : Number(momentum.changePercent.toFixed(1)),
        slopePerStep: momentum.slopePerStep,
        recentSlopePerStep: momentum.recentSlopePerStep,
        pointsMeasured: momentum.pointsMeasured,
        summary: momentum.summary,
        basis: momentum.basis,
        caveat: momentum.caveat,
      },
    });
  }),
};
