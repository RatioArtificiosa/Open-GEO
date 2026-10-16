import { z } from "zod";
import {
  type CouncilMemoInput,
  renderCouncilMemo,
} from "@/server/features/memos/councilMemo";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

/**
 * Weekly GEO Council Memo (CL-508): what changed, what it means, top-3
 * fixes, impact, cost — rendered from data the caller already keeps.
 *
 * Pure composition: no vendor call, no credits, nothing to dry-run. Every
 * section has an explicit empty state (unwatched is not calm, an empty fix
 * list is not an all-clear, unmetered spend is unknown and never zero), and
 * every number travels with the period it was measured over. Branding lives
 * with the caller; this tool owns the honesty.
 */

const memoInputSchema = {
  projectId: projectIdSchema,
  brand: z.string().min(1).describe("Brand name for the memo header."),
  periodFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Window start, yyyy-mm-dd."),
  periodTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Window end, yyyy-mm-dd."),
  citationChanges: z
    .array(
      z.object({
        subject: z.string(),
        direction: z.enum(["gained", "lost"]),
        count: z.number().int().nonnegative().nullable(),
      }),
    )
    .describe("Citation movements, null counts where unmeasured.")
    .default([]),
  topFixes: z
    .array(
      z.object({
        action: z.string(),
        reason: z.string(),
        impact: z.string().nullable(),
      }),
    )
    .describe("Candidate fixes; impact null when unestimated.")
    .default([]),
  spendUsd: z
    .number()
    .nonnegative()
    .nullable()
    .describe("Vendor spend over the period, or null when unmetered."),
  forecastsScored: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Kept forecasts scored since the last memo, or null."),
} as const;

type MemoArgs = z.infer<z.ZodObject<typeof memoInputSchema>>;

export const councilMemoTool = {
  name: "council_memo",
  config: {
    title: "Write the weekly GEO council memo",
    description:
      "Renders a client memo from supplied period data: citation movements with direction, what the net movement means, top three fixes ordered by estimated impact, and spend plus scored forecasts with honest empty states throughout. Unwatched inputs report as unmeasured, never as good news. Pure composition — no vendor call, no credits, nothing to dry-run.",
    inputSchema: memoInputSchema,
    outputSchema: z
      .object({
        markdown: z.string(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: MemoArgs, context) => {
    // Typed by the module's contract: a change to the memo's inputs fails
    // this compile rather than arriving as a silent difference between what
    // the tool accepts and what the module reads.
    const input: CouncilMemoInput = {
      brand: args.brand,
      periodFrom: args.periodFrom,
      periodTo: args.periodTo,
      citationChanges: args.citationChanges,
      topFixes: args.topFixes,
      spendUsd: args.spendUsd,
      forecastsScored: args.forecastsScored,
    };
    const markdown = renderCouncilMemo(input);
    return mcpResponse({
      text: markdown,
      structuredContent: { markdown },
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
    });
  }),
};
