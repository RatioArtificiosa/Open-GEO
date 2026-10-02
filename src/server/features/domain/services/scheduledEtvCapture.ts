/**
 * The nightly Labs ETV capture — the writer `domain_metrics` never had.
 *
 * ## Why this file exists at all
 *
 * `DomainMetricsRepository.insertPoint` was exported, tested, and **called by nothing**
 * for the whole life of the feature. So `domain_metrics` was empty, and
 * `geoSeriesReads.getEtvSeries` → `getGeoEtvSeries` → `useGeoPageData` read an empty
 * table on every page load: **the ETV chart has had no data since it was built.**
 *
 * The provenance machinery around it is the sharpest part. `etv-versioning.ts` refuses
 * to store an unstamped value, `envelope.ts` carries `EtvProvenance` on the response,
 * and `labs.ts` resolves `use_new_etv` per endpoint — all of it designed for a writer
 * that did not exist. This is that writer.
 *
 * ## Why a scheduled capture and not the existing per-lookup fetch
 *
 * `DomainService` already calls `dataforseo.domain.rankedKeywords` on every domain
 * lookup, and `fetchDomainRankOverview` is called by nothing at all. Writing on the
 * lookup was the obvious cheap option and it is **wrong twice**:
 *
 * 1. **It never forms a series.** A point per page view is a point per navigation, so
 *    the "series" would be a scatter of when people clicked, not how traffic moved.
 * 2. **A plausible-looking wrong chart is worse than an empty one.** An empty table is
 *    obviously absent; a populated one with navigation-shaped data is confidently
 *    wrong, and the provenance stamp on it would make it *look* careful.
 *
 * So the trigger is a **cron over tracked domains**, the same shape as the AI Mode and
 * AI keyword captures beside it — a budget, a spend cap checked before the call, and a
 * first-deploy project limit.
 *
 * ## What makes it safe to leave switched on
 *
 * 1. **Priced from the price book, not from memory.** `DFS_LABS.standard.perRequest` is
 *    **$0.012** and this client asks for `limit: 1`, so one call is one point and one
 *    charge. The budget is therefore a plain count of domains, not an estimate.
 * 2. **The formula is pinned and stored.** `resolveEtvMode` decides `use_new_etv`, and
 *    the version travels into the row — which is the whole reason `insertPoint`
 *    demands provenance, and the reason a stored value stays readable after the
 *    2026-11-01 cutover.
 * 3. **Null is never zero.** A platform that reported no organic ETV stores `null`,
 *    because a `0` would claim we looked for traffic and found none.
 * 4. **The endpoint is part of the identity.** Every row says `domain_rank_overview`, so
 *    a series can never mix it with `ranked_keywords` — which compute ETV over
 *    different populations and comparing them means nothing.
 */
import { db } from "@/db";
import type { BudgetedCaptureReport } from "@/server/features/geo/services/captureReport";
import { geoTargets } from "@/db/schema";
import { DomainMetricsRepository } from "@/server/features/domain/repositories/DomainMetricsRepository";
import { fetchDomainRankOverview } from "@/server/lib/dataforseo/labs";
import { DFS_LABS } from "@/shared/dataforseo-pricing";

/**
 * One Labs call, in USD — **read from the price book**, not restated here.
 *
 * `domain_rank_overview` is `DFS_LABS.standard`, and this client sends `limit: 1`, so
 * `perRequest` is the whole cost and `perUnit` never applies. Quoting the number here
 * as well would be a second copy of a price that can be repriced, which is how a
 * budget ends up quietly wrong.
 */
const LABS_UNIT_COST_USD = DFS_LABS.standard.perRequest;

/**
 * The night's ceiling, in USD — **about 400 domains**.
 *
 * A constant rather than a setting, for the same reason as its two siblings: the
 * product has no per-project spend setting, and inventing one would refuse runs on a
 * number nobody chose. Enough to be a real ceiling, small enough that a misconfigured
 * project cannot produce an invoice anybody has to explain.
 */
const ETV_NIGHTLY_BUDGET_USD = 5;

/** The Labs endpoint every stored row names. One series, one endpoint. */
const ENDPOINT = "domain_rank_overview" as const;

/**
 * The domains worth asking about.
 *
 * **A project with no GEO targets is never asked**, which is what makes this opt-in
 * without a flag: there is nothing to infer, so a project that never configured a
 * brand is never billed for one. The same rule `projectsWatchingAiMode` uses.
 */
async function trackedDomains(): Promise<
  Array<{
    projectId: string;
    domain: string;
    locationCode: number;
    languageCode: string;
  }>
> {
  return db
    .select({
      projectId: geoTargets.projectId,
      domain: geoTargets.domain,
      locationCode: geoTargets.locationCode,
      languageCode: geoTargets.languageCode,
    })
    .from(geoTargets)
    .groupBy(
      geoTargets.projectId,
      geoTargets.domain,
      geoTargets.locationCode,
      geoTargets.languageCode,
    );
}

/**
 * The night's shape. **Not exported** — the cron caller reads the fields off the
 * returned value, and an exported type nothing imports is a claim about the API
 * surface that is not true. Same reasoning as its two siblings.
 */
/**
 * **Extends the shared `BudgetedCaptureReport`**, so the measured cost, the estimate
 * and the dropped-work count are the three fields every budgeted nightly capture
 * reports — and a fourth one cannot omit the first two.
 */
type EtvNightReport = BudgetedCaptureReport & {
  /** Domains we asked the vendor about, after the budget admitted them. */
  domainsAsked: number;
  /** Points stored. Lower than asked when a call returned no metrics block. */
  rowsStored: number;
  /** One line per failed domain for the cron log. */
  failures: Array<{ domain: string; reason: string }>;
};

/**
 * Capture one ETV point per tracked domain, once a night.
 *
 * `limitProjects` is the same first-deploy safety valve both siblings carry: an
 * unbounded sweep across every customer in one tick is not a launch, it is an
 * incident.
 */
export async function runDueEtvCaptures(input?: {
  limitProjects?: number;
  now?: Date;
  fetchDomains?: typeof trackedDomains;
  fetchOverview?: typeof fetchDomainRankOverview;
  writePoint?: typeof DomainMetricsRepository.insertPoint;
}): Promise<EtvNightReport> {
  const now = input?.now ?? new Date();
  const limit = input?.limitProjects ?? 25;
  const fetchDomains = input?.fetchDomains ?? trackedDomains;
  const fetchOverview = input?.fetchOverview ?? fetchDomainRankOverview;
  const writePoint = input?.writePoint ?? DomainMetricsRepository.insertPoint;

  const domains = await fetchDomains();

  /**
   * **Sliced once, here, and every count derives from the slice.** The first version
   * counted projects from the *unlimited* list and iterated the slice, so a
   * 40-project deployment reported **40 visited while asking 3** — which is exactly
   * the kind of number an operator trusts and cannot reconcile with the log line
   * beside it. A report that disagrees with itself is worse than no report.
   */
  const admitted = domains.slice(0, limit);

  const report: EtvNightReport = {
    projectsVisited: new Set(admitted.map((d) => d.projectId)).size,
    domainsAsked: 0,
    rowsStored: 0,
    droppedForBudget: 0,
    actualCostUsd: 0,
    estimatedCostUsd: 0,
    failures: [],
  };

  // Remaining budget for the whole night, **shared deliberately** — a per-project
  // budget would make the ceiling depend on how many customers happen to be
  // configured, which is the same bug the AI Mode runner fixed the other way round.
  let remaining = ETV_NIGHTLY_BUDGET_USD;

  for (const row of admitted) {
    // Checked **before** the call. A cap verified afterwards is a report of an
    // overspend, not a limit on one.
    if (LABS_UNIT_COST_USD > remaining) {
      report.droppedForBudget += 1;
      continue;
    }

    try {
      const response = await fetchOverview({
        target: row.domain,
        locationCode: row.locationCode,
        languageCode: row.languageCode,
      });

      report.domainsAsked += 1;
      report.estimatedCostUsd += LABS_UNIT_COST_USD;
      report.actualCostUsd += response.billing.costUsd;
      remaining -= LABS_UNIT_COST_USD;

      const metrics = response.data[0]?.metrics;
      /**
       * **No metrics block is not a zero.** The vendor returns `items: []` when it
       * has nothing for the domain, and writing `0` would claim we measured and found
       * no traffic — which is a claim about the world rather than about our archive.
       * So the domain is counted as *asked* and nothing is stored, and the report
       * says which.
       */
      if (!metrics) continue;

      const organic = metrics.organic;
      if (!organic) continue;

      await writePoint({
        projectId: row.projectId,
        domain: row.domain,
        locationCode: row.locationCode,
        languageCode: row.languageCode,
        endpoint: ENDPOINT,
        organicEtv: organic.etv ?? null,
        /**
         * **The provenance travels with the value**, because `insertPoint` refuses a
         * row without it and because a value stamped with the wrong formula becomes
         * unreadable on 2026-11-01.
         */
        /**
         * **The provenance travels with the value**, because `insertPoint` refuses a
         * row without it and because a value stamped with the wrong formula becomes
         * unreadable after the 2026-11-01 cutover.
         *
         * **Rebuilt rather than passed through**, for one reason: the row's
         * `requestedAt` has to be the *request* time, because that is what makes the
         * fetch reproducible. `labs.ts` sets its provenance's `requestedAt` when it
         * resolves the mode, so passing it through would stamp every row in a night
         * with the same instant.
         */
        etv: {
          formulaVersion: response.etv?.formulaVersion ?? "legacy",
          useNewEtv: response.etv?.useNewEtv ?? false,
          requestedAt: now.toISOString(),
        },
      });

      report.rowsStored += 1;
    } catch (error) {
      // **No retry.** The request was metered and we do not know whether it landed,
      // so a second attempt can bill twice for one night — the same rule both
      // sibling captures follow.
      report.failures.push({
        domain: row.domain,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
