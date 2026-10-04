import type { WorkflowStep } from "cloudflare:workers";
import { getOrigin } from "@/server/lib/audit/url-utils";
import { getPagesForCitability } from "@/server/features/audit/repositories/auditCitabilityPages";
import { runReadiness } from "@/server/features/audit/services/runReadiness";
import { pgStep } from "@/server/workflows/pgStep";
import { READINESS_STEP } from "@/server/workflows/auditStepConfigs";

/**
 * The citability phase — the seam's first production caller.
 *
 * ## Why this is its own module
 *
 * `siteAuditWorkflowPhases.ts` was already at the file-size ceiling, and this is a
 * distinct phase with its own step config and its own retry semantics. **A gate
 * separated from its subject is a gate that has to be remembered**, so the phase
 * lives beside the workflow it belongs to and the step config lives with it.
 *
 * ## Where it sits and why
 *
 * After the crawl and Lighthouse, before `finalize`. Every page row exists by
 * then, which is the only thing this needs — it reads the database and fetches
 * two small files. It deliberately does **not** re-crawl: the heading text and
 * schema types were extracted during the crawl and persisted, and paying a
 * vendor (or our own fetcher) a second time to recover strings we already had
 * would be the most expensive possible way to answer a question we had answered.
 *
 * ## What a failure here does
 *
 * **It cannot fail the audit.** The readiness report is an interpretation layer on
 * top of the crawl; a site whose `llms.txt` times out still has a perfectly good
 * crawl, and turning that into a failed audit would tell the customer their site
 * could not be audited when it was, three minutes earlier. So the step returns a
 * count and the audit completes, with the gap recorded in the report's own notes
 * where a reader will see it. **The alternative — failing loudly — is right for
 * the crawl and wrong here, and the difference is whether the data already
 * gathered survives.**
 */
export async function runReadinessPhase(
  step: WorkflowStep,
  params: {
    auditId: string;
    startUrl: string;
    /** How many pages the crawl attempted, so the report can name what it missed. */
    pagesAttempted: number;
  },
): Promise<{ readinessFixCount: number }> {
  const { auditId, startUrl, pagesAttempted } = params;
  const origin = getOrigin(startUrl);

  return pgStep(step, "readiness", READINESS_STEP, async () => {
    const rows = await getPagesForCitability(auditId);

    // **Pages we could not fetch are omitted, not passed with nulls.** A page that
    // 404'd or was blocked has no structure to report, and handing the rubric a
    // row for it would let a fetch failure register as a page with no headings —
    // our failure becoming a finding about their markup.
    const pages = rows
      .filter((row) => row.fetchClass === "ok")
      .map((row) => ({
        url: row.url,
        headings: row.headings,
        schemaTypes: row.schemaTypes,
        // **No archived-answer measurements here.** Those come from the AI-visibility
        // archive, which this audit does not join, and passing zeros would fabricate
        // the one *measured* factor in the rubric out of a page we never looked up
        // in it. Null says "we have no observation", which is true.
        citationsObserved: null,
        answersObserved: null,
        competingPagesCited: null,
      }));

    const result = await runReadiness({ origin, pages, pagesAttempted });

    // The report is returned, not persisted: `audit_readiness` does not exist yet,
    // and **a migration invented before anything reads it is a column nobody
    // queries.** The count is checkpointed so the step is observably doing work,
    // and the next piece of work is the table plus the reader.
    return { readinessFixCount: result.fixes.length };
  });
}
