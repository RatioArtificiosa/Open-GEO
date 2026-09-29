import { z } from "zod";
import { GeoService } from "@/server/features/geo/services/GeoService";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
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
 * The GEO read tools.
 *
 * Every one reads the OpenGeo archive rather than running a fresh vendor query,
 * so they cost nothing and return what was actually recorded. The honesty rules
 * are in `geo-shared.ts`; the short version is that nothing here ever combines
 * two platforms into one number, and an unavailable capability is stated rather
 * than returned as an empty success.
 */

// ---------------------------------------------------------------------------
// list_geo_targets — the entry point the others depend on
// ---------------------------------------------------------------------------

const listTargetsInputSchema = {
  projectId: projectIdSchema,
} as const;

type ListTargetsArgs = z.infer<z.ZodObject<typeof listTargetsInputSchema>>;

export const listGeoTargetsTool = {
  name: "list_geo_targets",
  config: {
    title: "List monitored AI brands",
    description:
      "The brands OpenGeo is tracking AI visibility for in this project. Start here: the other GEO tools read the archive for one of these, they do not run a fresh search.",
    inputSchema: listTargetsInputSchema,
    outputSchema: z
      .object({
        targets: z
          .array(
            z
              .object({
                domain: z.string(),
                name: z.string(),
                locationCode: z.number(),
                languageCode: z.string(),
              })
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
  handler: withMcpProjectAuth(async (args: ListTargetsArgs, context) => {
    const targets = await GeoSetupRepository.listTargets(args.projectId);
    return mcpResponse({
      text:
        targets.length === 0
          ? "No brands are being monitored in this project yet. Add one in OpenGeo to start building an AI-visibility archive."
          : [
              `${targets.length} monitored brand(s):`,
              ...targets.map(
                (target) =>
                  `  ${target.domain} (${target.name}) — market ${target.locationCode}/${target.languageCode}`,
              ),
            ].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
      ),
      structuredContent: {
        targets: targets.map((target) => ({
          id: target.id,
          domain: target.domain,
          name: target.name,
          locationCode: target.locationCode,
          languageCode: target.languageCode,
        })),
      },
    });
  }),
};

// ---------------------------------------------------------------------------
// get_geo_visibility
// ---------------------------------------------------------------------------

const visibilityInputSchema = {
  projectId: projectIdSchema,
  domain: geoDomainSchema,
  platforms: z
    .array(geoPlatformSchema)
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Platforms to report. Omit for all four. Each is reported separately and must not be summed: Google AI Overviews and ChatGPT compute demand differently.",
    ),
  since: z
    .string()
    .datetime()
    .optional()
    .describe(
      "ISO timestamp. Defaults to the last 30 days. Counts archived answers in that window.",
    ),
} as const;

type VisibilityArgs = z.infer<z.ZodObject<typeof visibilityInputSchema>>;

export const getGeoVisibilityTool = {
  name: "get_geo_visibility",
  config: {
    title: "Get AI visibility",
    description:
      "Is this brand mentioned in AI answers, and how often? Reads the OpenGeo archive, so it costs nothing and returns what was actually recorded. Returns ONE figure per platform and never a combined total, because the platforms compute demand differently. Follow with get_geo_citation_gap to find out WHY a brand is absent — usually the more actionable answer.",
    inputSchema: visibilityInputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        since: z.string().optional(),
        perPlatform: z
          .array(
            z
              .object({ platform: z.string(), archivedAnswers: z.number() })
              .passthrough(),
          )
          .optional(),
        caveat: z.string().optional(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: VisibilityArgs, context) => {
    const target = await findGeoTarget(args.projectId, args.domain);
    if (!target) {
      return mcpResponse({
        text: `${args.domain} is not a monitored target in this project. Add it in OpenGeo first: visibility reads the archive, it does not run a fresh search.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
      });
    }

    const result = await GeoService.getVisibility({
      projectId: args.projectId,
      targetId: target.id,
      platforms: args.platforms,
    });

    return mcpResponse({
      text: [
        `Target: ${target.domain} (${target.name})`,
        `Archived answers since ${result.since.slice(0, 10)} — one figure per platform, reported separately:`,
        ...result.perPlatform.map(
          (entry) =>
            `  ${entry.platform}: ${entry.recent.length} archived answer(s)`,
        ),
        "",
        "Demand figures are NOT summed across platforms: Google AI Overviews and ChatGPT compute them differently.",
        "Next: get_geo_citation_gap explains which of your pages are retrieved but never cited.",
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
        since: result.since,
        perPlatform: result.perPlatform.map((entry) => ({
          platform: entry.platform,
          archivedAnswers: entry.recent.length,
          mentions: entry.mentions,
        })),
        caveat:
          "Per-platform figures only. Google AI Overviews and ChatGPT compute ai_search_volume differently and must never be combined.",
      },
    });
  }),
};

// ---------------------------------------------------------------------------
// get_geo_answer_history
// ---------------------------------------------------------------------------

const answerHistoryInputSchema = {
  projectId: projectIdSchema,
  domain: geoDomainSchema,
  platform: geoPlatformSchema,
  prompt: z
    .string()
    .min(1)
    .max(700)
    .describe(
      "The exact question, e.g. 'best geo optimization tool'. Returns every archived answer for that prompt, newest first.",
    ),
  limit: z.number().int().min(1).max(200).optional(),
} as const;

type AnswerHistoryArgs = z.infer<z.ZodObject<typeof answerHistoryInputSchema>>;

export const getGeoAnswerHistoryTool = {
  name: "get_geo_answer_history",
  config: {
    title: "How an AI answer changed over time",
    description:
      "Every archived answer to one prompt, newest first. This is how you answer 'did the model change its mind about us?' — compare two runs of the same question. Answers are stored verbatim, so quote them rather than paraphrasing.",
    inputSchema: answerHistoryInputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        answers: z
          .array(
            z
              .object({ answeredAt: z.string(), prompt: z.string() })
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
  handler: withMcpProjectAuth(async (args: AnswerHistoryArgs, context) => {
    const target = await findGeoTarget(args.projectId, args.domain);
    if (!target) {
      return mcpResponse({
        text: `${args.domain} is not a monitored target in this project.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
      });
    }

    const answers = await GeoService.listAnswerHistory({
      projectId: args.projectId,
      prompt: args.prompt,
      platform: args.platform,
      limit: args.limit,
    });

    return mcpResponse({
      text: [
        `${answers.length} archived answer(s) to "${args.prompt}" on ${args.platform}, newest first:`,
        ...answers.map(
          (answer) =>
            `  ${answer.answeredAt} — ${answer.answerText ?? "(no answer body recorded; citations only)"}`,
        ),
        "",
        answers.length < 2
          ? "Only one capture so far, so there is nothing to diff yet. The archive grows with each patrol."
          : "Compare consecutive entries: a changed citation set or a changed recommendation is the finding worth acting on.",
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
        platform: args.platform,
        answers: answers.map((answer) => ({
          id: answer.id,
          answeredAt: answer.answeredAt,
          prompt: answer.prompt,
          answerText: answer.answerText,
          modelName: answer.modelName,
        })),
      },
    });
  }),
};
