import { z } from "zod";
import {
  DomainIntel,
  type HistoricalRanksResult,
} from "@/server/features/domain/services/domainIntel";
import { historicalMonthsSpanned } from "@/server/lib/dataforseo/labsDomainOverview";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import { buildProjectMeta } from "@/server/mcp/context";
import { creditsFor, dryRunResponse, wantsToSpend } from "@/server/mcp/dry-run";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import {
  formatMcpTable,
  type McpTableColumn,
  readPath,
} from "@/server/mcp/table";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import { resolveLabsMarket } from "@/shared/keyword-locations";

/**
 * First MCP caller for `historical_rank_overview` (CL-401).
 *
 * Monthly rank and traffic history for a domain. Priced per domain-month
 * over the requested span (quote triple: endpoint path below, `historicalRank`
 * book entry, test pin on `estimatedCredits`); historical endpoints are
 * excluded from the new ETV model, so the series stays on the legacy formula
 * and the text says so.
 */

function formatHistoryMonth(row: unknown): string {
  const year = readPath(row, "year");
  const month = readPath(row, "month");
  const day = typeof month === "number" ? String(month).padStart(2, "0") : "?";
  return typeof year === "number" ? `${year}-${day}` : "unknown";
}

const HISTORY_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "month", value: (row) => formatHistoryMonth(row) },
  {
    header: "organic traffic",
    value: (row) => readPath(row, "organicTraffic"),
  },
  {
    header: "organic keywords",
    value: (row) => readPath(row, "organicKeywords"),
  },
];

const inputSchema = {
  projectId: projectIdSchema,
  domain: z
    .string()
    .min(1)
    .max(2048)
    .describe("Domain or URL to analyze (e.g. 'example.com')."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd")
    .optional()
    .describe(
      "First month of history (yyyy-mm-dd). Defaults to six months back.",
    ),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd")
    .optional()
    .describe("Last month of history (yyyy-mm-dd). Defaults to today."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the credit cost without spending. Set dry_run: false to run the call.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

function estimateHistoricalUsd(input: {
  dateFrom?: string;
  dateTo?: string;
}): number {
  const today = new Date().toISOString().slice(0, 10);
  const months = Math.max(
    historicalMonthsSpanned(input.dateFrom, input.dateTo, today),
    1,
  );
  return (
    DFS_LABS.historicalRank.perRequest +
    DFS_LABS.historicalRank.perUnit * months
  );
}

export const getDomainHistoricalTool = {
  name: "get_domain_historical",
  config: {
    title: "Get domain traffic history",
    description:
      "Returns monthly organic traffic and keyword history for a domain over a date range (default: the last six months). Use it to see whether a domain's visibility is growing, flat, or fading before you compete with it. Charges credits per month of history (about $0.12 per request plus $0.0012 per domain-month). `dry_run` defaults to true, so the first call previews the credit estimate without spending; set `dry_run: false` to run. Traffic figures use the legacy ETV formula: historical endpoints are excluded from the new ETV model.",
    inputSchema,
    outputSchema: z.looseObject({
      months: z.array(looseObjectOutputSchema),
      target: z.string().optional(),
      etv: z.looseObject({}).optional(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const { locationCode, languageCode } = resolveLabsMarket(
      args,
      context.project,
    );
    assertLabsLocationCode(locationCode);
    assertLanguageForLocation(locationCode, languageCode);
    if (!wantsToSpend(args.dry_run)) {
      const usd = estimateHistoricalUsd({
        dateFrom: args.date_from,
        dateTo: args.date_to,
      });
      return dryRunResponse({
        subject: `traffic history for ${args.domain}`,
        estimatedCredits: creditsFor(usd),
        unitSentence: `USD ${DFS_LABS.historicalRank.perRequest} per request plus USD ${DFS_LABS.historicalRank.perUnit} per domain-month, DataForSEO Labs`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/domain`,
        ),
        structured: {},
      });
    }
    const result: HistoricalRanksResult = await DomainIntel.getHistoricalRanks(
      {
        domain: args.domain,
        locationCode,
        languageCode,
        dateFrom: args.date_from,
        dateTo: args.date_to,
        organizationId: context.auth.organizationId,
        projectId: args.projectId,
      },
      context.billing,
    );
    // The service already parsed the same input, so this cannot throw here.
    const parsed = parseResearchTargetOrThrow(args.domain);
    const text =
      result.months.length === 0
        ? `No traffic history found for ${parsed.display}.`
        : [
            `Traffic history for ${parsed.display} (${result.months.length} months, legacy ETV):`,
            formatMcpTable(result.months, HISTORY_COLUMNS),
            "Note: historical endpoints are excluded from the new ETV model, so these figures stay on the legacy formula and are not comparable to post-cutover series.",
          ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/domain`,
        { domain: parsed.display },
      ),
      structuredContent: {
        months: result.months,
        target: parsed.display,
        etv: result.etv,
      },
    });
  }),
};
