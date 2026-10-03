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
import { and, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
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
 * How many snapshot ids go into one `IN (...)` clause.
 *
 * **D1 allows 100 bound parameters per statement.** 90 leaves headroom rather than
 * sitting exactly on the limit — a cap with no margin is a cap that fails on the
 * first statement that also binds something else.
 */
const CITATION_DELETE_CHUNK = 90;

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
 * Active projects **that have something to purge**, ordered by id.
 *
 * ## The bug this replaced
 *
 * The project query had **no `ORDER BY`** and no filter, so `.slice(0, limit)` took every
 * active project in whatever order the database returned. In a capture that costs
 * freshness — the work happens tomorrow. Here it costs **an archive growing without bound,
 * permanently**: a project past the cap is never visited, so its rows never age out, and
 * nothing brings it back because the same projects keep winning.
 *
 * ## Why there is no rotation here, and what does the work instead
 *
 * Every other fix this session was a rotation, which needs a moment that *changes* after
 * each pass. **No such moment exists** — there is no sweep-audit table, and adding one is
 * a migration to solve a scheduling problem.
 *
 * So the rotation comes from **the filter rather than the order**, which is worth being
 * exact about because the two are easy to confuse:
 *
 * | | what it does |
 * |---|---|
 * | `.orderBy(projects.id)` | **nothing useful** — a stable, arbitrary order |
 * | `or(isNotNull(expired…))` | **this is the rotation** |
 *
 * **A project with nothing expired is not a candidate at all.** Sweeping empties its
 * expired set, so it stops being a candidate — and the project behind it becomes one. The
 * queue advances *because the work is done*, not because anything ranks it.
 *
 * That is the whole design, and it has one property a rank could not have: **there is no
 * timestamp to go stale and no state to corrupt.** A project whose sweep failed stays a
 * candidate, which is the correct outcome, and a project with nothing to purge occupies no
 * slot, so a deployment with hundreds of active projects still reaches its expiring ones.
 *
 * ## The ordering is therefore *not* "most overdue first", and this comment said it was
 *
 * An earlier version of this doc claimed projects were ranked by expired-row count and
 * that a clean project "sorts last". **Neither is true**, and both claims were doing real
 * work in a reader's head: the first implies a priority the query does not have, and the
 * second implies an inclusion the filter actually excludes. CodeRabbit caught it by
 * comparing the comment to the code — which is the fourth time this session a comment, not
 * a test, was the thing that was wrong.
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

  /**
   * **`inArray`, chunked — and both halves are load-bearing.**
   *
   * The previous version was `and(...snapshotIds.map(eq))`, which is wrong twice:
   *
   * 1. **One id renders `AND ()`**, which is not valid SQL — and **one expired snapshot
   *    is the common case**, not the edge case. The zero case returned early; the one
   *    case did not.
   * 2. **One bound parameter per id**, against **D1's 100-parameter cap**. A project
   *    with 200 expired snapshots produced a statement D1 rejects — *after* the ids were
   *    read, so the sweep had done its work and then threw.
   *
   * `inArray` fixes the first and is the right shape for the second. The **chunking is
   * what the cap actually requires**: `inArray` still binds one parameter per element,
   * so an unchunked `inArray` fixes defect 1 and leaves defect 2 untouched.
   *
   * **This had no caller until this session**, so both defects were latent rather than
   * observed — which is the usual relationship between an orphan and a live bug.
   */
  /**
   * **`inArray`, chunked — and the chunking is the load-bearing half.**
   *
   * The previous version was `and(...snapshotIds.map(eq))`, which binds **one parameter
   * per id**. D1 allows 100 per statement, so a project with 200 expired snapshots
   * produced a statement D1 rejects — *after* the ids were read, so the sweep had done
   * its work and then threw.
   *
   * **Measured, because the obvious worry was the wrong one.** Drizzle *elides* the
   * wrapper for a single predicate, so one id — the common case — was always valid SQL:
   *
   * ```
   * ONE id    and(...) -> where "snapshot_id" = ?
   * TWO ids   and(...) -> where ("snapshot_id" = ? and "snapshot_id" = ?)
   * ```
   *
   * **And the zero case is the one worth naming**, because it is not a syntax error:
   *
   * ```
   * ZERO ids  and()    -> delete from "ai_mode_snapshot_citations"    ← no WHERE
   * ```
   *
   * So the `length === 0` early return above is the **only** thing standing between an
   * empty id list and a full-table delete. It is correct — but the safety is invisible
   * at the delete, resting entirely on a guard one line above.
   *
   * `inArray` removes that branch rather than relying on the guard: it renders
   * `where 1 = 0` for an empty list, which deletes nothing. **The early return stays
   * because skipping the round trip is worth more than the branch is worth.**
   *
   * **The chunking is what the parameter cap actually requires** — `inArray` still
   * binds one parameter per element, so an unchunked `inArray` would fix nothing.
   */
  for (
    let start = 0;
    start < snapshotIds.length;
    start += CITATION_DELETE_CHUNK
  ) {
    const chunk = snapshotIds.slice(start, start + CITATION_DELETE_CHUNK);
    await db
      .delete(aiModeSnapshotCitations)
      .where(inArray(aiModeSnapshotCitations.snapshotId, chunk));
  }
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
