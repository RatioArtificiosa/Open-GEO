import { z } from "zod";
import {
  TECH_LEADS_MAX_CANDIDATES,
  type TechLeadProspect,
  type TechLeadsResult,
  TechLeadsService,
} from "@/server/features/domain/services/techLeads";
import { estimateTechLeadListUsd } from "@/shared/tech-lead-cost";
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
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  formatMcpTable,
  type McpTableColumn,
  readPath,
} from "@/server/mcp/table";
import { DFS_DOMAIN } from "@/shared/dataforseo-pricing";

/**
 * First caller for the tech-slicing lead list (CL-408 surface).
 *
 * WHOIS prospecting finds the candidates, one technologies read per
 * candidate recovers each stack with its contacts, and the slicer keeps the
 * stack gap the list is sold on. Priced per list before it runs and per
 * prospect after: the dry run quotes the WHOIS read plus one technologies
 * read per candidate examined (quote triple: endpoint paths below,
 * `DFS_DOMAIN` book entries, test pin on `estimatedCredits`), and the live
 * response divides that estimate by the prospects found — labelled an
 * estimate, because the vendor's receipt is per call, not per prospect.
 */

const LEAD_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "domain", value: (row) => readPath(row, "domain") },
  {
    header: "technologies",
    value: (row) => {
      const techs = readPath(row, "technologies");
      return Array.isArray(techs) ? techs.join(", ") : "?";
    },
  },
  {
    header: "contacts",
    value: (row) => {
      const emails = readPath(row, "emails");
      if (!Array.isArray(emails) || emails.length === 0) return "—";
      return emails.join(", ");
    },
  },
];

const inputSchema = {
  projectId: projectIdSchema,
  domainPattern: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Substring matched against WHOIS domains (e.g. 'plumb' finds plumbers). A filter is required: unfiltered WHOIS returns the internet's largest domains.",
    ),
  requiredTech: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(10)
    .describe(
      "Technologies every prospect must run (e.g. ['shopify']). At least one: slicing on nothing keeps everything.",
    ),
  excludedTech: z
    .array(z.string().min(1).max(64))
    .max(10)
    .optional()
    .describe(
      "Technologies no prospect may run (e.g. ['klaviyo']) — the stack gap the list is sold on.",
    ),
  maxCandidates: z
    .number()
    .int()
    .min(1)
    .max(TECH_LEADS_MAX_CANDIDATES)
    .optional()
    .describe(
      "WHOIS candidates to examine (one technologies read each). Defaults to 10.",
    ),
  ...dryRunInputSchema,
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

// The list quote, shared with the credit gate and the Lead Lists page.
const estimateLeadsUsd = estimateTechLeadListUsd;

export const findTechLeadsTool = {
  name: "find_tech_leads",
  config: {
    title: "Find leads by technology stack",
    description:
      "Returns domains matching a WHOIS pattern whose technology stack contains every required technology and none of the excluded ones, with contact emails where the vendor has them. Use it to build a prospect list around a stack gap ('runs Shopify but not Klaviyo'). Charges credits per list: about $0.12 for the WHOIS read plus about $0.012 per candidate examined (10 by default). `dry_run` defaults to true, so the first call previews the credit estimate without spending; set `dry_run: false` to run.",
    inputSchema,
    outputSchema: z.looseObject({
      prospects: z.array(looseObjectOutputSchema),
      examined: z.number().optional(),
      failed: z.array(looseObjectOutputSchema).optional(),
      estimatedCostPerProspectUsd: z.number().nullable().optional(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const maxCandidates = args.maxCandidates ?? 10;
    if (!wantsToSpend(args.dry_run)) {
      const usd = estimateLeadsUsd(maxCandidates);
      return dryRunResponse({
        subject: `tech lead list for '${args.domainPattern}' (${maxCandidates} candidates)`,
        estimatedCredits: creditsFor(usd),
        unitSentence: `USD ${DFS_DOMAIN.whois.perRequest} per WHOIS request plus USD ${DFS_DOMAIN.technologies.perRequest} per candidate examined, DataForSEO domain analytics`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/leads`,
        ),
        structured: {},
      });
    }
    const result: TechLeadsResult = await TechLeadsService.findTechLeads(
      {
        domainPattern: args.domainPattern,
        requiredTech: args.requiredTech,
        excludedTech: args.excludedTech,
        maxCandidates,
        organizationId: context.auth.organizationId,
        projectId: args.projectId,
      },
      context.billing,
    );
    const estimatedTotal = estimateLeadsUsd(maxCandidates);
    const perProspect =
      result.prospects.length === 0
        ? null
        : estimatedTotal / result.prospects.length;
    const failedNote =
      result.failed.length === 0
        ? []
        : [
            `${result.failed.length} candidate${result.failed.length === 1 ? "" : "s"} could not be read (${result.failed.map((f) => f.domain).join(", ")}); they are reported, not silently dropped.`,
          ];
    const text =
      result.prospects.length === 0
        ? [
            `No prospects running ${args.requiredTech.join(", ")} found under '${args.domainPattern}' (${result.examined} candidates examined).`,
            ...failedNote,
          ].join("\n")
        : [
            `Tech leads for '${args.domainPattern}' (${result.prospects.length} of ${result.examined} candidates, ~$${perProspect?.toFixed(4)} estimated per prospect):`,
            formatMcpTable(result.prospects, LEAD_COLUMNS),
            ...failedNote,
          ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/leads`,
        { domainPattern: args.domainPattern },
      ),
      structuredContent: {
        prospects: result.prospects satisfies TechLeadProspect[],
        examined: result.examined,
        failed: result.failed,
        estimatedCostPerProspectUsd: perProspect,
      },
    });
  }),
};
