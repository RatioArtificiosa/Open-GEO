import { asc } from "drizzle-orm";
import { db } from "@/db";
import { savedKeywords } from "@/db/schema";

/**
 * The tracked keywords a nightly capture reads, per project.
 *
 * ## Why this file exists
 *
 * `scheduledOpportunityInputs` was written and tested and shipped with **no
 * caller**, because its input is `{ projectIds, keywordsByProject, locationCode }`
 * and nothing in the codebase could produce those two shapes. The service was
 * honest — it took its inputs as parameters because there was no source to read
 * — and that honesty is exactly what made it dead code: with no repository
 * method standing behind the signature, there was no way to wire it.
 *
 * `saved_keywords` is the table that fills the gap. A project's keyword research
 * list is precisely "the keywords this project tracks, and in which market", and
 * it is stored there with `locationCode` and `languageCode` on every row.
 *
 * ## The market comes from the row, not from a setting
 *
 * `runOpportunityInputCapture` takes one `locationCode` per call, so the read
 * has to pick a market for each project. Reading it from the keyword's own row
 * rather than from a project-level setting is deliberate: `saved_keywords`
 * allows the same keyword in several markets, and a single project-wide default
 * would silently pick one and drop the rest.
 *
 * ## Distinct, because the unique index is not a distinct guarantee
 *
 * The unique index is `(project_id, keyword, location_code, language_code)`, so a
 * project can hold the same keyword under two language codes — `en` and `en-GB`,
 * for instance, which return different difficulty from the vendor. Both are real
 * tracked keywords and both are captured; what the query removes is the exact
 * duplicate the index already forbids.
 */

/** One project's tracked keyword, with the market it is tracked in. */
export type TrackedKeywordRow = {
  projectId: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
};

/**
 * Every tracked keyword, grouped by project, for the nightly opportunity sweep.
 *
 * Ordered by `createdAt` so the *oldest* tracked keyword is captured first: a
 * project that keeps adding keywords should not have its first ones starved by
 * its latest ones, which is the fairness rule the GEO patrol and the ETV
 * rotation already apply in their own languages.
 */
export const TrackedKeywordsRepository = {
  async listAllByProject(): Promise<TrackedKeywordRow[]> {
    const rows = await db
      .select({
        projectId: savedKeywords.projectId,
        keyword: savedKeywords.keyword,
        locationCode: savedKeywords.locationCode,
        languageCode: savedKeywords.languageCode,
      })
      .from(savedKeywords)
      .orderBy(asc(savedKeywords.createdAt), asc(savedKeywords.id));

    return rows.map((row) => ({
      projectId: row.projectId,
      keyword: row.keyword,
      locationCode: row.locationCode,
      languageCode: row.languageCode,
    }));
  },

  /** The distinct projects that track at least one keyword. */
  async listProjects(): Promise<
    Array<{ projectId: string; keywordCount: number }>
  > {
    const rows = await this.listAllByProject();
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1);
    }
    return [...counts].map(([projectId, keywordCount]) => ({
      projectId,
      keywordCount,
    }));
  },
};
