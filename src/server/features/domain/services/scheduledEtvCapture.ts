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
import { and, eq, max, sql } from "drizzle-orm";
import { db } from "@/db";
import type { BudgetedCaptureReport } from "@/server/features/geo/services/captureReport";
import { geoTargets } from "@/db/schema";
import { domainMetrics } from "@/db/schema";
import { DomainMetricsRepository } from "@/server/features/domain/repositories/DomainMetricsRepository";
import { fetchDomainRankOverview } from "@/server/lib/dataforseo/labs";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import {
  NIGHTLY_BUDGET_USD,
  PER_PROJECT_NIGHTLY_CAP,
  NIGHTLY_PROJECT_SWEEP_LIMIT,
} from "@/shared/nightly-budgets";

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
 *
 * **And that paragraph was wrong, because it described this constant's opposite.**
 * `scheduledGeoPatrol.ts` states the product's actual position in the same words and
 * then passes `budgetUsd: null` — *"the cap is null, and that is a decision, not an
 * omission"*. I quoted that reasoning here and then wrote a number into it anyway,
 * because a sibling module had `$0.1` and citing that sibling felt like following
 * precedent.
 *
 * **So: `$5` is a placeholder pending the pricing plan, not a chosen ceiling**, and it
 * is named as one below. The difference matters — a chosen ceiling answers *how much
 * per night*; a placeholder answers *not yet*, and refusing runs on a guessed number
 * would hide coverage rather than cost it.
 */
/**
 * A **placeholder pending the pricing plan**, and named as one.
 *
 * **What the alternatives actually cost**, because a placeholder nobody can judge is a
 * placeholder nobody can overrule:
 *
 * | tracked domains | this ceiling | `null`, the patrol's answer |
 * |---|---|---|
 * | 25 | $0.30 | $0.30 |
 * | 1,000 | $12.00 | $12.00 |
 * | 5,000 | $0.30 | **$60.00** |
 *
 * **So `null` is not the neutral choice it looks like.** In `patrolSpend.ts` a `null`
 * budget means *"no budget"* - the decision returns `allowed: true` with no ceiling - so
 * adopting it here would mean one customer with 5,000 brands spends $60.00 a night with
 * nothing refusing it. The main patrol can pass `null` safely because it is bounded by
 * `maxAnswers`; **this capture is bounded only by how many domains a customer tracks.**
 *
 * **And the ceiling's own denominator is read from the price book** ($0.012 a call, so 416 calls
 * fit). A ceiling computed from an unverified price is a guess with a unit.
 *
 * **What a decision needs:** whether `$5` is right, and what bounds one project whose tracked
 * count exceeds what the ceiling affords. Today nothing does - `limitProjects` counts
 * *projects*, not domains, so a single large customer is unbounded within the ceiling's own
 * terms.
 *
 * `$5` buys 416 Labs calls, which is a plausible night for a few hundred tracked
 * domains — but plausible is not chosen, and the difference decides what happens when
 * the number is wrong: a chosen ceiling that is too low silently drops coverage, while a
 * placeholder that is too low drops coverage **loudly**, because the report names the
 * dropped domains.
 *
 * **It becomes a real ceiling when a pricing plan supplies one.** Until then this is the
 * same placeholder the AI keyword capture carries, and the honest default would be
 * `null` — bounded by the project's own tracked domains rather than by a number I picked.
 * It is a number rather than `null` so the capture is safe to switch on before that
 * decision is made.
 */
/**
 * **Read from {@link NIGHTLY_BUDGET_USD}** rather than declared here, because the budget is
 * policy shared with the sibling captures and the price book it divides by — and a
 * constant in two places is a constant that drifts.
 */
const ETV_NIGHTLY_BUDGET_USD = NIGHTLY_BUDGET_USD.etv;

/**
 * How many of one project's domains the capture covers per night.
 *
 * **This is the bound that actually holds, and the money ceiling is not.** The ceiling
 * above bounds a *night*; this bounds a *customer*, which is the axis that matters when one
 * account holds more domains than the ceiling can afford.
 *
 * The arithmetic that made it necessary:
 *
 * | domains on one project | at `$0.012` a call |
 * |---|---|
 * | 25 | $0.30 |
 * | 1,000 | $12.00 — past a $5 night |
 * | 5,000 | $60.00 |
 *
 * Nothing in the product caps a project's tracked domains — `geo_targets` has a unique
 * index on (project, domain, market), which prevents *duplicates* and not a *count*. So
 * before this, one large customer could spend $60 a night with the log naming it as
 * dropped work rather than as a problem.
 *
 * **A count rather than a price, deliberately.** A proportional budget would need the unit
 * price to mean anything, and the AI keyword capture's is still unverified — so a budget
 * derived from it is a guess with a unit. A domain count is exact whatever the vendor
 * charges.
 *
 * **And the dropped domains are named**, which is what makes a cap honest: a reader sees
 * *which* domains went unmeasured rather than a number they have to trust.
 */
const MAX_DOMAINS_PER_PROJECT_PER_NIGHT = PER_PROJECT_NIGHTLY_CAP.etvDomains;

/**
 * **This cap is safe only because the set rotates, and it did not until this line
 * existed.** The first version sliced the first 25 of a list with no `ORDER BY` and no
 * cursor, so a customer with 500 domains had **the same 25 measured every night** and the
 * other 475 were never measured at all. That is not "coverage rotates slowly"; it is
 * **coverage absent** for everyone past the cap — and it is the same shape as CL-308i,
 * where a global oldest-first cap let one busy project fill every tick and a small
 * project's task was never looked at.
 *
 * ````
 * domains tracked | nights to cover all, in order
 * 25              | 1     - the whole set, every night
 * 500             | 20    - each domain measured once every 20 nights
 * ````
 *
 * **Ordering by `capturedAt ASC` is what makes that true**: the archive holds when each
 * domain was last measured, so "measured least recently" is already known and needs no
 * state. A domain with **no row sorts first**, which is exactly right — never measured
 * outranks measured long ago, and both outrank measured tonight.
 *
 * **`NULLS FIRST` because that ordering is the whole mechanism.** Written out rather
 * than left to the engine's default, since a dialect that sorts nulls last would invert
 * the policy without failing: the never-measured domains would sit behind the ones
 * measured tonight, and the cap would go straight back to starving them.
 *
 * **Stable, so two domains measured on the same night keep a predictable order** rather
 * than swapping places on each tie and never advancing.
 */

/** The Labs endpoint every stored row names. One series, one endpoint. */
const ENDPOINT = "domain_rank_overview" as const;

/**
 * When this domain was last asked about, per project.
 *
 * **`etvRequestedAt`, not `capturedAt` or the row's own id.** The schema says what that
 * column is for — *"when we asked the vendor, as opposed to when it answered"* — and asking
 * is the event that determines staleness. `MAX` across rows because a domain has one per
 * capture and the newest is the one that says how fresh it is.
 *
 * **Derived from the archive rather than tracked separately**, because the stored
 * timestamp already answers the question and a second cursor would be a second thing to
 * keep correct.
 *
 * **A grouped subquery rather than a correlated lookup per row**: one pass for the whole
 * list, which matters because this runs every night over every tracked domain. And
 * **`leftJoin`, not `innerJoin`, at the call site** — an inner join would drop every
 * never-measured domain from the candidate list, which is precisely the set the capture
 * most needs to reach.
 *
 * **One named expression, used twice** — once inside the subquery and once in the
 * ordering. Written separately they *look* equivalent and can silently drift, and the
 * failure is invisible: the query still runs, it just orders by a different column than
 * the one it selected, so the rotation quietly stops rotating.
 *
 * **One named expression, used twice** — once inside the subquery and once in the
 * ordering. Written separately they *look* equivalent and can silently drift, and the
 * failure is invisible: the query still runs, it just orders by a different column
 * than the one it selected, so the rotation quietly stops rotating.
 */
/**
 * The aggregation, named because the **ordering must reference the subquery's alias**
 * rather than this — see the note at the `orderBy`.
 */
const lastAskedAt = max(domainMetrics.etvRequestedAt);

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
  /**
   * Built here rather than at module scope, and that is deliberate twice over.
   *
   * **A query builder is not a constant** — a module-level `db.select(...)` binds to
   * whatever `@/db` resolved to at import time, which pins the connection for the
   * process's life and makes this module impossible to test against a substitute
   * database. Found the hard way: the rotation's own db test failed with
   * `no such column` while the schema plainly had the column, because the subquery was
   * built against the *real* handle and the test's in-memory one never saw it.
   *
   * **The column expression stays at module scope**, because that genuinely is a
   * constant — and using one name for both is what keeps the aggregate in the
   * `SELECT` and the same aggregate in the `ORDER BY` from drifting apart.
   */
  /**
   * When each **project** was last measured, at all.
   *
   * **The same one-level-too-low bug the keyword capture had** (`b61c513`), and worth
   * spelling out because the naming hides it: `runDueEtvCaptures` does
   * `domains.slice(0, limitProjects)`, so **`limitProjects` bounds domains** while this
   * query rotates **per domain**. A rotation one level below the bound does nothing for
   * the bound — in a deployment with more than `limitProjects` domains, the same ones win
   * every night and the rest are never measured.
   *
   * | | rotates | the bound acts on |
   * |---|---|---|
   * | `trackedDomains` | per domain | **domains — never rotated** |
   *
   * And the name compounds it: `limitProjects` sounds like it bounds projects, and it does
   * not. **What is the cap applied to, and is *that* rotated?** is the question; the
   * parameter's name is not an answer to it.
   */
  const projectLastMeasured = db
    .select({
      projectId: domainMetrics.projectId,
      at: lastAskedAt.as("project_at"),
    })
    .from(domainMetrics)
    .groupBy(domainMetrics.projectId)
    .as("projectLastMeasured");

  const lastMeasured = db
    .select({
      projectId: domainMetrics.projectId,
      domain: domainMetrics.domain,
      at: lastAskedAt.as("at"),
    })
    .from(domainMetrics)
    .groupBy(domainMetrics.projectId, domainMetrics.domain)
    // **The same shape `snapshotQueries.ts` uses for its grouped join**, so this reads
    // as the pattern it is rather than as a one-off.
    .as("lastMeasured");

  return (
    db
      .select({
        projectId: geoTargets.projectId,
        domain: geoTargets.domain,
        locationCode: geoTargets.locationCode,
        languageCode: geoTargets.languageCode,
      })
      .from(geoTargets)
      // **When this domain was last measured, or NULL for never.** The left join is the
      // whole mechanism: an inner join would drop every unmeasured domain from the
      // candidate list, which is precisely the set the capture most needs to reach.
      .leftJoin(
        lastMeasured,
        and(
          eq(lastMeasured.projectId, geoTargets.projectId),
          eq(lastMeasured.domain, geoTargets.domain),
        ),
      )
      // **The project's own last measurement**, joined on the project alone. A second
      // `leftJoin` rather than another `groupBy`, because one query cannot aggregate
      // twice over at different grains.
      .leftJoin(
        projectLastMeasured,
        eq(projectLastMeasured.projectId, geoTargets.projectId),
      )
      // **Nulls first, then oldest first, then by name.**
      //
      // The `is null` term is the whole policy, written out rather than left to the
      // engine: a dialect that sorted nulls last would put every never-measured domain
      // *behind* the ones measured tonight, and the cap would go straight back to
      // starving exactly the set the capture most needs to reach. Explicit, the intent
      // survives a dialect change.
      //
      // **No `groupBy`, because none is needed.** `geo_targets` has a unique index on
      // (project, domain, market), so this query already returns one row per domain. The
      // grouping I first wrote existed only to satisfy the join, and duplicated a
      // constraint the schema already states.
      // **Project rotation first, domain rotation second — the order is the fix.**
      // `domains.slice(0, limitProjects)` takes the front of this list, so the first
      // term decides which projects get a night at all. Rotating only *within* a project
      // cannot change that: for a deployment of many projects the per-domain order is
      // the same every night, so the same domains win every night.
      //
      // Within a project, the `is null` term then pushes its never-measured domains
      // ahead of its measured ones — the rotation the per-domain subquery exists for.
      //
      // **Wrapped in `sql```: `orderBy` wants a `SQL` or a column, and an alias is
      // neither by type though it is by name.** Two aliases, `project_at` and
      // `domain_at`, because two columns called `at` in one outer query make
      // `order by "at"` ambiguous — which SQLite rejects outright.
      .orderBy(
        sql`${projectLastMeasured.at} is null desc`,
        sql`${projectLastMeasured.at}`,
        sql`${lastMeasured.at} is null desc`,
        sql`${lastMeasured.at}`,
        geoTargets.domain,
      )
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
 * `limitProjects` is the shared first-deploy safety valve
 * ({@link NIGHTLY_PROJECT_SWEEP_LIMIT}, which the sibling sweeps also read): an
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
  const limit = input?.limitProjects ?? NIGHTLY_PROJECT_SWEEP_LIMIT;
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

  /**
   * **The per-project cap, applied before the money check** — because a cap that can
   * be reached by spending is not a cap on a customer, it is a suggestion.
   *
   * Counted per project rather than across the night, so one account with 5,000 domains
   * is bounded at the same 25 as one with 5. The overflow is **added to
   * `droppedForBudget`** rather than to a field of its own: from the log's point of view
   * *"we did not measure this"* is the same sentence whichever limit produced it, and two
   * counters for one idea is one more thing to keep in step.
   */
  const perProjectSeen = new Map<string, number>();
  const admittedWithinProjectCap: typeof admitted = [];
  for (const row of admitted) {
    const seen = perProjectSeen.get(row.projectId) ?? 0;
    if (seen >= MAX_DOMAINS_PER_PROJECT_PER_NIGHT) {
      report.droppedForBudget += 1;
      continue;
    }
    perProjectSeen.set(row.projectId, seen + 1);
    admittedWithinProjectCap.push(row);
  }

  // Remaining budget for the whole night, **shared deliberately** — a per-project
  // budget would make the ceiling depend on how many customers happen to be
  // configured, which is the same bug the AI Mode runner fixed the other way round.
  let remaining = ETV_NIGHTLY_BUDGET_USD;

  for (const row of admittedWithinProjectCap) {
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
