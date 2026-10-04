import { db } from "@/db";
import { auditReadiness } from "@/db/schema";
import { deterministicAuditRowId } from "@/server/lib/audit/ids";

/**
 * Writing the readiness report.
 *
 * The reading side lives in `auditReadinessReports.parse.ts`, because **the rules
 * about what a corrupt or absent value *means* are decisions, and decisions
 * reachable only through a database are decisions nobody tests.** This file is the
 * plumbing; that one is the reasoning.
 *
 * ## Idempotency, because the step retries
 *
 * `READINESS_STEP` allows two retries, so the same report can be written twice.
 * The row id is derived from `auditId` alone — **not** from a timestamp or a
 * counter — so the second write is the *same row* and the upsert replaces it. A
 * fresh id per attempt would leave the audit holding three reports, and the reader
 * would have to guess which one is current.
 *
 * ## One row, and the fixes are a JSON array
 *
 * **The ordering is the claim.** CL-302's argument is that a blocked crawler
 * outranks everything because it is a *precondition* — not because its weight is
 * highest — so fixes stored as unordered rows would lose the one thing the report
 * exists to say.
 *
 * ## No score column, and that is the schema's job
 *
 * A site with a blocked crawler and perfect content averages to a healthy-looking
 * middle, so a number here would *hide* the only finding that mattered.
 * `why_no_score` is `notNull` for the same reason: the reason there is no headline
 * is the report's most useful sentence, and a nullable column would let a future
 * writer skip it.
 */
export async function saveReadinessReport(input: {
  auditId: string;
  summary: string;
  whyNoScore: string;
  fixes: unknown[];
  coverage: string[];
  unavailable: unknown[];
  pageCount: number;
}): Promise<void> {
  const id = await deterministicAuditRowId(input.auditId, "readiness");

  const columns = {
    summary: input.summary,
    whyNoScore: input.whyNoScore,
    fixesJson: JSON.stringify(input.fixes),
    coverageJson: JSON.stringify(input.coverage),
    unavailableJson: JSON.stringify(input.unavailable),
    fixCount: input.fixes.length,
    pageCount: input.pageCount,
  };

  await db
    .insert(auditReadiness)
    .values({ id, auditId: input.auditId, ...columns })
    .onConflictDoUpdate({ target: auditReadiness.id, set: columns });
}
