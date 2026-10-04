/**
 * The two JSON columns the citability report reads, derived from a crawled page.
 *
 * ## Why this is a pure function and not inline in the row mapper
 *
 * **Because the inline version was untestable, and untestable means it breaks.**
 * Both of these columns are written inside `insertCrawledBatch`'s mapper, which is
 * only reachable through a database — and a mutation dropping either one left
 * **every suite in the repository green**, because nothing could see the write
 * stop happening. That is `a rule that cannot be tested without infrastructure is
 * a rule that will not be tested`, caught by the mutator rather than by review.
 *
 * ## Why `null` for a page that was never analysed
 *
 * `[]` means *parsed, and declared nothing* — a finding. `null` means *we never
 * looked*, which is a gap in our coverage and which the report scores differently.
 * A non-HTML page (a PDF) was never analysed at all, so it writes `null` rather
 * than a claim about markup it never read.
 */
export function citabilityColumns(page: {
  isHtml: boolean;
  headings: Array<{ level: number; title: string }>;
  schemaTypes: string[];
}): {
  headingsJson: string | null;
  schemaTypesJson: string | null;
} {
  if (!page.isHtml) return { headingsJson: null, schemaTypesJson: null };
  return {
    headingsJson: JSON.stringify(page.headings),
    schemaTypesJson: JSON.stringify(page.schemaTypes),
  };
}

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditPages } from "@/db/schema";

/**
 * Reading the page rows the citability report needs.
 *
 * ## Why this is its own module
 *
 * `AuditRepository` was at the file-size ceiling, and the split falls on a real
 * seam rather than an arbitrary one: everything here answers *what does the audit
 * know about a page's structure*, while everything there is the **lifecycle** —
 * create, progress, complete, delete. A reader added to a lifecycle module is a
 * reader someone has to find; here it is the only thing in the file.
 */
/**
 * The page rows the citability report needs, with their JSON columns parsed.
 *
 * **Separate from `getPagesForAudit` because this one parses and that one does
 * not.** Its sole consumer is a Lighthouse sample selector that wants counts and
 * URLs, and handing it parsed structures would mean parsing a JSON blob per page
 * to read none of it. The projection here is the narrow one the rubric actually
 * consumes, plus the two JSON columns — and each is parsed defensively.
 *
 * `fetchClass` is included and matters: a page we could not fetch has no
 * structure to report, and counting one as a page with no headings would turn our
 * own failure into a finding about their markup.
 */
export async function getPagesForCitability(auditId: string) {
  const rows = await db
    .select({
      url: auditPages.url,
      fetchClass: auditPages.fetchClass,
      headingsJson: auditPages.headingsJson,
      schemaTypesJson: auditPages.schemaTypesJson,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));

  return rows.map((row) => ({
    url: row.url,
    fetchClass: row.fetchClass,
    headings: parseJsonArray<{ level: number; title: string }>(
      row.headingsJson,
    ),
    schemaTypes: parseJsonArray<string>(row.schemaTypesJson),
  }));
}

/**
 * Parse a JSON column, returning `null` for anything unreadable.
 *
 * **Null on failure, never `[]`.** An empty array is a claim — *this page was
 * parsed and declared nothing* — and it is a finding. A blob we cannot parse, or
 * a column from before the migration, is *we do not know*, which the report scores
 * as unmeasured. **Collapsing the two turns our own gap into a defect in the
 * customer's markup**, which is the exact failure the null convention exists to
 * prevent.
 *
 * **Exported so it can be tested directly.** The rule above is the whole of this
 * function, and it was unreachable from every suite in the repository while it was
 * private — a change from `null` to `[]` here would have passed all 2,900+ tests,
 * because the only caller is mocked wherever the phase is tested. **A rule that
 * cannot be tested without a database is a rule that will not be tested**, and
 * this one needs nothing but a string.
 */
export function parseJsonArray<T>(raw: string | null): T[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // **The array check is a real narrowing; the element type is not verified.**
    // These columns are written by this codebase and read back by the same
    // version, so a per-element validator would be a second place for the two to
    // disagree — and an unverifiable assertion is worse than an honest one. The
    // cast is confined to this single line and the array check above is what makes
    // it sound.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded by the Array.isArray above; element shapes are written and read by the same version
    return parsed as T[];
  } catch {
    return null;
  }
}
