import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  deleteAuditSchema,
  getAuditHistorySchema,
  getAuditResultsSchema,
  getAuditStatusSchema,
  getCrawlProgressSchema,
  getPageWaterfallSchema,
  startAuditSchema,
  startPageSpeedAuditSchema,
} from "@/types/schemas/audit";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";

/**
 * The app's own entry points to the page-speed pair, so "why is this page slow?" is answerable
 * in the product and not only through an agent. Both go through the metered client, where the
 * crawl is billed and the read deliberately is not.
 */
export const startPageSpeedAudit = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startPageSpeedAuditSchema)
  .handler(async ({ data, context }) => {
    const client = createDataforseoClient(context);
    return client.onPage.waterfallTask({
      url: data.url,
      maxCrawlPages: data.maxCrawlPages ?? 1,
    });
  });

export const getPageWaterfall = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getPageWaterfallSchema)
  .handler(async ({ data, context }) => {
    const client = createDataforseoClient(context);
    // The raw envelope, because this read is bound unmetered: the vendor charges nothing for it.
    const read = await client.onPage.waterfall({
      taskId: data.taskId,
      url: data.url,
    });
    return { crawlProgress: read.data.crawlProgress, pages: read.data.pages };
  });

export const startAudit = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startAuditSchema)
  .handler(async ({ data, context }) => {
    const limitTier = await AuditService.resolveAuditLimitTier(context);

    const result = await AuditService.startAudit({
      actorUserId: context.userId,
      billingCustomer: context,
      projectId: context.projectId,
      startUrl: data.startUrl,
      maxPages: data.maxPages,
      lighthouseStrategy: data.lighthouseStrategy,
      limitTier,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "site_audit:start",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          max_pages: data.maxPages ?? 50,
          run_lighthouse: data.lighthouseStrategy !== "none",
          plan_tier: limitTier,
        },
      }),
    );

    return result;
  });

export const getAuditStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditStatusSchema)
  .handler(async ({ data, context }) => {
    return AuditService.getStatus(data.auditId, context.projectId);
  });

export const getAuditResults = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditResultsSchema)
  .handler(async ({ data, context }) => {
    return AuditService.getResults(data.auditId, context.projectId);
  });

export const getAuditHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditHistorySchema)
  .handler(async ({ context }) => {
    return AuditService.getHistory(context.projectId);
  });

export const getCrawlProgress = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getCrawlProgressSchema)
  .handler(async ({ data, context }) => {
    return AuditService.getCrawlProgress(data.auditId, context.projectId);
  });

export const deleteAudit = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(deleteAuditSchema)
  .handler(async ({ data, context }) => {
    // Deleting audits frees the org's free-plan capacity ceiling (a SUM over
    // audit rows), so it gets the same destructive-action gate as archiving.
    requireOrgPermission(context, { project: ["delete"] });
    await AuditService.remove(data.auditId, context.projectId);
    return { success: true };
  });
