/**
 * Retention for the GEO archive.
 *
 * Answers are the only tables that grow without bound, so they are the ones
 * with a purge. Everything else is bounded by the number of targets, prompt
 * sets and runs a project has.
 *
 * A snapshot row survives its answers: the run's cost, status and window are
 * the audit trail — "we ran this on the 3rd and it cost $0.94" — and that has
 * to stay answerable after the answer text ages out.
 */
import { and, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import {
  aiModeSnapshotCitations,
  aiModeSnapshots,
  geoAnswers,
  geoTargets,
  projects,
} from "@/db/schema";

const DEFAULT_RETENTION_DAYS = 180;

/**
 * Resolve the retention window, defaulting to half a year.
 *
 * `env` is typed `object` because the Cloudflare `Env` binding has no index
 * signature, and the read is narrowed explicitly below — a plain
 * `env.GEO_ANSWER_RETENTION_DAYS` would not compile against that type.
 */
function retentionDays(env: object): number {
  const raw: unknown = Reflect.get(env, "GEO_ANSWER_RETENTION_DAYS");
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RETENTION_DAYS;
}

/** The ISO cutoff before which answers are eligible for deletion. */
function cutoffFor(env: object, now = new Date()): string {
  const ms = retentionDays(env) * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms).toISOString();
}

/**
 * Active projects with expired rows waiting, **most-overdue first.**
 *
 * ## This is the retention sweep's version of a bug the four captures shared
 *
 * The project query had **no `ORDER BY`**, so `.slice(0, limit)` took whatever order
 * the database returned. In a capture that costs freshness — the work happens tomorrow.
 * Here it costs **the archive growing without bound, permanently**: the same projects are
 * purged nightly and every project past the cap never ages out at all. Nothing comes
 * back for them, because the same ones keep winning.
 *
 * ## Why this is ordered by the data rather than by a rotation
 *
 * Every other fix this session was a rotation, which needs a moment that *changes* after
 * each pass. **No such moment exists here** — there is no sweep-audit table, and adding
 * one is a migration to solve a scheduling problem.
 *
 * What does change is the data: a project holding rows past the cutoff becomes purgable,
 * and purging it empties the set. Ordering by that gives a bounded cadence **using state
 * that already exists**, and it degrades correctly:
 *
 * | | rows past cutoff | position |
 * |---|---|---|
 * | | 50,000 | first — most overdue, swept tonight |
 * | | 3 | first among the rest — the smallest sweep, most owed |
 * | | 0 | last — nothing to do, and it stays out of the way |
 *
 * A project with nothing to purge sorts last **without needing a timestamp**, which is
 * what makes this work rather than needing an audit trail.
 *
 * **Both tables, and both matter.** `geo_answers` is what the sweep called before;
 * `ai_mode_snapshots` holds the verbatim answer markdown, so it is the larger of the two
 * and was being left to grow without bound.
 */
async function projectsWithExpiredRows(
  cutoffIso: string,
): Promise<Array<{ projectId: string }>> {
  const expiredAnswers = db
    .selectDistinct({ projectId: geoAnswers.projectId })
    .from(geoAnswers)
    .where(lte(geoAnswers.answeredAt, cutoffIso))
    // **`as()`, because a `.where()` returns a builder, not a subquery** — a join needs
    // something it can address columns on, and the type says exactly that.
    .as("expiredAnswers");

  const expiredSnapshots = db
    .selectDistinct({ projectId: aiModeSnapshots.projectId })
    .from(aiModeSnapshots)
    .where(lt(aiModeSnapshots.capturedAt, cutoffIso))
    .as("expiredSnapshots");

  const rows = await db
    .selectDistinct({ projectId: projects.id })
    .from(geoTargets)
    .innerJoin(projects, eq(geoTargets.projectId, projects.id))
    .leftJoin(expiredAnswers, eq(expiredAnswers.projectId, projects.id))
    .leftJoin(expiredSnapshots, eq(expiredSnapshots.projectId, projects.id))
    .where(
      and(
        isNull(projects.archivedAt),
        // **Only projects with something to purge.** Archived projects keep their
        // archive: archiving is a deletion promise, and a sweep that keeps deleting
        // after someone asked us to stop would be wrong.
        or(
          isNotNull(expiredAnswers.projectId),
          isNotNull(expiredSnapshots.projectId),
        ),
      ),
    )
    .orderBy(projects.id);

  return rows;
}

/**
 * Delete archived answers older than the cutoff, scoped to one project.
 *
 * Citations, retrievals, fan-out queries and snapshot links cascade from the
 * answer row. Returns the number of answers removed so the caller can report
 * it rather than guessing.
 */
async function purgeAnswersBefore(
  projectId: string,
  cutoffIso: string,
): Promise<number> {
  const deleted = await db
    .delete(geoAnswers)
    .where(
      and(
        eq(geoAnswers.projectId, projectId),
        lte(geoAnswers.answeredAt, cutoffIso),
      ),
    )
    .returning({ id: geoAnswers.id });
  return deleted.length;
}

/**
 * The ids of the AI Mode snapshots a purge **would** remove.
 *
 * **Read before the rows are deleted**, because `ai_mode_snapshot_citations` is keyed on
 * `snapshotId` and does not cascade — so the citations have to be removed explicitly, and
 * once the snapshots are gone their ids are gone with them. Asking first is what makes
 * the cleanup possible rather than merely tidy.
 */
async function expiredAiModeSnapshotIds(
  projectId: string,
  cutoffIso: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: aiModeSnapshots.id })
    .from(aiModeSnapshots)
    .where(
      and(
        eq(aiModeSnapshots.projectId, projectId),
        lt(aiModeSnapshots.capturedAt, cutoffIso),
      ),
    );
  return rows.map((row) => row.id);
}

/** Delete AI Mode captures older than the cutoff. */
async function purgeAiModeBefore(
  projectId: string,
  cutoffIso: string,
): Promise<number> {
  const deleted = await db
    .delete(aiModeSnapshots)
    .where(
      and(
        eq(aiModeSnapshots.projectId, projectId),
        lt(aiModeSnapshots.capturedAt, cutoffIso),
      ),
    )
    .returning({ id: aiModeSnapshots.id });
  return deleted.length;
}

/** How many answers a project is currently holding, for the usage meter. */
async function countRetainedAnswers(
  projectId: string,
  cutoffIso: string,
): Promise<number> {
  const rows = await db
    .select({ id: geoAnswers.id })
    .from(geoAnswers)
    .where(
      and(
        eq(geoAnswers.projectId, projectId),
        lte(geoAnswers.answeredAt, cutoffIso),
      ),
    );
  return rows.length;
}

/** The citation rows an AI Mode purge leaves behind, cleaned explicitly. */
async function deleteAiModeCitationsFor(snapshotIds: string[]): Promise<void> {
  if (snapshotIds.length === 0) return;
  await db
    .delete(aiModeSnapshotCitations)
    .where(
      and(
        ...snapshotIds.map((id) => eq(aiModeSnapshotCitations.snapshotId, id)),
      ),
    );
}

export const GeoRetentionRepository = {
  retentionDays,
  projectsWithExpiredRows,
  cutoffFor,
  purgeAnswersBefore,
  expiredAiModeSnapshotIds,
  purgeAiModeBefore,
  countRetainedAnswers,
  deleteAiModeCitationsFor,
  DEFAULT_RETENTION_DAYS,
} as const;
