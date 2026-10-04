import type { WorkflowStep } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";
import { normalizeUrl } from "@/server/lib/audit/url-utils";
import type { DetectedIssue } from "@/server/lib/audit/issues/page-reporters";
import type { AuditConfig } from "@/server/lib/audit/types";
import { captureServerEvent } from "@/server/lib/posthog";
import type { CrawlPhaseResult } from "@/server/workflows/siteAuditWorkflowCrawl";
import { runReadinessPhase } from "@/server/workflows/siteAuditWorkflowReadiness";
import { pgStep } from "@/server/workflows/pgStep";
import {
  DB_STEP,
  MULTIPAGE_CHECKS_STEP,
} from "@/server/workflows/auditStepConfigs";

/**
 * The finalize phase: cross-page checks, the citability report, and completion.
 *
 * ## Why this is its own module
 *
 * The phases file was over the 400-line ceiling and this was the largest block in
 * it. `siteAuditWorkflowPhases.ts` is now readable as what it always was meant
 * to be: a list of phases, each one a line. **A file whose job is orchestration
 * should read as orchestration**, and 430 lines of phase bodies buried the one
 * function that decides what runs in what order.
 *
 * Nothing about the phase changed — it is the same steps, the same order, the
 * same step configs. Only the file it lives in moved.
 */
/**
 * The two finalize checks that need link edges run as SQL inside the
 * audit's scratchpad DO; map their rows onto DetectedIssue.
 */
async function runScratchpadLinkChecks(
  auditId: string,
  startUrl: string,
  crawl: CrawlPhaseResult,
): Promise<DetectedIssue[]> {
  const scratchpad = getAuditScratchpad(auditId);
  const { brokenLinks, orphanPages } = await scratchpad.runFinalizeChecks({
    // Page rows store normalized URLs; normalize the start URL the same way
    // so the orphan exclusion matches.
    startUrl: normalizeUrl(startUrl) ?? startUrl,
    // Orphan detection only makes sense when the crawl wasn't truncated.
    crawlCompleted: crawl.completed,
  });

  return [
    ...brokenLinks.map((row) => ({
      issueType: "broken-internal-link" as const,
      pageId: row.sourcePageId,
      pageUrl: row.sourceUrl,
      dedupeKey: row.targetUrl,
      details: { targetUrl: row.targetUrl, targetStatus: row.targetStatus },
    })),
    ...orphanPages.map((row) => ({
      issueType: "orphan-page" as const,
      pageId: row.pageId,
      pageUrl: row.url,
    })),
  ];
}
export async function runFinalizePhase(args: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  crawl: CrawlPhaseResult;
}) {
  const {
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
  } = args;

  await pgStep(step, "multipage-checks", MULTIPAGE_CHECKS_STEP, async () => {
    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      currentPhase: "finalizing",
    });

    // Integrity guard: pages are persisted inside crawl-chunk steps. If the
    // crawl claims pages but the DB has none, fail loudly instead of
    // completing with an empty audit.
    if (
      crawl.pagesCrawled > 0 &&
      !(await AuditRepository.hasPagesForAudit(auditId))
    ) {
      throw new Error(
        `Audit ${auditId}: crawl reported ${crawl.pagesCrawled} pages but none were persisted`,
      );
    }

    const issues = await runMultipageChecks({ auditId });
    issues.push(...(await runScratchpadLinkChecks(auditId, startUrl, crawl)));
    if (crawl.rateLimited) {
      issues.push({
        issueType: "crawl-rate-limited",
        pageId: null,
        pageUrl: startUrl,
      });
    }
    await AuditRepository.insertIssues(auditId, issues);
    return { issueCount: issues.length };
  });

  // The citability report, after every page row exists and before the audit is
  // marked complete. **Its own step, and its own retry budget**, because it is a
  // distinct phase reading the whole page table — and because a step that shares
  // another step's config inherits that step's timeout, which is sized for a
  // different job.
  await runReadinessPhase(step, {
    auditId,
    startUrl,
    // `pagesCrawled` is what actually landed; the seeded total is the estimate the
    // crawl started from and may exceed it when a frontier runs dry. Reporting the
    // estimate as "attempted" would overstate what we failed to analyse.
    pagesAttempted: crawl.pagesCrawled,
  });

  await pgStep(step, "finalize", DB_STEP, async () => {
    const blockedPages = await AuditRepository.countPagesByFetchClass(
      auditId,
      "blocked",
    );
    const rateLimitedPages = await AuditRepository.countPagesByFetchClass(
      auditId,
      "rate_limited",
    );
    await AuditRepository.completeAudit(auditId, workflowInstanceId, {
      pagesCrawled: crawl.pagesCrawled,
      pagesTotal: crawl.pagesCrawled,
    });
    await captureServerEvent({
      distinctId: billingCustomer.userId,
      event: "site_audit:complete",
      organizationId: billingCustomer.organizationId,
      properties: {
        project_id: projectId,
        status: "completed",
        pages_crawled: crawl.pagesCrawled,
        pages_total: crawl.pagesCrawled,
        crawl_completed: crawl.completed,
        pages_blocked: blockedPages,
        pages_rate_limited: rateLimitedPages,
        run_lighthouse: config.lighthouseStrategy !== "none",
      },
    });
    await AuditProgressKV.clear(auditId);
    // Crawl scratch state (frontier, links, mirror) is no longer needed.
    await getAuditScratchpad(auditId).destroy();
  });
}
