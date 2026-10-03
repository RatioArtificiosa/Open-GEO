import { eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  geoAnswers,
  geoSnapshotAnswers,
  geoSnapshots,
  geoTargets,
  projects,
} from "@/db/schema";
import { GeoPatrol } from "@/server/features/geo/services/GeoPatrol";
import {
  geoAnswerUnitCostUsd,
  NIGHTLY_PROJECT_SWEEP_LIMIT,
} from "@/shared/dataforseo-pricing";
import {
  alertOnRunChange,
  ALERT_TRANSPORT,
} from "@/server/features/geo/services/alertRunner";
import {
  releaseRun,
  tryBeginRun,
} from "@/server/features/geo/repositories/MonitorRunRepository";
import type { GeoPlatform } from "@/server/features/geo/repositories/GeoSetupRepository";

/**
 * The monitor identity for the nightly patrol.
 *
 * Named rather than inlined at the call site, because a second caller — the
 * manual "run now" path — will need it, and two different strings for the same
 * monitor would be two independent slots. The protection would be theatre.
 *
 * Module-private until that second caller exists: exporting it now would leave
 * a constant nothing imports, and knip is right to say so.
 */
const GEO_PATROL_MONITOR = "geo_patrol";

/**
 * The nightly GEO patrol.
 *
 * Without this nothing is monitored: the repository, the schema and `GeoPatrol`
 * all exist, but until a scheduler calls them the archive stays empty and every
 * GEO surface is a demo.
 *
 * Two decisions shape this file, both about money:
 *
 * 1. **We patrol on a cadence, not on every tick.** A project on weekly
 *    monitoring must not be queried nightly, or a nightly tick silently becomes
 *    a daily charge against every customer.
 * 2. **A project that fails does not stop the others.** One brand's balance
 *    error, or one prompt set that times out, must not cancel the run for
 *    everyone else. Failures are collected and reported at the end.
 */

// Module-private: the cron entry point returns a value, it does not name these
// types. Exporting them would be a claim about the API surface nothing uses.
type ScheduledPatrolResult = {
  projectsVisited: number;
  targetsPatrolled: number;
  answersArchived: number;
  costUsd: number;
  /** One line per failure, prefixed with the project, for the cron log. */
  errors: string[];
};

type DueTarget = {
  targetId: string;
  projectId: string;
  domain: string;
  organizationId: string;
  /**
   * The project's acquisition preference, or `null` for "never expressed".
   *
   * Resolved to `"live"` at the call site rather than here, because `null` and
   * `"live"` are the same decision and the *reason* they are the same is worth
   * keeping in one place: a column added to a table that has rows should not
   * pretend every row chose something.
   */
  geoAcquisitionMode: "live" | "queued" | null;
};

/**
 * The identity a scheduled run acts as.
 *
 * A cron has no user, and inventing a plausible one would put a fake
 * userId/userEmail into the billing ledger. The existing scheduled rank checks
 * already solve this with a `system` identity, so the patrol uses the same
 * convention and the same address — one convention, not two.
 */
const SYSTEM_ACTOR = {
  userId: "system",
  userEmail: "system@opengeo.so",
} as const;

/**
 * Targets that have never been patrolled, plus those whose last run predates
 * the cadence window.
 *
 * The last-run query is deliberately UNFILTERED. An earlier version filtered to
 * runs older than the cutoff, which meant a target patrolled an hour ago loaded
 * no run at all and looked never-patrolled - so every nightly tick re-billed
 * every customer. Filtering to "recent" instead makes the due decision in JS,
 * where the interval is a duration rather than a column.
 */
async function listDueTargets(now: Date): Promise<DueTarget[]> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const rows = await db
    .select({
      targetId: geoTargets.id,
      projectId: geoTargets.projectId,
      domain: geoTargets.domain,
      organizationId: projects.organizationId,
      // Read here rather than in a second query: the join to `projects` already
      // exists for the archive filter, and a per-project lookup would be one
      // round trip per project for one nullable column.
      geoAcquisitionMode: projects.geoAcquisitionMode,
    })
    .from(geoTargets)
    .innerJoin(projects, eq(geoTargets.projectId, projects.id))
    .where(isNull(projects.archivedAt));

  if (rows.length === 0) return [];

  // The most recent run per target, in one pass. The link from a run to a target
  // is through the answers it archived (geo_snapshots has no target_id), so this
  // reads the join rather than assuming a column that does not exist.
  const runs = await db
    .select({
      targetId: geoAnswers.targetId,
      startedAt: geoSnapshots.startedAt,
    })
    .from(geoAnswers)
    .innerJoin(
      geoSnapshotAnswers,
      eq(geoAnswers.id, geoSnapshotAnswers.answerId),
    )
    .innerJoin(
      geoSnapshots,
      eq(geoSnapshotAnswers.snapshotId, geoSnapshots.id),
    );

  const lastRunByTarget = new Map<string, string>();
  for (const run of runs) {
    if (!run.targetId) continue;
    const current = lastRunByTarget.get(run.targetId);
    if (!current || run.startedAt > current) {
      lastRunByTarget.set(run.targetId, run.startedAt);
    }
  }

  // Due means: never run, OR last run older than the window. A target patrolled
  // inside the window is explicitly NOT due, which is what stops a nightly tick
  // from re-billing a daily-or-weekly customer every single night.
  return rows.filter((row) => {
    const lastRun = lastRunByTarget.get(row.targetId);
    return !lastRun || lastRun < cutoff;
  }) as DueTarget[];
}

/**
 * Run the patrol for every due project.
 *
 * `limitProjects` is the shared first-deploy safety valve
 * ({@link NIGHTLY_PROJECT_SWEEP_LIMIT}, which every nightly sweep reads), where an
 * unbounded sweep could fan out across every customer in one tick. It is not a
 * product limit — raise it once real spend is known.
 */
async function runDuePatrols(
  options: { now?: Date; limitProjects?: number } = {},
): Promise<ScheduledPatrolResult> {
  const now = options.now ?? new Date();
  const limit = options.limitProjects ?? NIGHTLY_PROJECT_SWEEP_LIMIT;

  const due = await listDueTargets(now);
  const byProject = new Map<string, DueTarget[]>();
  for (const target of due) {
    const list = byProject.get(target.projectId);
    if (list) list.push(target);
    else byProject.set(target.projectId, [target]);
  }

  const result: ScheduledPatrolResult = {
    projectsVisited: 0,
    targetsPatrolled: 0,
    answersArchived: 0,
    costUsd: 0,
    errors: [],
  };

  for (const [projectId, targets] of byProject) {
    if (result.projectsVisited >= limit) {
      result.errors.push(
        `Reached the ${limit}-project safety limit; the remaining ${
          byProject.size - result.projectsVisited
        } projects are deferred to the next tick.`,
      );
      break;
    }

    try {
      // Claim the monitor's single-in-flight slot BEFORE doing anything that
      // costs money. This is the whole reason `monitor_runs` exists: two ticks
      // overlapping, or a tick racing a manual "run now", would each bill the
      // customer in full, and the archive would contain the same patrol twice.
      //
      // The claim is not a lock we hold in memory — it is an INSERT the database
      // rejects, so it survives being in a different Worker isolate from the one
      // that might already be running. A boolean in this function's scope would
      // protect nothing.
      const claim = await tryBeginRun({
        id: crypto.randomUUID(),
        projectId,
        monitorType: GEO_PATROL_MONITOR,
        // One monitor per project, not per target: the patrol loops over the
        // project's targets inside a single run, and splitting them would let
        // two patrols bill for the same project at once.
        platform: "",
        plannedItems: targets.length,
      });

      if (!claim.ok) {
        // A duplicate trigger, which is a normal outcome and not an error. It is
        // named in `errors` because "we skipped a project" is a fact the run log
        // should carry — a silently skipped project looks like a project with
        // nothing to say.
        result.errors.push(
          `Patrol already in flight for this project (run ${claim.blockingRunId ?? "unknown"}); skipped rather than billing twice.`,
        );
        continue;
      }

      try {
        // The system identity, scoped to the project, exactly as the scheduled
        // rank checks do it. The billing context is built from real ids rather
        // than cast: a fake one would skip the usage-credit check.
        const customer = {
          ...SYSTEM_ACTOR,
          organizationId: targets[0]?.organizationId ?? "",
          projectId,
        };

        /**
         * The project's chosen acquisition path, and the only place in production
         * that decides it.
         *
         * **`?? "live"`, and that fallback is the safety property.** A project
         * that has never chosen — every project that existed before this column —
         * keeps the behaviour it has always had, which is the Live path that
         * archives within the run. The queue is opt-in, and the cost of a mistake
         * here is bounded: an opted-in project whose prompts were deleted posts
         * nothing and says so, rather than falling back to something else.
         */
        const mode = targets[0]?.geoAcquisitionMode ?? "live";

        const run = await GeoPatrol.run({
          projectId,
          customer,
          createdBy: "schedule",
          platforms: ["chat_gpt", "google_ai_overview"] as GeoPlatform[],
          /**
           * The price and the cap, both from the price book rather than literals.
           *
           * The price is read live so a vendor price change keeps this a real cap —
           * a literal here stops bounding anything the day it drifts from the
           * vendor's page.
           *
           * The cap is `null`, and that is a **decision**, not an omission: the
           * product has no per-project spend setting yet, so inventing a ceiling
           * would refuse runs on a number nobody chose. `null` is reported on the
           * run log as "bounded by its answer limit only", which is honest, and it
           * is the gap a future pricing plan has to close. The alternative —
           * omitting both fields — is the same behaviour with no way for an operator
           * to discover it.
           */
          unitCostUsd: geoAnswerUnitCostUsd(),
          budgetUsd: null,
          // Passed only when it is `queued`, so a live run's call is byte-identical
          // to the one that shipped — `mode: "live"` would be the same behaviour
          // with one more field to reason about at every call site.
          ...(mode === "queued" ? { mode: "queued" as const } : {}),
        });

        result.projectsVisited += 1;
        result.targetsPatrolled += targets.length;
        result.answersArchived += run.answersArchived;
        result.costUsd += run.costUsd;

        for (const note of run.notes) {
          console.log(`[geo-patrol] ${projectId} — ${note}`);
        }

        // Alerting runs **after** the run, and only when there is a snapshot to
        // compare — the whole premise is "these two stored answers differ", and a
        // run that archived nothing has nothing to compare against. Alerting
        // before the snapshot exists would compare against a run that is not
        // written yet, and the diff would be against the wrong baseline.
        //
        // **Never throws.** A webhook outage must not fail a patrol, or the
        // alerting failure becomes a monitoring outage. The same reasoning as the
        // vendor-evidence recorder, which is best-effort for the same reason.
        const alert = await alertOnRunChange({
          projectId,
          snapshotId: run.snapshotId,
          // Every brand the patrol measured. Without this only the first target's
          // snapshot was ever decided, so a multi-brand project reported on one
          // brand and said nothing about the others.
          snapshotIds: run.snapshotIds,
          transport: ALERT_TRANSPORT,
        }).catch((alertError: unknown) => ({
          outcome: "not_applicable" as const,
          reason: `Alerting failed and was swallowed so the patrol could finish: ${
            alertError instanceof Error
              ? alertError.message
              : String(alertError)
          }`,
        }));
        if (
          alert.outcome !== "not_applicable" &&
          alert.outcome !== "no_baseline"
        ) {
          // **One line per brand that alerted.** A multi-brand patrol can produce
          // several, and logging only `alert.result` names whichever came first —
          // so a run where two brands lost mentions reads in the log like one did.
          // The count is stated as well as the list so a reader can tell "one
          // brand" from "two brands" without counting lines.
          const brands = alert.perBrand ?? [alert];
          console.log(
            `[geo-patrol] ${projectId} — alert on ${brands.length} brand(s): ` +
              brands
                .map(
                  (b) =>
                    b.result.outcome +
                    (b.result.detail === null ? "" : `: ${b.result.detail}`),
                )
                .join("; "),
          );
        }
      } finally {
        // The slot is released whatever happens above. A throw that skipped this
        // would leave the project **permanently** unable to run — no error, no
        // retry, just a project that silently stopped being monitored. That is
        // the same class of bug as the cron inversion, one level down.
        await releaseRun(claim.runId, "scheduled patrol finished").catch(
          (releaseError: unknown) => {
            // A failed release is itself worth reporting rather than swallowing:
            // the project's monitoring is now stuck, and silence would make it
            // look like a quiet month.
            console.error(
              "[geo-patrol] failed to release the run slot",
              releaseError,
            );
          },
        );
      }
    } catch (error) {
      // One project's failure must not cancel the rest: a balance error on one
      // account should not stop every other account from being monitored.
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${projectId}: ${message}`);
      console.error(`[geo-patrol] ${projectId} failed:`, error);
    }
  }

  console.log("[geo-patrol] nightly run complete", {
    projects: result.projectsVisited,
    targets: result.targetsPatrolled,
    answers: result.answersArchived,
    errors: result.errors.length,
  });

  return result;
}

/**
 * The entry point the cron dispatcher calls.
 *
 * Named for its call site rather than only exported through the object, because
 * `server.ts` imports exactly this and nothing else from this module. Tests use
 * the object form so they can drive the injectable `now`/`limitProjects`.
 */
export async function runDueGeoPatrols(): Promise<ScheduledPatrolResult> {
  return runDuePatrols();
}

export const ScheduledGeoPatrol = {
  runDuePatrols,
  listDueTargets,
} as const;
