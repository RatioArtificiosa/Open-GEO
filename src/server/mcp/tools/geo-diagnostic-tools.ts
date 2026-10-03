import { z } from "zod";
import { GeoService } from "@/server/features/geo/services/GeoService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  findGeoTarget,
  geoDomainSchema,
  geoPlatformSchema,
  metaOnlyOutputFields,
} from "@/server/mcp/tools/geo-shared";

/**
 * The GEO diagnostic tools: the citation gap and the run history.
 *
 * The citation gap is the one this product exists to surface. A page a model
 * retrieved, read, and then did not cite is a *directness* problem, not a volume
 * problem — and the difference between those two diagnoses is the whole value of
 * the product over a mention counter.
 */

// ---------------------------------------------------------------------------
// get_geo_citation_gap
// ---------------------------------------------------------------------------

const citationGapInputSchema = {
  projectId: projectIdSchema,
  domain: geoDomainSchema,
  platform: geoPlatformSchema.describe(
    "Which platform. The retrieved-but-uncited gap is available for chat_gpt only: DataForSEO returns citations for Google AI Overviews but not the pages Google retrieved.",
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum pages to return. Default 100."),
} as const;

type CitationGapArgs = z.infer<z.ZodObject<typeof citationGapInputSchema>>;

export const getGeoCitationGapTool = {
  name: "get_geo_citation_gap",
  config: {
    title: "Get the AI citation gap",
    description:
      "Which of your pages does an AI model retrieve but then refuse to cite? Usually the most actionable GEO signal available. Available for chat_gpt only — for other platforms the response states why the data does not exist rather than returning an empty list.",
    inputSchema: citationGapInputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        retrievalAvailable: z.boolean().optional(),
        reason: z.string().optional(),
        gaps: z
          .array(
            z
              .object({ url: z.string(), rank: z.number().nullable() })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CitationGapArgs, context) => {
    const target = await findGeoTarget(args.projectId, args.domain);
    if (!target) {
      return mcpResponse({
        text: `${args.domain} is not a monitored target in this project, so there is no retrieval archive for it.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
      });
    }

    const result = await GeoService.getCitationGap({
      projectId: args.projectId,
      targetId: target.id,
      platform: args.platform,
      limit: args.limit,
    });

    // The unavailable case is reported, never rendered as an empty success.
    if (!result.retrievalAvailable) {
      return mcpResponse({
        text: [
          `Citation gap unavailable for ${result.platform}.`,
          result.reason,
          "",
          // **This used to name a tool that does not exist.** It said to use the
          // AI Mode query tool to see what the platform *did* cite — and there is
          // no such tool, because the AI Mode monitor has no runner at all: the
          // planner is tested and uncalled, and the only two functions that touch
          // the `ai_mode_snapshots` table are declared and never invoked.
          //
          // An agent reading the old text would call a tool that is not
          // registered, get a protocol error, and report that the tool was broken
          // — so the cost of the sentence was not confusion but a **false bug
          // report against our own server**.
          //
          // The first repair named a different tool that does not exist either.
          // The registered GEO set is `get_geo_citation_gap`, `get_geo_runs`,
          // `get_geo_visibility`, `get_geo_visibility_forecast`,
          // `get_geo_answer_history` and `get_geo_top_citations`, and replacing
          // one invented name with another
          // would have been the same defect wearing a different word. So the
          // sentence now names **no tool** and states the absence, which cannot be
          // wrong — and it cannot spell the old name either, because
          // `scripts/acquisition-mode-gate.test.ts` scans this file and would flag
          // the comment for containing it.
          //
          // The same false claim was fixed in `GeoPatrol`'s run-log note, where it
          // said a platform "is collected by the AI Mode monitor". **A claim about
          // a capability has to be true in every surface that makes it**, and
          // there were two.
          "We do not collect Google AI Overview citations, so no tool reports which pages it cited. What we do hold is in get_geo_visibility_forecast and get_geo_answer_history.",
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
          {
            domain: target.domain,
          },
        ),
        structuredContent: {
          domain: target.domain,
          platform: result.platform,
          retrievalAvailable: false,
          reason: result.reason,
          gaps: [],
        },
      });
    }

    const gaps = result.gaps;
    return mcpResponse({
      text: [
        `Citation gap for ${target.domain} on ${result.platform}: ${gaps.length} page(s) retrieved but never cited.`,
        ...gaps.slice(0, 25).map((gap) => `  ${gap.url}`),
        ...(gaps.length > 25 ? [`  ...and ${gaps.length - 25} more`] : []),
        "",
        "A retrieved-but-uncited page is a DIRECTNESS problem, not a volume problem: the model read it and did not use it. Restructure the answer to lead with a direct response rather than publishing more content.",
      ].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
        {
          domain: target.domain,
        },
      ),
      structuredContent: {
        domain: target.domain,
        platform: result.platform,
        retrievalAvailable: true,
        gaps: gaps.map((gap) => ({ url: gap.url, rank: gap.rank })),
      },
    });
  }),
};

// ---------------------------------------------------------------------------
// get_geo_runs
// ---------------------------------------------------------------------------

const runsInputSchema = {
  projectId: projectIdSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("How many runs to return, newest first. Default 25."),
} as const;

type RunsArgs = z.infer<z.ZodObject<typeof runsInputSchema>>;

export const getGeoRunsTool = {
  name: "get_geo_runs",
  config: {
    title: "List AI monitoring runs",
    description:
      "The patrol runs that built this project's AI-visibility archive, newest first. Use it to confirm monitoring is actually happening and when the last data was collected.",
    inputSchema: runsInputSchema,
    outputSchema: z
      .object({
        runs: z
          .array(
            z
              .object({ startedAt: z.string(), status: z.string() })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: RunsArgs, context) => {
    const runs = await GeoService.listRuns(args.projectId, args.limit);
    return mcpResponse({
      text:
        runs.length === 0
          ? "No monitoring runs recorded yet. The nightly patrol creates the first one; until then the archive is empty."
          : [
              `${runs.length} monitoring run(s), newest first:`,
              ...runs.map(
                (run) =>
                  `  ${run.startedAt} — ${run.status} (by ${run.createdBy})`,
              ),
            ].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
      ),
      structuredContent: {
        runs: runs.map((run) => ({
          id: run.id,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          status: run.status,
          createdBy: run.createdBy,
        })),
      },
    });
  }),
};
