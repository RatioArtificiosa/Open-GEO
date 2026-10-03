import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import { metaOnlyOutputFields } from "@/server/mcp/tools/geo-shared";
import { AI_KEYWORD_UNIT_COST_USD } from "@/shared/dataforseo-pricing";

/**
 * AI Keyword Data over MCP — "high AI demand, low Google demand".
 *
 * The most valuable signal the product has: a topic the AI engines answer on
 * but classic SEO tools cannot see. It is already implemented, already tested
 * and already on the metered client as `aiSearch.keywordVolume`, used by the
 * nightly capture; **what was missing was the wire**, which is why this tool
 * exists rather than a new fetcher.
 *
 * ## The one number in this response is not comparable with the other one
 *
 * `ai_search_volume` from **this** endpoint is a People-Also-Ask-derived
 * *model* of AI demand. `ai_search_volume` from `llm_mentions/target_metrics`
 * is the same field name over a different unit and a different source. We
 * measured 12,621,380 against 63,850 for one keyword — **198×**, across two
 * endpoints that agree on a field name.
 *
 * So this tool reports the AI figure **alone**, names the unit in the text, and
 * never offers a comparison the vendor cannot support. An agent that asks
 * "how big is AI demand for X?" gets one honest number with its provenance, not
 * a ratio against a Google volume measured somewhere else.
 *
 * ## The monthly series is optional, and the cost is per keyword either way
 *
 * DataForSEO bills `$0.002` per keyword, whether or not the 12-month series is
 * requested — so `includeMonthlyTrend` is a response-size decision, not a cost
 * one, and the dry run quotes the keyword count only. It is off by default
 * because the 12-row array is the bulk of the bytes and nothing at the call
 * site is known to need it.
 */

type AiKeywordRow = {
  keyword: string;
  aiSearchVolume: number | null;
  monthlyTrend: Array<{ year: number; month: number; volume: number | null }>;
};

const AI_KEYWORD_COLUMNS: McpTableColumn<AiKeywordRow>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "AI volume", value: (row) => row.aiSearchVolume },
];

/** The vendor's own per-keyword unit price, so the estimate cannot drift. */
const CREDITS_PER_KEYWORD = AI_KEYWORD_UNIT_COST_USD * 1000;

const inputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1).max(250))
    .min(1)
    .max(1000)
    .describe(
      "Keywords to price for AI demand, 1-1000. DataForSEO accepts at most 1000 per call; sends 1,000 at once rather than paging, so the per-call cost is known exactly.",
    ),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  includeMonthlyTrend: z
    .boolean()
    .optional()
    .describe(
      "Include the 12-month AI-demand series per keyword. Free — the price is per keyword either way — but it is most of the response, so default false.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the credit cost without spending. Set dry_run: false to run the live vendor query.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const aiKeywordVolumeTool = {
  name: "ai_keyword_volume",
  config: {
    title: "AI keyword demand",
    description:
      "AI demand for up to 1000 keywords in one call — the signal classic SEO tools cannot see: a topic the AI engines answer on but Google search volume does not show. Returns each keyword's AI search volume, and optionally a 12-month series. Unit warning: this AI volume is a People-Also-Ask-derived model and is NOT comparable with Google search volume, nor with the same-named field from other AI tools — one keyword measured 198x apart across two of them. Never present it as a ratio against a Google figure. Charges $0.002 per keyword (~2 credits each). `dry_run` defaults to true, so the first call previews the cost without spending; set `dry_run: false` to run.",
    inputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        locationCode: z.number().nullable(),
        languageCode: z.string().nullable(),
        keywordCount: z.number(),
        rows: z.array(
          z
            .object({
              keyword: z.string(),
              aiSearchVolume: z.number().nullable(),
              monthlyTrend: z
                .array(
                  z
                    .object({
                      year: z.number(),
                      month: z.number(),
                      volume: z.number().nullable(),
                    })
                    .passthrough(),
                )
                .nullable(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const locationCode = args.locationCode ?? context.project.locationCode;
    const languageCode = args.languageCode ?? context.project.languageCode;
    // The endpoint de-duplicates and lowercases, so the estimate is built from
    // the same normalisation the fetcher applies — otherwise a batch of casing
    // variants would quote for rows the vendor is never asked about.
    const unique = new Set(args.keywords.map((k) => k.trim().toLowerCase()));

    if (args.dry_run !== false) {
      const estimate = unique.size * CREDITS_PER_KEYWORD;
      return mcpResponse({
        text: [
          `Dry run: AI demand for ${unique.size} keyword(s) will cost approximately ${estimate} credits ($0.002 per keyword, DataForSEO AI Keyword Data). Charged amount is what DataForSEO reports at send time.`,
          `Re-run with dry_run: false to spend credits and fetch the volumes.`,
          `AI volume is a People-Also-Ask-derived model, not comparable with Google search volume or with the same-named field from other AI tools.`,
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/keywords`,
        ),
        structuredContent: {
          dryRun: true,
          keywordCount: unique.size,
          locationCode,
          languageCode,
          estimatedCredits: estimate,
        },
      });
    }

    const client = createDataforseoClient(context.billing);
    // Through the metered client: this spends per-keyword vendor credits, so
    // the balance check and the usage record have to run.
    const result = await client.aiSearch.keywordVolume({
      keywords: args.keywords,
      locationCode,
      languageCode,
    });

    const rows: AiKeywordRow[] = result.items.map((item) => ({
      keyword: item.keyword,
      aiSearchVolume: item.ai_search_volume ?? null,
      monthlyTrend:
        args.includeMonthlyTrend === true
          ? (item.ai_monthly_searches ?? []).map((month) => ({
              year: month.year,
              month: month.month,
              volume: month.ai_search_volume ?? null,
            }))
          : [],
    }));

    const lines = [
      `AI demand for ${rows.length} keyword(s) (location: ${result.locationCode}, language: ${result.languageCode}):`,
      "",
    ];
    if (rows.length === 0) {
      lines.push(
        "DataForSEO returned no rows. That is an absence of data, not evidence that these topics have no AI demand.",
      );
    } else {
      lines.push(formatMcpTable(rows, AI_KEYWORD_COLUMNS));
    }
    lines.push(
      "",
      "AI volume is a People-Also-Ask-derived model. It is not comparable with Google search volume, and not with the same-named field returned by other AI tools — one keyword measured 198x apart across two of them. Compare these figures with other AI-volume figures only, never with a Google number.",
    );

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/keywords`,
      ),
      structuredContent: {
        locationCode: result.locationCode,
        languageCode: result.languageCode,
        keywordCount: rows.length,
        rows,
      },
    });
  }),
};
