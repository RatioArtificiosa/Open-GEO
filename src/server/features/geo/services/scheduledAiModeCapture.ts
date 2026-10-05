/**
 * The nightly AI Mode capture, driven by the cron.
 *
 * ## Why this is a separate handler and not a flag on the patrol
 *
 * AI Mode is a **billable SERP call with no task queue**: $0.004 per keyword, paid
 * whether or not anything is behind it, and the answer is one document rather than
 * a prompt answered asynchronously. The queued path exists precisely because that
 * shape does not fit it, so this is its own entry point beside `scheduled` rather
 * than a mode on the patrol.
 *
 * ## What makes it safe to leave switched on
 *
 * 1. **Opt-in.** A project runs this only if it has a prompt set. Nothing is
 *    inferred, and a project that never configured AI Mode is never billed for it.
 * 2. **Budget-capped.** `AI_MODE_NIGHTLY_BUDGET_USD` bounds the night regardless of
 *    how many keywords are watched, and the planner names what it dropped — because
 *    "we checked everything" and "we checked what we could afford" are different
 *    claims and only one is safe to repeat.
 * 3. **Once a day, by the run log.** The idempotency check reads the GEO run log, so
 *    a second tick in the same window costs one row read rather than a second bill
 *    per keyword.
 *
 * ## Why nightly rather than the patrol's per-plan window
 *
 * A diff needs two points, and the value of the second is "what changed since
 * yesterday". Weekly captures would halve the cost and throw away the change that
 * happened on Thursday — which is the entire product. So the **cadence** is nightly
 * and the **budget** is what bounds cost.
 */
import { eq, max, sql } from "drizzle-orm";
import type { CaptureCostReport } from "@/server/features/geo/services/captureReport";
import { db } from "@/db";
import {
  aiModeSnapshots,
  geoPrompts,
  geoPromptSets,
  geoTargets,
} from "@/db/schema";
import { runAiModeMonitor, type AiModeNightResult } from "./aiModeMonitor";
import type { WatchedPrompt } from "./aiModeSchedule";
import {
  NIGHTLY_BUDGET_USD,
  NIGHTLY_PROJECT_SWEEP_LIMIT,
} from "@/shared/nightly-budgets";

/**
 * One AI Mode call, in USD.
 *
 * $0.004 for `live`/`advanced`, verified against the vendor's example response
 * (2026-02-24). The research table's $0.0012 figure is the plain `live` variant of
 * a *different* endpoint, not this one — and quoting it here would understate every
 * budget by 3x while looking authoritative.
 */
const AI_MODE_UNIT_COST_USD = 0.004;

/**
 * The nightly ceiling, in USD — about 25 keywords.
 *
 * **A constant, and the alternative is worse.** Enough for the planner to have a
 * choice to make, small enough that a misconfigured project cannot produce an
 * invoice anybody has to explain. It is deliberately not per-project today: the
 * product has no per-project spend setting, and inventing a ceiling would refuse
 * runs on a number nobody chose. When a pricing plan lands this is the number it
 * should replace rather than sit beside.
 *
 * **Not exported.** A constant re-exported "so the docs and UI cannot drift" is a
 * claim about a consumer that does not exist yet, and knip correctly refuses it. The
 * number that matters is in the run log, which is where an operator will read it.
 */
/** **Read from {@link NIGHTLY_BUDGET_USD}** — and it is the outlier there: per
 * project, not shared. The sibling runners divide one night budget; this one cannot. */
const AI_MODE_NIGHTLY_BUDGET_USD = NIGHTLY_BUDGET_USD.aiMode;

/** One project's watch list, assembled from its prompt set and target. */
type Watcher = {
  projectId: string;
  locationCode: number;
  languageCode: string;
  /** The keywords to watch, priced and annotated for the planner. */
  prompts: WatchedPrompt[];
};

/**
 * Projects with at least one prompt, with their keywords.
 *
 * `geo_prompts` hangs off a **prompt set**, not off a target — the schema has no
 * `target_id` and no `deleted_at`, so my first draft joined `geoPrompts.targetId`
 * and filtered on `deletedAt`, neither of which exists. The market therefore comes
 * from the project's first target, which is the only market the schema can name.
 *
 * **`observations: 0` and `observedChanges: 0` are honest, not lazy.** This
 * handler does not read `ai_mode_snapshots` to count them, and inventing a count
 * would feed the planner a volatility figure it did not measure — and volatility is
 * the first thing the planner sorts on. So it passes zeros, which makes the planner
 * fall back to its own rule: a keyword with no observations is a first capture and
 * ranks above everything, because we have no baseline for it. That is the correct
 * ordering for a cold start and it needs no fabricated data.
 */
/**
 * When each **project** was last asked, at all.
 *
 * **This capture had no rotation of any kind, so the same 25 projects won every night.**
 * The other four captures all rotated *something* — the problem was that it was one
 * level below the cap. This one had no `orderBy` at all, so `watchers.slice(0, 25)` took
 * whatever order the database returned, and a stable order is the worst kind: it looks
 * deterministic, reports honestly, and starves everyone past the 25th project forever.
 *
 * `runMonitor` bills real money per call, so this is a project paying for a capture it
 * never receives.
 */
const projectLastAsked = db
  .select({
    projectId: aiModeSnapshots.projectId,
    at: max(aiModeSnapshots.capturedAt).as("project_at"),
  })
  .from(aiModeSnapshots)
  .groupBy(aiModeSnapshots.projectId)
  .as("projectLastAsked");

async function projectsWatchingAiMode(): Promise<Watcher[]> {
  const rows = await db
    .select({
      projectId: geoTargets.projectId,
      locationCode: geoTargets.locationCode,
      languageCode: geoTargets.languageCode,
      prompt: geoPrompts.prompt,
    })
    .from(geoPrompts)
    .innerJoin(geoPromptSets, eq(geoPrompts.promptSetId, geoPromptSets.id))
    .innerJoin(geoTargets, eq(geoPromptSets.projectId, geoTargets.projectId))
    .leftJoin(
      projectLastAsked,
      eq(projectLastAsked.projectId, geoTargets.projectId),
    )
    // **Never-asked projects first, then least-recently-asked.** The `is null` term is
    // written out because a dialect that sorted nulls last would put every project
    // needing a capture *behind* the ones already current — the same starvation the
    // other three captures had to be taught.
    .orderBy(
      sql`${projectLastAsked.at} is null desc`,
      sql`${projectLastAsked.at}`,
      // **Then the configured prompt order, and it is not decoration.**
      //
      // `planAiModeCaptures` sorts by priority and is deliberately **stable on the
      // caller's order** — `aiModeSchedule.ts` says so outright: *"two prompts with equal
      // priority keep the caller's order, so a project sees the same plan twice in a row
      // when nothing has changed."* So this query's order **is** the tiebreak, and before
      // this capture had an `ORDER BY` at all the tiebreak was whatever order SQLite
      // returned.
      //
      // `projectId` alone makes it deterministic, which is half the property; this term
      // makes it **meaningful** — two equally-ranked prompts are now reported in the order
      // the customer arranged them, rather than alphabetically by project.
      //
      // **Last, after the rotation terms**, for the reason the other two captures needed
      // the same care: the bound acts on projects, so the project terms decide who runs
      // and only then does prompt order become relevant.
      geoTargets.projectId,
      geoPrompts.position,
    );

  const byProject = new Map<string, Watcher>();
  for (const row of rows) {
    const existing = byProject.get(row.projectId);
    if (existing === undefined) {
      // A project with many targets is offered the first one's market, which is
      // what its prompt set was configured against.
      byProject.set(row.projectId, {
        projectId: row.projectId,
        locationCode: row.locationCode,
        languageCode: row.languageCode,
        prompts: [
          {
            keyword: row.prompt,
            estimatedCostUsd: AI_MODE_UNIT_COST_USD,
            observedChanges: 0,
            observations: 0,
          },
        ],
      });
      continue;
    }
    // Position order within the set, which is the order the customer arranged them
    // in, so a budget-capped night captures the questions they care about first.
    existing.prompts.push({
      keyword: row.prompt,
      estimatedCostUsd: AI_MODE_UNIT_COST_USD,
      observedChanges: 0,
      observations: 0,
    });
  }
  return [...byProject.values()];
}

/**
 * The night's shape.
 *
 * **Not exported**, and knip is right to object when it was: nothing outside this
 * file names it, and the cron caller reads the fields off the returned value. An
 * exported type nothing imports is a claim about the API surface that is not true,
 * and this repository has just spent a day removing code whose only evidence of use
 * was its own declaration.
 */
/**
 * **Extends the shared `CaptureCostReport`** rather than restating it: the three
 * cost fields are what every nightly capture reports, and a fourth capture that
 * forgot one would be a compile error rather than a gap nobody noticed.
 *
 * `droppedForBudget` is **absent and deliberately so** — the monitor measures one
 * project against a budget it either fits or refuses, so a dropped count here would
 * always be `0`, which is a measurement rather than a measurement that is zero.
 * `failed` is absent for the same reason: the per-project `projects` list already
 * carries each project's own failures, and a count beside it would be a second
 * place to read the same fact.
 */
type AiModeNightReport = CaptureCostReport & {
  captured: number;
  failed: number;
  /** Per project, so an operator can see which keyword went unanswered. */
  projects: AiModeNightResult[];
};

/**
 * Capture AI Mode answers for every project watching them, once a day.
 *
 * `limitProjects` is the shared first-deploy safety valve
 * ({@link NIGHTLY_PROJECT_SWEEP_LIMIT}, which `runDuePatrols` also reads): an
 * unbounded sweep could fan out across every customer in one tick.
 */
export async function runDueAiModeCaptures(input?: {
  limitProjects?: number;
  now?: Date;
  /** Injected so a test can drive the monitor without a vendor or a database. */
  runMonitor?: typeof runAiModeMonitor;
  /** Injected for the same reason. */
  fetchWatchers?: typeof projectsWatchingAiMode;
}): Promise<AiModeNightReport> {
  const now = input?.now ?? new Date();
  const limit = input?.limitProjects ?? NIGHTLY_PROJECT_SWEEP_LIMIT;
  const runMonitor = input?.runMonitor ?? runAiModeMonitor;
  const fetchWatchers = input?.fetchWatchers ?? projectsWatchingAiMode;

  const watchers = await fetchWatchers();

  const report: AiModeNightReport = {
    projectsVisited: 0,
    captured: 0,
    failed: 0,
    actualCostUsd: 0,
    estimatedCostUsd: 0,
    projects: [],
  };

  for (const watcher of watchers.slice(0, limit)) {
    // Each project gets the **full** budget rather than a share: the cap exists to
    // bound one project's night, and dividing it would make the bound depend on how
    // many other customers happen to be watching.
    const result = await runMonitor({
      projectId: watcher.projectId,
      prompts: watcher.prompts,
      budgetUsd: AI_MODE_NIGHTLY_BUDGET_USD,
      locationCode: watcher.locationCode,
      languageCode: watcher.languageCode,
      now,
    });

    report.projectsVisited += 1;
    report.captured += result.captured;
    report.failed += result.failed.length;
    report.actualCostUsd += result.actualCostUsd;
    report.estimatedCostUsd += result.estimatedCostUsd;
    report.projects.push(result);
  }

  return report;
}
