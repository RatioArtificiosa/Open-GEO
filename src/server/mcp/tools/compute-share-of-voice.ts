import { z } from "zod";
import { getBrandLookup } from "@/server/features/ai-search/services/brandLookup";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { resolveLabsMarket } from "@/shared/keyword-locations";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";

/**
 * Share of Voice, as an MCP tool.
 *
 * This exists because the `geo-audit` skill instructs an agent to call
 * `compute_share_of_voice(...)` and **no such tool existed** — `computeShareOfVoice`
 * is a server-side function the UI calls, never exposed over the wire. An agent
 * following the skill would have got a tool-not-found on step one of an audit it
 * is told is the highest-value output.
 *
 * **What may and may not be combined across platforms.** The rule is units, not
 * arithmetic:
 *
 * - **Mentions may be summed.** A mention is a mention — both platforms count the
 *   same kind of event — so a share-of-voice leaderboard over mentions is a
 *   meaningful cross-platform comparison. The service does this, and the response
 *   names the platforms it summed so a reader knows what the number covers.
 * - **Demand may not.** Google's `ai_search_volume` is real search volume;
 *   ChatGPT's is People-Also-Ask modelled. We measured 12,621,380 against 63,850
 *   for one keyword, a ~198× ratio, so any total of the two is a confident wrong
 *   number. That is why this tool returns **no volume figure at all** — the
 *   honest move is to omit a metric rather than offer it with a caveat.
 *
 * **Null is not zero.** A brand the vendor returned no item for is "no data" and
 * is excluded from the denominator; a brand with a recorded zero is known-zero
 * and counts. Collapsing the two is how a brand vanishes from a leaderboard the
 * user paid to compare it on.
 *
 * `dry_run` is honoured, and it defaults to **true**: this fans out to several
 * billable DataForSEO calls, so the cheap, safe behaviour is the default and
 * spending the user's credits is the deliberate choice.
 */

const inputSchema = {
  projectId: projectIdSchema,
  target: z
    .string()
    .min(1)
    .max(255)
    .describe("The brand or domain to measure, e.g. 'acme.com'."),
  competitors: z
    .array(z.string().min(1).max(255))
    .min(1)
    .max(9)
    .describe(
      "Competitors to compare against, 1 to 9. Each is sent as its own aggregation group, so more competitors means more paid calls.",
    ),
  locationCode: z.number().int().optional(),
  languageCode: z.string().optional(),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "When true (the default) returns the estimated cost and competitor plan without calling the vendor. Set false to actually spend credits.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const computeShareOfVoiceTool = {
  name: "compute_share_of_voice",
  config: {
    title: "Compute share of voice",
    description:
      "Compare a brand against up to 9 competitors in AI answers. Returns a share-of-voice leaderboard over MENTIONS, which are comparable across platforms and are summed, and the platforms it summed are named. Returns no demand figure: Google's search volume and ChatGPT's People-Also-Ask model are different units and must never be added. Costs credits (one comparison per platform). Set dry_run=false to run it; the default is a free plan.",
    inputSchema,
    outputSchema: z
      .object({
        target: z.string().optional(),
        dryRun: z.boolean().optional(),
        competitors: z.array(z.string()).optional(),
        estimatedCalls: z.number().optional(),
        // The platforms whose mentions were summed. Named so a reader knows what
        // the leaderboard covers — and so an agent cannot present it as a
        // per-platform figure it is not.
        platformsSummed: z.array(z.string()).optional(),
        entries: z
          .array(
            z
              .object({
                label: z.string(),
                isTarget: z.boolean(),
                mentions: z.number().nullable(),
                sharePct: z.number().nullable(),
              })
              .passthrough(),
          )
          .optional(),
        note: z.string().optional(),
      })
      .passthrough(),
    annotations: {
      // It spends credits, so it is not read-only. It deletes nothing, and it
      // cannot change anything outside the user's own project.
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const { locationCode, languageCode } = resolveLabsMarket(
      { locationCode: args.locationCode, languageCode: args.languageCode },
      context.project,
    );
    assertLabsLocationCode(locationCode);
    assertLanguageForLocation(locationCode, languageCode);

    // Two platforms, each needing one call per competitor-set. The brand lookup
    // runs both platforms itself, so the multiplier is the platform count, not
    // the competitor count.
    const estimatedCalls = 2;

    if (args.dry_run !== false) {
      return mcpResponse({
        text: [
          `Dry run — nothing was called and no credits were spent.`,
          `Target: ${args.target}`,
          `Competitors: ${args.competitors.join(", ")}`,
          `Market: ${locationCode}/${languageCode}`,
          `Estimated DataForSEO calls: ~${estimatedCalls} (one per platform).`,
          `Re-run with dry_run: false to actually spend credits.`,
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/brand-lookup`,
        ),
        structuredContent: {
          target: args.target,
          dryRun: true,
          competitors: args.competitors,
          estimatedCalls,
        },
      });
    }

    const result = await getBrandLookup(
      {
        projectId: args.projectId,
        query: args.target,
        competitors: args.competitors,
        locationCode,
        languageCode,
      },
      context.billing,
    );

    const share = result.shareOfVoice;
    const entries = share?.entries ?? [];
    const platformsSummed = share?.platforms ?? [];

    const lines = entries.length
      ? entries.map(
          (entry) =>
            `  ${entry.isTarget ? "*" : " "} ${entry.label}: ${entry.mentions ?? "no data"}${
              entry.sharePct === null
                ? " (share unknown)"
                : ` — ${entry.sharePct.toFixed(1)}%`
            }`,
        )
      : [
          "No share-of-voice data was returned.",
          "That usually means every comparison call failed, or the vendor has no",
          "AI-answer data for this brand yet. It is not a zero share.",
        ];

    return mcpResponse({
      text: [
        `Share of voice for ${result.resolvedTarget} in ${locationCode}/${languageCode}:`,
        ...lines,
        "",
        `Mentions summed across ${platformsSummed.join(" and ") || "no platform"}.`,
        "A brand with no data is excluded from the denominator, not counted as zero.",
        "No demand figure is shown: Google's search volume and ChatGPT's",
        "People-Also-Ask model are different units and must never be added.",
      ].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
        { domain: result.resolvedTarget },
      ),
      structuredContent: {
        target: result.resolvedTarget,
        dryRun: false,
        platformsSummed,
        entries: entries.map((entry) => ({
          label: entry.label,
          isTarget: entry.isTarget,
          mentions: entry.mentions,
          sharePct: entry.sharePct,
        })),
        note: "Mentions are comparable across platforms and are summed. Demand is not, so no volume figure is returned.",
      },
    });
  }),
};
