import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const listInputSchema = { projectId: projectIdSchema } as const;

export const listSiteAuditsTool = {
  name: "list_site_audits",
  config: {
    title: "List site audits",
    description:
      "Lists this project's site audits with IDs, URLs, status, page counts, and dates, newest first. Uses no credits. Use this to find an older audit to read or delete; get_audit_status defaults to the newest audit only.",
    inputSchema: listInputSchema,
    outputSchema: z.looseObject({
      audits: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof listInputSchema>>, context) => {
      const audits = await AuditService.getHistory(args.projectId);
      return mcpResponse({
        text: audits.length
          ? audits
              .map(
                (audit) =>
                  `${audit.id}  ${audit.startUrl}  ${audit.status}  ${audit.pagesCrawled} pages  ${audit.startedAt}`,
              )
              .join("\n")
          : "No site audits in this project.",
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
        structuredContent: { audits },
      });
    },
  ),
};

const deleteInputSchema = {
  projectId: projectIdSchema,
  auditId: z
    .string()
    .min(1)
    .describe(
      "Exact audit ID from list_site_audits or run_site_audit. Required; never defaults to the latest audit.",
    ),
} as const;

export const deleteSiteAuditTool = {
  name: "delete_site_audit",
  config: {
    title: "Delete site audit",
    description:
      "Permanently deletes one site audit and its crawled pages, issues, and Lighthouse results, freeing audit capacity. Uses the same workflow-stop and cleanup behavior as the dashboard. Uses no credits. Requires an owner or admin, like deletion in the dashboard. Saved reports and project context are kept.",
    inputSchema: deleteInputSchema,
    outputSchema: z.looseObject({
      auditId: z.string(),
      deleted: z.literal(true),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof deleteInputSchema>>, context) => {
      requireOrgPermission(context.auth, { project: ["delete"] });
      await AuditService.remove(args.auditId, args.projectId);
      return mcpResponse({
        text: `Deleted site audit ${args.auditId}. Saved reports and project context are kept.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
        structuredContent: { auditId: args.auditId, deleted: true as const },
      });
    },
  ),
};
