import { and, countDistinct, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditIssues,
  auditLighthouseResults,
  auditPages,
  auditReadiness,
  audits,
} from "@/db/schema";

/**
 * Distinct-page counts per issue type for one audit — link-level issues
 * write one row per occurrence, and consumers phrase this as "N pages".
 * Lives beside AuditRepository (same pattern as rank-tracking's
 * snapshotQueries) to keep the main repository under the file-size limit.
 */
export async function getIssueTypePageCountsForAudit(auditId: string) {
  return db
    .select({
      issueType: auditIssues.issueType,
      severity: auditIssues.severity,
      pages: countDistinct(auditIssues.pageUrl),
    })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, auditId))
    .groupBy(auditIssues.issueType, auditIssues.severity);
}

/**
 * Everything the results screen shows for one audit: the audit row, its pages,
 * its issues and its Lighthouse results, fetched together so the screen is four
 * queries or one round trip.
 *
 * **Unprojected on purpose.** Every column is returned, which is the right shape
 * for a read whose consumer renders whole rows — a projection here would mean
 * editing this function every time the results screen adds a column, and a
 * projection that omits a column the screen needs fails as a blank cell rather
 * than a type error.
 */
export async function getAuditResultsForProject(
  auditId: string,
  projectId: string,
) {
  const [audit, pages, lighthouse, issues, readiness] = await Promise.all([
    db.query.audits.findFirst({
      where: and(eq(audits.id, auditId), eq(audits.projectId, projectId)),
    }),
    db.query.auditPages.findMany({
      where: eq(auditPages.auditId, auditId),
    }),
    db.query.auditLighthouseResults.findMany({
      where: eq(auditLighthouseResults.auditId, auditId),
    }),
    db.query.auditIssues.findMany({
      where: eq(auditIssues.auditId, auditId),
    }),
    // **One row, read with the rest.** `null` when the phase did not complete —
    // which is a different fact from an empty report, and the reader keeps them
    // apart so a reader can too.
    db.query.auditReadiness.findFirst({
      where: eq(auditReadiness.auditId, auditId),
    }),
  ]);

  return { audit, pages, lighthouse, issues, readiness };
}

export async function getAuditForProject(auditId: string, projectId: string) {
  return db.query.audits.findFirst({
    where: and(eq(audits.id, auditId), eq(audits.projectId, projectId)),
  });
}

export async function getLatestAuditForProject(projectId: string) {
  return db.query.audits.findFirst({
    where: eq(audits.projectId, projectId),
    orderBy: desc(audits.startedAt),
  });
}
