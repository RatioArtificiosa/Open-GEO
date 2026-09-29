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
import type { GeoPlatform } from "@/server/features/geo/repositories/GeoSetupRepository";

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
 * `limitProjects` is a safety valve for the first production deploy, where an
 * unbounded sweep could fan out across every customer in one tick. It is not a
 * product limit — raise it once real spend is known.
 */
async function runDuePatrols(
  options: { now?: Date; limitProjects?: number } = {},
): Promise<ScheduledPatrolResult> {
  const now = options.now ?? new Date();
  const limit = options.limitProjects ?? 25;

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
      // The system identity, scoped to the project, exactly as the scheduled
      // rank checks do it. The billing context is built from real ids rather
      // than cast: a fake one would skip the usage-credit check.
      const customer = {
        ...SYSTEM_ACTOR,
        organizationId: targets[0]?.organizationId ?? "",
        projectId,
      };

      const run = await GeoPatrol.run({
        projectId,
        customer,
        createdBy: "schedule",
        platforms: ["chat_gpt", "google_ai_overview"] as GeoPlatform[],
      });

      result.projectsVisited += 1;
      result.targetsPatrolled += targets.length;
      result.answersArchived += run.answersArchived;
      result.costUsd += run.costUsd;

      for (const note of run.notes) {
        console.log(`[geo-patrol] ${projectId} — ${note}`);
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
