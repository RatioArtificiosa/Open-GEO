import { z } from "zod";
import { GeoService } from "@/server/features/geo/services/GeoService";
import { AppError } from "@/server/lib/errors";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  findGeoTarget,
  geoDomainSchema,
  metaOnlyOutputFields,
} from "@/server/mcp/tools/geo-shared";

/**
 * get_geo_top_citations - which domains AI answers cite most for a brand, per
 * platform, from the most recent monitoring run. It reads the archive like the
 * other GEO read tools, so it costs nothing, and its honesty rules are the same
 * as theirs: no combined per-platform number, no invented empty success.
 */

// ---------------------------------------------------------------------------
// get_geo_top_citations
// ---------------------------------------------------------------------------

const topCitationsInputSchema = {
  projectId: projectIdSchema,
  domain: geoDomainSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum domains to return per platform. Default 50."),
} as const;

type TopCitationsArgs = z.infer<z.ZodObject<typeof topCitationsInputSchema>>;

export const getGeoTopCitationsTool = {
  name: "get_geo_top_citations",
  config: {
    title: "Top cited domains",
    description:
      "Which domains AI answers cite most for this brand, per platform, from the most recent monitoring run. Reads the archive rather than running a fresh vendor query, so it costs nothing.",
    inputSchema: topCitationsInputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        platforms: z
          .array(
            z
              .object({
                platform: z.string(),
                snapshotId: z.string(),
                domains: z
                  .array(
                    z
                      .object({
                        domain: z.string(),
                        mentions: z.number(),
                        aiSearchVolume: z.number().nullable().optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),
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
  handler: withMcpProjectAuth(async (args: TopCitationsArgs, context) => {
    const target = await findGeoTarget(args.projectId, args.domain);
    if (!target) {
      return mcpResponse({
        text: `${args.domain} is not a monitored target in this project, so there is no citation archive for it.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
      });
    }

    let profile: Awaited<ReturnType<typeof GeoService.getCitationProfile>>;
    try {
      profile = await GeoService.getCitationProfile({
        projectId: args.projectId,
        domain: target.domain,
        limit: args.limit,
      });
    } catch (error) {
      // The profile reader throws NOT_FOUND when the target is gone; the message
      // is written for a human, so it is safe and honest to hand back verbatim.
      if (error instanceof AppError) {
        return mcpResponse({
          text: error.message,
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/geo`,
          ),
        });
      }
      throw error;
    }

    return mcpResponse({
      text:
        profile.length === 0
          ? `No citation archive yet for ${target.domain}: the nightly patrol will populate it after the first run.`
          : [
              `Top cited domains for ${target.domain}, per platform (mention counts are never summed across platforms):`,
              ...profile.map(
                (entry) =>
                  `${entry.platform}: ${
                    entry.domains.length === 0
                      ? "no citations recorded"
                      : entry.domains
                          .slice(0, 5)
                          .map((d) => `${d.domain} (${d.mentions})`)
                          .join(", ")
                  }`,
              ),
            ].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
        { domain: target.domain },
      ),
      structuredContent: {
        domain: target.domain,
        platforms: profile,
      },
    });
  }),
};
