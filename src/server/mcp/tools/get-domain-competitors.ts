import { z } from "zod";
import {
  DomainIntel,
  type DomainListResult,
} from "@/server/features/domain/services/domainIntel";
import { standardLabsItemEstimate } from "@/server/lib/dataforseo/labsDomainOverview";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  creditsFor,
  dryRunInputSchema,
  dryRunResponse,
  wantsToSpend,
} from "@/server/mcp/dry-run";
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
 * First MCP caller for `competitors_domain` (CL-401).
 *
 * The strict sibling: requires one of each location/language pair (the
 * project market satisfies this). Priced per returned item (quote triple:
 * endpoint path below, `standard` book entry, test pin on
 * `estimatedCredits`).
 */

const COMPETITOR_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "competitor", value: (row) => readPath(row, "name") },
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
    .describe("Domain or URL to find competitors for (e.g. 'example.com')."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Competitors to return. Defaults to 25, max 1000."),
  ...dryRunInputSchema,
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getDomainCompetitorsTool = {
  name: "get_domain_competitors",
  config: {
    title: "Get domain competitors",
    description:
      "Returns the domains competing with a domain in organic search, with their traffic and keyword counts. Use it to build the competitor set for a gap analysis. Charges credits per competitor returned (about $0.012 per request plus $0.00012 per item). `dry_run` defaults to true, so the first call previews the credit estimate without spending; set `dry_run: false` to run.",
    inputSchema,
    outputSchema: z.looseObject({
      competitors: z.array(looseObjectOutputSchema),
      target: z.string().optional(),
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
    const limit = args.limit ?? 25;
    if (!wantsToSpend(args.dry_run)) {
      const usd = standardLabsItemEstimate(limit);
      return dryRunResponse({
        subject: `competitors of ${args.domain}`,
        estimatedCredits: creditsFor(usd),
        unitSentence: `USD ${DFS_LABS.standard.perRequest} per request plus USD ${DFS_LABS.standard.perUnit} per item, DataForSEO Labs`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/domain`,
        ),
        structured: {},
      });
    }
    const result: DomainListResult = await DomainIntel.getCompetitors(
      {
        domain: args.domain,
        locationCode,
        languageCode,
        limit,
        organizationId: context.auth.organizationId,
        projectId: args.projectId,
      },
      context.billing,
    );
    // The service already parsed the same input, so this cannot throw here.
    const parsed = parseResearchTargetOrThrow(args.domain);
    const text =
      result.rows.length === 0
        ? `No competitors found for ${parsed.display}.`
        : `Competitors of ${parsed.display} (${result.rows.length}):\n${formatMcpTable(result.rows, COMPETITOR_COLUMNS)}`;
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/domain`,
        { domain: parsed.display },
      ),
      structuredContent: { competitors: result.rows, target: parsed.display },
    });
  }),
};
