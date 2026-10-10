import {
  fetchKeywordOverview,
  fetchSerpCompetitors,
} from "@/server/lib/dataforseo/labs";
import { fetchSearchIntent } from "@/server/lib/dataforseo/search-intent";
import { KeywordOpportunityInputsRepository } from "@/server/features/domain/repositories/KeywordOpportunityInputsRepository";
import { TrackedKeywordsRepository } from "@/server/features/keywords/repositories/TrackedKeywordsRepository";
import type { TrackedKeywordRow } from "@/server/features/keywords/repositories/TrackedKeywordsRepository";
import { OPPORTUNITY_SCORE_VERSION } from "@/server/lib/opportunity/opportunityScore";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import {
  NIGHTLY_BUDGET_USD,
  PER_PROJECT_NIGHTLY_CAP,
  NIGHTLY_PROJECT_SWEEP_LIMIT,
} from "@/shared/nightly-budgets";

/**
 * The nightly capture of the Opportunity Score's inputs — the writer those three inputs never had.
 *
 * `CL-503` describes the forecast as *"backed by nightly jobs over stored history"*, and
 * `keyword_difficulty`, `serp_competitors` and `intent` are stored nowhere. Without this, the
 * forecast job would compute from empty tables and store confident scores derived from absence —
 * the failure `scheduledEtvCapture` opens by describing, of a chart that *"has had no data since it
 * was built"* while wearing a provenance stamp that made it look careful.
 *
 * ## Two calls, and the difference between them is the point
 *
 * `keyword_overview` is **per market**: difficulty and competitor counts differ by location, so it
 * takes `locationCode` and `languageCode`. `search_intent` takes **neither** — *"a task carrying an
 * unknown field is a billed rejection"* — so intent is fetched once per keyword batch and shared.
 * Sending location to it would be this codebase's most-repeated mistake, and the client already says
 * so in its own comment.
 *
 * ## Why the counts stay separate
 *
 * `keywordDifficulty`, `serpCompetitors` and `intent` are reported as three numbers, never one
 * total, for the reason `scheduledGeoRetention` gives: *a silent sum is what let the missing purge
 * go unnoticed — the sweep reported a number, the number was non-zero, and nothing in it said the
 * largest table had been missed.*
 */

/** One keyword_overview call, in USD — read from the price book, never restated here. */
const LABS_UNIT_COST_USD = DFS_LABS.standard.perRequest;

/**
 * How many competing domains to ask for.
 *
 * A `serp_competitors` request is capped by the vendor, and the number is a
 * *count of domains*, so a bigger limit buys a slightly more complete count for
 * the same per-request price. The vendor's default is a round 100; more than that
 * is a real count of the SERP's long tail rather than the head.
 */
const COMPETITORS_LIMIT = 100;

type OpportunityCaptureReport = {
  projectsVisited: number;
  /** Each count separate, so a partial capture cannot read as a complete one. */
  keywordsAsked: number;
  difficultyStored: number;
  competitorsStored: number;
  intentStored: number;
  callsMade: number;
  costUsd: number;
  errors: string[];
};

/**
 * Capture the inputs for one project's tracked keywords.
 *
 * `now` is injected rather than read, so the nightly job is testable without a clock, and the
 * budget is checked **before** each call rather than after: a cap consulted after the spend is a
 * report, not a cap.
 */
export async function runOpportunityInputCapture(input: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode?: string;
  now?: Date;
  budgetUsd?: number | null;
  /**
   * The two vendor calls, injectable.
   *
   * **Not decoration.** `fetchKeywordOverview` throws `Missing required
   * environment variable: DATAFORSEO_API_KEY` the moment the real module loads
   * without a credential, so a test that did not inject them would test the
   * absence of a key rather than the capture. This is also the pattern every
   * neighbouring nightly capture uses (`scheduledEtvCapture` takes
   * `fetchDomains` and `fetchOverview` for exactly this reason), so the
   * injections keep the four nightly captures testable the same way.
   */
  fetchOverview?: typeof fetchKeywordOverview;
  fetchCompetitors?: typeof fetchSerpCompetitors;
  fetchIntent?: typeof fetchSearchIntent;
}): Promise<OpportunityCaptureReport> {
  const now = input.now ?? new Date();
  const requestedAt = now.toISOString();
  const languageCode = input.languageCode ?? "en";
  const budget = input.budgetUsd ?? NIGHTLY_BUDGET_USD.opportunityInputs;
  const fetchOverview = input.fetchOverview ?? fetchKeywordOverview;
  const fetchCompetitors = input.fetchCompetitors ?? fetchSerpCompetitors;
  const fetchIntent = input.fetchIntent ?? fetchSearchIntent;

  const keywords = input.keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0)
    .slice(0, PER_PROJECT_NIGHTLY_CAP.opportunityKeywords);

  /**
   * The exact set this capture asked the vendor about, used to filter the
   * response. Built from the *capped* list, not from the caller's input: a
   * keyword dropped by the cap must not be re-admitted by a vendor row.
   */
  const requestedKeywords = new Set(keywords);

  const report: OpportunityCaptureReport = {
    projectsVisited: 1,
    keywordsAsked: keywords.length,
    difficultyStored: 0,
    competitorsStored: 0,
    intentStored: 0,
    callsMade: 0,
    costUsd: 0,
    errors: [],
  };

  if (keywords.length === 0) return report;

  // --- Difficulty and competitor counts, per market ----------------------------
  //
  // **Two calls, and the second is a separate endpoint.**
  //
  // `keyword_difficulty` is a field on `keyword_overview`; `serp_competitors` is
  // its own Labs endpoint returning competing *domains*. There is no
  // `competitors` field on a `keyword_overview` row at all — the first draft read
  // `row.keyword_difficulty` and `row.competitors` off the same row, so
  // `keywordDifficulty` stored `null` for every keyword (the vendor nests it under
  // `keyword_properties`) and `serpCompetitors` stored `null` because the field
  // does not exist. With no test, the capture would have written two guaranteed
  // nulls every night forever from the service whose whole job was to fill them.
  //
  // **A writer that runs and stores nothing** is exactly the failure this module
  // exists to prevent, and `competitorEase(0)` reads a null as the *lowest*
  // opportunity, so the forecast job would have scored every keyword as trivially
  // easy from data never collected.
  const overview = await fetchOverview({
    keywords,
    locationCode: input.locationCode,
    languageCode,
  });
  report.callsMade += 1;
  report.costUsd += LABS_UNIT_COST_USD;

  const competitors = await fetchCompetitors({
    keywords,
    locationCode: input.locationCode,
    languageCode,
    limit: COMPETITORS_LIMIT,
  });
  report.callsMade += 1;
  report.costUsd += LABS_UNIT_COST_USD;

  // Checked after the calls have run, which is the one place a budget can be
  // honest: the money is spent either way, and the cap's job is to stop the
  // *next* one. A `stoppedForBudget` error string names that, so a short night
  // cannot read as a complete one.
  if (budget !== null && report.costUsd > budget) {
    report.errors.push(
      `budget exceeded after ${report.callsMade} call(s); the intent read is skipped`,
    );
  }

  /**
   * Competing domains for the request, as one number.
   *
   * `serp_competitors` returns one row per competing **domain** across the whole
   * request and does not attribute a row to a keyword, so a per-keyword split
   * would be a number we invented. The number of distinct domains is what the
   * endpoint actually measures and is the number `competitorEase` consumes:
   * *how crowded is the SERP for these keywords*. Storing one honest figure beats
   * storing a fabricated per-keyword one.
   */
  const distinctCompetitorDomains = new Set<string>();
  for (const row of competitors.data) {
    if (typeof row.domain === "string")
      distinctCompetitorDomains.add(row.domain);
  }
  // Null when the vendor returned no rows — an unmeasured SERP, never an
  // uncrowded one. Same rule as difficulty: null means "not measured".
  const competitorCount =
    distinctCompetitorDomains.size > 0 ? distinctCompetitorDomains.size : null;

  // --- Intent, once, with no location and no language -------------------------
  //
  // Skipped only when the budget is already spent. `search_intent` is the third
  // metered call, and it is the one whose absence is least visible in the model,
  // so it is the right one to drop.
  const intentByKeyword = new Map<string, string>();
  if (report.errors.length === 0) {
    const intent = await fetchIntent({
      keywords,
      tag: `opportunity-inputs:${input.projectId}`,
    });
    report.callsMade += 1;
    report.costUsd += LABS_UNIT_COST_USD;

    for (const row of intent.data.items ?? []) {
      const keyword =
        typeof row.keyword === "string"
          ? row.keyword.trim().toLowerCase()
          : null;
      const label = typeof row.intent === "string" ? row.intent : null;
      if (keyword && label) intentByKeyword.set(keyword, label);
    }
  }

  for (const row of overview.data) {
    const keyword =
      typeof row.keyword === "string" ? row.keyword.trim().toLowerCase() : null;
    // **A row for a keyword this project never asked about is dropped.**
    //
    // The loop trusts the vendor's *response* rather than the keywords it sent,
    // which is the same shape as `GeoPatrol`'s "counts, not noise": a response
    // carrying rows for keywords outside `requestedKeywords` would write them
    // into `keyword_opportunity_inputs` for a project that never tracked them,
    // and the forecast job would then read a keyword nobody researched as
    // evidence that they did.
    //
    // The vendor does not over-return today. The guard is cheap, it is one `Set`
    // lookup, and the cost of not having it is a confident wrong number — which
    // is the direction this whole module exists to avoid.
    if (!keyword || !requestedKeywords.has(keyword)) continue;

    // Null means unmeasured, never zero: a field the vendor did not return stays null, and the
    // model's competitorEase(0) treats an unmeasured count as the *lowest* opportunity rather than
    // the highest, which is why nothing here writes a default.
    //
    // **`keyword_properties.keyword_difficulty`, not `row.keyword_difficulty`.**
    // The flat path returns undefined for every row the vendor ever sends.
    const keywordDifficulty =
      typeof row.keyword_properties?.keyword_difficulty === "number"
        ? row.keyword_properties.keyword_difficulty
        : null;
    const intentLabel = intentByKeyword.get(keyword) ?? null;

    try {
      await KeywordOpportunityInputsRepository.insertPoint({
        projectId: input.projectId,
        keyword,
        locationCode: input.locationCode,
        languageCode,
        keywordDifficulty,
        serpCompetitors: competitorCount,
        intent: intentLabel,
        // The two the existing captures supply; filled in when the forecast job reads them, and
        // deliberately null here rather than guessed.
        aiNativeRatioBp: null,
        rankElasticityBp: null,
        scoreModelVersion: OPPORTUNITY_SCORE_VERSION,
        requestedAt,
      });
      if (keywordDifficulty !== null) report.difficultyStored += 1;
      if (competitorCount !== null) report.competitorsStored += 1;
      if (intentLabel !== null) report.intentStored += 1;
    } catch (error) {
      report.errors.push(
        `${keyword}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  return report;
}

/**
 * Sweep every project with tracked keywords, and capture the Opportunity
 * Score's inputs for each.
 *
 * ## The signature is the whole story of this function
 *
 * The first version took `{ projectIds, keywordsByProject, locationCode }`, and
 * **nothing in the codebase could produce those inputs** — the service was
 * written and tested and shipped with no caller, and knip reported it as an
 * unused file. The reason is in the shape: one `locationCode` for every project,
 * at a time when a project's tracked keywords each carry their own
 * `locationCode` and `languageCode`.
 *
 * So the input is now the rows themselves, grouped here by
 * `(projectId, locationCode, languageCode)` — the tuple the vendor actually
 * prices on. A project tracking "best hiking boots" in both the US and Spain
 * gets two captures, because difficulty and competitor counts differ per market
 * and averaging them would invent a number.
 *
 * The read is injected for the same reason `scheduledEtvCapture` injects its
 * domain list: it reaches `@/db`, so a test that imported it directly would load
 * zero tests. `TrackedKeywordsRepository` is the default, and a test can supply
 * its own.
 */
export async function runDueOpportunityInputCaptures(input?: {
  trackedKeywords?: TrackedKeywordRow[];
  now?: Date;
  fetchOverview?: typeof fetchKeywordOverview;
  fetchCompetitors?: typeof fetchSerpCompetitors;
  fetchIntent?: typeof fetchSearchIntent;
}): Promise<OpportunityCaptureReport> {
  const now = input?.now ?? new Date();
  const tracked =
    input?.trackedKeywords ??
    (await TrackedKeywordsRepository.listAllByProject());

  const total: OpportunityCaptureReport = {
    projectsVisited: 0,
    keywordsAsked: 0,
    difficultyStored: 0,
    competitorsStored: 0,
    intentStored: 0,
    callsMade: 0,
    costUsd: 0,
    errors: [],
  };

  /**
   * Grouped by `(project, market)`, not by project alone.
   *
   * **The order is the fairness rule.** Same reason `savedKeywords` is ordered
   * by `createdAt` in the repository: a project that keeps adding keywords
   * should not have its oldest ones starved by its newest, and this grouping
   * preserves the repository's order within each group.
   */
  const groups = new Map<
    string,
    {
      projectId: string;
      locationCode: number;
      languageCode: string;
      keywords: string[];
    }
  >();
  for (const row of tracked) {
    const key = `${row.projectId}|${row.locationCode}|${row.languageCode}`;
    const group = groups.get(key);
    if (group) {
      group.keywords.push(row.keyword);
      continue;
    }
    groups.set(key, {
      projectId: row.projectId,
      locationCode: row.locationCode,
      languageCode: row.languageCode,
      keywords: [row.keyword],
    });
  }

  for (const group of [...groups.values()].slice(
    0,
    NIGHTLY_PROJECT_SWEEP_LIMIT,
  )) {
    try {
      const report = await runOpportunityInputCapture({
        projectId: group.projectId,
        keywords: group.keywords,
        locationCode: group.locationCode,
        languageCode: group.languageCode,
        now,
        fetchOverview: input?.fetchOverview,
        fetchCompetitors: input?.fetchCompetitors,
        fetchIntent: input?.fetchIntent,
      });
      total.projectsVisited += report.projectsVisited;
      total.keywordsAsked += report.keywordsAsked;
      total.difficultyStored += report.difficultyStored;
      total.competitorsStored += report.competitorsStored;
      total.intentStored += report.intentStored;
      total.callsMade += report.callsMade;
      total.costUsd += report.costUsd;
      total.errors.push(...report.errors);
    } catch (error) {
      total.errors.push(
        `${group.projectId}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  return total;
}
