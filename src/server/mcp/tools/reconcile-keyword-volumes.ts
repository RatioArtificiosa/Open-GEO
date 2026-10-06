import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { fetchKeywordMetricsForList } from "@/server/lib/dataforseo/keyword-metrics";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  reconcileVolume,
  summariseReconciliation,
} from "@/shared/volume-reconciliation";

const inputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string())
    .min(1)
    .max(1000)
    .describe(
      "Keywords to check. Keep it to the ones you are about to make a decision with, because every keyword is billed on both sides of the comparison.",
    ),
  /**
   * **Required, and not inferred from the project's market.** The clickstream breakdown
   * is keyed by ISO-3166 alpha-2 and the endpoint takes no `location_code`, so there is
   * nothing to map a DataForSEO market onto. Defaulting to a country would silently
   * compare one market's figures against another market's measurement, which is the
   * failure this tool exists to catch.
   */
  countryIsoCode: z
    .string()
    .length(2)
    .describe(
      "Market the volume figures describe, as ISO-3166 alpha-2 (for example US). Must match the project's market, because the comparison is against that country's measured volume.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const reconcileKeywordVolumesTool = {
  name: "reconcile_keyword_volumes",
  config: {
    title: "Reconcile keyword volumes",
    description:
      "Checks the search volumes this product shows against clickstream-measured volumes, and says where the two disagree. Use it before making a decision that depends on a volume figure, or when a keyword's volume looks implausible. Google Ads reports grouped estimates, so a keyword can inherit a cluster's total; this is how you find out. Charges credits: one keyword-metrics request plus one clickstream request, the latter billed per call rather than per keyword.",
    inputSchema,
    outputSchema: z
      .object({
        countryIsoCode: z.string(),
        summary: z.looseObject({
          total: z.number(),
          corroborated: z.number(),
          measuredHigher: z.number(),
          measuredLower: z.number(),
          uncomparable: z.number(),
          corroborationRate: z.number().nullable(),
        }),
        rows: z.array(
          z.looseObject({
            keyword: z.string(),
            referenceVolume: z.number().nullable(),
            countryVolume: z.number().nullable(),
            globalVolume: z.number().nullable(),
            verdict: z.enum([
              "corroborated",
              "measured-higher",
              "measured-lower",
              "uncomparable",
            ]),
            note: z.string(),
          }),
        ),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    // This tool takes no market override, so the project's own market is the reference.
    const { locationCode, languageCode } = context.project;
    const client = createDataforseoClient(context.billing);

    // The reference side runs through the same path that populates the product, so the
    // comparison is against what a reader would actually be shown rather than a
    // re-derivation of it.
    const metrics = await fetchKeywordMetricsForList(client, {
      keywords: args.keywords,
      locationCode,
      languageCode,
      creditFeature: "keyword_research",
    });
    // Through the client, so the clickstream request is metered like every other call.
    const measured = await client.keywords.clickstreamVolumes({
      keywords: args.keywords,
    });

    const referenceByKeyword = new Map(
      metrics.map((row) => [row.keyword.toLowerCase(), row.searchVolume]),
    );
    const measuredByKeyword = new Map(
      measured.map((row) => [row.keyword.toLowerCase(), row]),
    );

    const rows = args.keywords.map((keyword) => {
      const key = keyword.trim().toLowerCase();
      const measurement = measuredByKeyword.get(key);
      return reconcileVolume({
        keyword: key,
        referenceVolume: referenceByKeyword.get(key) ?? null,
        globalVolume: measurement?.globalVolume ?? null,
        countryDistribution: measurement?.countryDistribution ?? [],
        countryIsoCode: args.countryIsoCode,
      });
    });
    const summary = summariseReconciliation(rows);

    const headline =
      summary.corroborationRate === null
        ? `No volume could be checked against ${args.countryIsoCode}: each keyword lacked a figure on one side, so this run makes no claim about them.`
        : `${summary.corroborated} of ${summary.total - summary.uncomparable} comparable keyword${summary.total - summary.uncomparable === 1 ? "" : "s"} (${Math.round(summary.corroborationRate * 100)}%) have a volume the measured data supports.`;
    const detail =
      `${summary.measuredHigher} measured higher, ${summary.measuredLower} measured lower` +
      (summary.uncomparable > 0
        ? `, ${summary.uncomparable} could not be checked`
        : "");

    return mcpResponse({
      text: `${headline} ${detail}. The figures below are what this product shows against clickstream-measured volume for ${args.countryIsoCode}, which comes from panel data rather than Google Ads' grouped estimates. Where they disagree, treat the shown figure as unconfirmed and read the note on the row. Global clickstream volume is included as context only: it is not comparable to a single market's figure.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/keywords`,
      ),
      structuredContent: {
        countryIsoCode: args.countryIsoCode,
        summary,
        rows: rows.map((row) => ({
          keyword: row.keyword,
          referenceVolume: row.referenceVolume,
          countryVolume: row.countryVolume,
          globalVolume: row.globalVolume,
          verdict: row.verdict,
          note: row.note,
        })),
      },
    });
  }),
};
