import { KeywordOpportunityInputsRepository } from "@/server/features/domain/repositories/KeywordOpportunityInputsRepository";
import {
  rankContentOpportunities,
  OPPORTUNITY_RANKING_VERSION,
  type OpportunityMeasurement,
  type OpportunityRanking,
} from "@/server/lib/opportunity/opportunityRanking";

/**
 * The service behind the "What to Build" decision layer.
 *
 * ## What this is
 *
 * The first feature in the product that reads the instrument and tells the
 * customer what to do, rather than showing them a number and leaving the
 * judgement to them. Every surface before this one measured something; this one
 * ranks it.
 *
 * ## Why it is a service and not a repository call
 *
 * The repository returns rows; the decision layer needs one measurement per
 * keyword, newest-first, and that shaping is a policy rather than a query. Keeping
 * it here follows the repo's own rule (server function → service → repository) and
 * keeps the repository a plain reader.
 *
 * ## The reachability requirement
 *
 * This is the third appearance of "correct component with an unreachable input":
 * the evidence drawer, the forecast, and the ETV chart all had every layer built
 * and one call site missing. So this service does not ship unless a caller
 * reaches it, and `scripts/geo-module-reachability.test.ts` plus knip are the
 * instruments that enforce that here.
 */

/** How many measurements per keyword feed the band. */
const MEASUREMENTS_PER_KEYWORD = 40;

export const ContentOpportunityService = {
  /**
   * The ranked content opportunities for a project.
   *
   * `injectRows` exists for the same reason `scheduledEtvCapture` injects its
   * fetcher: a test must be able to drive this without a database. The shape is
   * the repository's own return type, so a double is a drop-in replacement.
   */
  async rankForProject(input: {
    projectId: string;
    injectRows?: () => Promise<
      Array<{
        keyword: string;
        locationCode: number;
        keywordDifficulty: number | null;
        serpCompetitors: number | null;
        intent: string | null;
        aiNativeRatioBp: number | null;
        rankElasticityBp: number | null;
      }>
    >;
  }): Promise<OpportunityRanking> {
    const rows =
      (await input.injectRows?.()) ??
      (await KeywordOpportunityInputsRepository.listRecentByProject({
        projectId: input.projectId,
        perKeyword: MEASUREMENTS_PER_KEYWORD,
      }));

    /**
     * Grouped by keyword **in a market**, preserving the repository's order.
     *
     * The repository is newest-first, so the first row of each group is the
     * latest reading — the one the score reports — and the rest set the band.
     * Grouping with `push` in encounter order keeps that: reversing it would put
     * the oldest reading at the top and report a stale score.
     *
     * **The market is part of the identity, not a column beside it.** `seriesFor`
     * keys on `(project, keyword, location)` because difficulty for one keyword
     * in two markets is two numbers, and averaging them would report a value the
     * vendor never published. The ranking's unit is therefore the keyword-in-market.
     */
    const byKeyword = new Map<string, OpportunityMeasurement[]>();
    for (const row of rows) {
      const keyword = row.keyword.trim().toLowerCase();
      const key = `${keyword}|${row.locationCode}`;
      const bucket = byKeyword.get(key) ?? [];
      bucket.push({
        keywordDifficulty: row.keywordDifficulty,
        serpCompetitors: row.serpCompetitors,
        intent: row.intent,
        aiNativeRatioBp: row.aiNativeRatioBp,
        rankElasticityBp: row.rankElasticityBp,
      });
      byKeyword.set(key, bucket);
    }

    // The ranking's keyword is the bare keyword; the market stays in the key so
    // two markets are two ranked items rather than one average.
    const ranking = rankContentOpportunities({
      measurementsByKeyword: byKeyword,
    });

    // The ranking's keyword is the bare keyword; the market stays in the map key
    // so two markets are two ranked items rather than one average. Split on the
    // separator the map used — a `.at(0)` rather than a cast, because the string
    // is always non-empty here and a cast would hide a future shape change.
    const items = ranking.items.map((item) => ({
      ...item,
      keyword: item.keyword.split("|")[0] ?? item.keyword,
    }));

    // The model's own version, re-used rather than re-declared: two strings that
    // must agree is a second source of truth, and this one drifts the day the
    // ranking model is revised.
    return { items, version: OPPORTUNITY_RANKING_VERSION };
  },
};
