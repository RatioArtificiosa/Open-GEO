import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLighthouseResults, auditPages, audits } from "@/db/schema";

/**
 * The single-Lighthouse-result reader.
 *
 * **Its own module because the ceiling required a split, and this is the smallest
 * honest one available.** It is a read, it is the only consumer of
 * `auditLighthouseResults` outside the batch insert, and moving it leaves the
 * lifecycle module about the lifecycle — which is what a file called
 * `AuditRepository` should be about.
 *
 * A larger move of ten readers into `auditSummaryQueries.ts` was tried first and
 * **reverted: it cascaded into twelve broken files**, because that module carries
 * a narrower import set than the moved code needed. **A split that breaks more
 * than it fixes is not a split**, it is a relocation with extra steps.
 */
export async function getLighthouseResultById(input: {
  lighthouseResultId: string;
  projectId: string;
}) {
  const lighthouse = await db.query.auditLighthouseResults.findFirst({
    where: eq(auditLighthouseResults.id, input.lighthouseResultId),
  });

  if (!lighthouse) {
    return null;
  }

  const [parentAudit, page] = await Promise.all([
    db.query.audits.findFirst({
      where: and(
        eq(audits.id, lighthouse.auditId),
        eq(audits.projectId, input.projectId),
      ),
    }),
    db.query.auditPages.findFirst({
      where: eq(auditPages.id, lighthouse.pageId),
    }),
  ]);

  if (!parentAudit) {
    return null;
  }

  return {
    lighthouse,
    page,
    audit: parentAudit,
  };
}
