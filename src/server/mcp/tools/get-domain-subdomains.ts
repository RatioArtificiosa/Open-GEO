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
 * First MCP caller for `subdomains` (CL-401).
 *
 * The permissive sibling: only the target is required, location and language
 * are all-optional. Priced per returned item (quote triple: endpoint path
 * below, `standard` book entry, test pin on `estimatedCredits`).
 */

const SUBDOMAIN_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "subdomain", value: (row) => readPath(row, "name") },
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
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Subdomains to return. Defaults to 25, max 1000."),
  ...dryRunInputSchema,
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getDomainSubdomainsTool = {
  name: "get_domain_subdomains",
  config: {
    title: "Get domain subdomains",
    description:
      "Returns the subdomains of a domain with their organic traffic and keyword counts. Use it to see where a domain's visibility actually lives (blog, docs, app) before you compete with it. Charges credits per subdomain returned (about $0.012 per request plus $0.00012 per item). `dry_run` defaults to true, so the first call previews the credit estimate without spending; set `dry_run: false` to run.",
    inputSchema,
    outputSchema: z.looseObject({
      subdomains: z.array(looseObjectOutputSchema),
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
        subject: `subdomains of ${args.domain}`,
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
    const result: DomainListResult = await DomainIntel.getSubdomains(
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
        ? `No subdomains found for ${parsed.display}.`
        : `Subdomains of ${parsed.display} (${result.rows.length}):\n${formatMcpTable(result.rows, SUBDOMAIN_COLUMNS)}`;
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/domain`,
        { domain: parsed.display },
      ),
      structuredContent: { subdomains: result.rows, target: parsed.display },
    });
  }),
};
