import { z } from "zod";
import {
  type BuildCandidate,
  type BuildRecommendation,
  type UnpricedCandidate,
  whatToBuild,
} from "@/server/features/content/whatToBuild";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

/**
 * What to Build (CL-717): content gaps ranked into a build list.
 *
 * ## Pure ranking over supplied candidates — no vendor call
 *
 * The reads behind a brief (intersection gaps, intent labels, SERP elements,
 * volume/KD/trend/ETV) are billed by the tools that produce them, each with
 * its own dry_run. This tool spends nothing itself: it ranks what the agent
 * already holds. A dry_run parameter on a call that cannot spend would be a
 * control that controls nothing, so there is none — the description states
 * the freeness instead, where a reviewer reads it.
 *
 * ## What the ranking refuses
 *
 * Unmeasurable keywords are listed as unpriced (never zero, never dropped);
 * unknown intent excludes formats (never defaults to guides for a buyer); the
 * SERP-element winner leads the eligible set; ties break on ETV, never on
 * input order. The module documents each refusal; this tool reports them.
 */

const candidateSchema = z
  .object({
    keyword: z.string().min(1).describe("The gap keyword to price."),
    volume: z
      .number()
      .nonnegative()
      .nullable()
      .describe("Monthly search volume, or null when unmeasured."),
    keywordDifficulty: z.number().min(0).max(100).describe("KD 0–100."),
    serpCompetitors: z
      .number()
      .int()
      .nonnegative()
      .describe("How many results the SERP returned."),
    intent: z
      .enum([
        "informational",
        "commercial",
        "transactional",
        "navigational",
        "unknown",
      ])
      .describe("Vendor intent label; unknown excludes formats."),
    aiNativeRatio: z
      .number()
      .min(0)
      .max(1)
      .describe("Share of the SERP that is AI-native, 0–1."),
    rankElasticity: z
      .number()
      .min(0)
      .max(1)
      .describe("How much rank moves per effort, 0–1."),
    trendFactor: z
      .number()
      .min(0)
      .max(2)
      .nullable()
      .describe("Recent direction multiplier, 1 is flat, null when unknown."),
    etv: z.number().nullable().describe("ETV for context and tiebreaks."),
    serpElements: z
      .array(z.string())
      .describe("SERP element types observed, e.g. video, people_also_ask.")
      .default([]),
    competitorDomains: z
      .array(z.string())
      .describe("Competitor domains already covering it.")
      .default([]),
  })
  .passthrough();

const buildInputSchema = {
  projectId: projectIdSchema,
  candidates: z
    .array(candidateSchema)
    .min(1)
    .max(50)
    .describe("Gap keywords with their reads, 1–50 per call."),
} as const;

type BuildArgs = z.infer<z.ZodObject<typeof buildInputSchema>>;

export const whatToBuildTool = {
  name: "what_to_build",
  config: {
    title: "What content to build next, ranked",
    description:
      "Ranks content-gap keywords into a build list: each candidate's intent decides the eligible formats, observed SERP elements pick the winner inside them, the opportunity scorer prices the bet, and volume times trend orders the list. Keywords with no measured volume are listed as unpriced rather than zero; unknown intent excludes formats rather than defaulting. Pure ranking over supplied candidates — no vendor call, no credits, nothing to dry-run.",
    inputSchema: buildInputSchema,
    outputSchema: z
      .object({
        build: z.array(
          z.looseObject({
            keyword: z.string(),
            formats: z.array(z.string()),
            score: z.number(),
            scoreVersion: z.string(),
            reason: z.string(),
          }),
        ),
        unpriced: z.array(
          z.looseObject({
            keyword: z.string(),
            reason: z.string(),
          }),
        ),
        caveat: z.string(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: BuildArgs, context) => {
    const ranked: {
      build: BuildRecommendation[];
      unpriced: UnpricedCandidate[];
    } = whatToBuild(
      args.candidates.map(
        (entry): BuildCandidate => ({
          keyword: entry.keyword,
          volume: entry.volume,
          keywordDifficulty: entry.keywordDifficulty,
          serpCompetitors: entry.serpCompetitors,
          intent: entry.intent,
          aiNativeRatio: entry.aiNativeRatio,
          rankElasticity: entry.rankElasticity,
          trendFactor: entry.trendFactor,
          etv: entry.etv,
          serpElements: entry.serpElements,
          competitorDomains: entry.competitorDomains,
        }),
      ),
    );
    return mcpResponse({
      text: ranked.build
        .map(
          (entry, index) =>
            `${index + 1}. ${entry.keyword} — score ${entry.score} — ${entry.formats.join("/")}: ${entry.reason}`,
        )
        .concat(
          ranked.unpriced.map(
            (entry) => `Unpriced: ${entry.keyword} — ${entry.reason}.`,
          ),
        )
        .join("\n"),
      structuredContent: {
        ...ranked,
        caveat:
          "Ranked from the candidates supplied: scores compare within this call only, unpriced entries were not measured (not zero), and formats follow the intent table — unknown intent advises nothing.",
      },
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
    });
  }),
};
