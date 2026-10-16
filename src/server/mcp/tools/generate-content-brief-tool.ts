import { z } from "zod";
import {
  buildContentBrief,
  CONTENT_BRIEF_VERSION,
  type ContentBrief,
} from "@/server/features/content/contentBrief";
import { whatToBuild } from "@/server/features/content/whatToBuild";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { candidateSchema } from "@/server/mcp/tools/what-to-build-tool";

/**
 * Generate a machine content brief (CL-725 vendor-free half).
 *
 * Pure assembly over a supplied candidate — no vendor call, no credits,
 * nothing to dry-run (the same precedent `what_to_build` documents: a
 * dry_run on a call that cannot spend is a control that controls nothing).
 * The brief carries the diagnosis it was built from: formats, score with
 * version, reason verbatim, competitors named. The machine-outline slot
 * stays null until the funding-day `generate_sub_topics` call fills it —
 * an explicit absence, never a fabricated outline.
 */

const inputSchema = {
  projectId: projectIdSchema,
  candidate: candidateSchema.describe(
    "The gap keyword with its evidence: volume, difficulty, intent, SERP elements, competitors.",
  ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const generateContentBriefTool = {
  name: "generate_content_brief",
  config: {
    title: "Generate a machine content brief",
    description:
      "Turns one content-gap candidate into a sourced brief: eligible formats in order, sections each naming their source (format rule, competitor gap, SERP evidence), the diagnosis verbatim. Pure assembly over supplied evidence — no vendor call, no credits. The machine outline (sub-topics) fills on the funding-day vendor call; until then the slot is explicitly empty.",
    inputSchema,
    outputSchema: z.looseObject({
      brief: looseObjectOutputSchema,
      unpricedReason: z.string().nullable().optional(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const { build, unpriced } = whatToBuild([
      {
        keyword: args.candidate.keyword,
        volume: args.candidate.volume,
        keywordDifficulty: args.candidate.keywordDifficulty,
        serpCompetitors: args.candidate.serpCompetitors,
        intent: args.candidate.intent,
        aiNativeRatio: args.candidate.aiNativeRatio,
        rankElasticity: args.candidate.rankElasticity,
        trendFactor: args.candidate.trendFactor,
        etv: args.candidate.etv,
        serpElements: args.candidate.serpElements,
        competitorDomains: args.candidate.competitorDomains,
      },
    ]);
    const top = build[0];
    if (!top) {
      const reason = unpriced[0]?.reason ?? "the candidate could not be priced";
      return mcpResponse({
        text: `No brief for '${args.candidate.keyword}': ${reason}. An unpriced keyword gets no outline rather than a guessed one.`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { brief: null, unpricedReason: reason },
      });
    }
    const brief: ContentBrief = buildContentBrief(top);
    const lines = [
      `Brief for '${brief.keyword}' (machine ${CONTENT_BRIEF_VERSION}, score ${brief.score}):`,
      ...brief.sections.map(
        (section) => `  [${section.source}] ${section.heading}`,
      ),
      `Diagnosis carried verbatim: ${brief.diagnosis}`,
      "Machine outline (sub-topics): empty until the funding-day vendor call fills it.",
    ];
    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { brief, unpricedReason: null },
    });
  }),
};
