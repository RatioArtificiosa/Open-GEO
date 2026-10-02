import { GeoService } from "@/server/features/geo/services/GeoService";
import { GeoRetentionRepository } from "@/server/features/geo/repositories/GeoRetentionRepository";

/**
 * The daily retention sweep.
 *
 * Answers are the only GEO tables that grow without bound, so they are the only
 * ones that age out. A snapshot row deliberately survives its answers: the run's
 * cost, status and window are the audit trail — "we ran this on the 3rd and it
 * cost $0.94" — and that has to stay answerable after the answer text is gone.
 *
 * The sweep runs per project rather than globally so one project with a large
 * archive cannot starve the others inside a single tick, and so the run log can
 * name whose data was removed.
 */

// Not exported as a frozen object: `server.ts` imports exactly the named
// function, and an unused second export would be a claim about the API surface
// nothing consumes.
type RetentionRunResult = {
  projectsVisited: number;
  answersDeleted: number;
  /**
   * AI Mode snapshots removed.
   *
   * **A separate count rather than folded into `answersDeleted`,** because a silent
   * sum is what let the missing purge go unnoticed: the sweep reported a number, the
   * number was non-zero, and nothing in it said the largest table had been missed.
   */
  aiModeSnapshotsDeleted: number;
  cutoff: string;
  errors: string[];
};

type RetentionInput = {
  /**
   * Environment, for `GEO_ANSWER_RETENTION_DAYS`. Typed loosely because the
   * Cloudflare `Env` binding type has no index signature, and the only key this
   * reads is one optional string.
   */
  env: object;
  now?: Date;
  /** Safety valve so a first deploy cannot sweep every tenant at once. */
  limitProjects?: number;
};

async function runRetentionSweep(
  input: RetentionInput,
): Promise<RetentionRunResult> {
  const now = input.now ?? new Date();
  const limit = input.limitProjects ?? 50;

  // Archived projects keep their archive: archiving is a deletion promise, and a
  // sweep that keeps deleting after someone asked us to stop would be wrong.
  const cutoff = GeoRetentionRepository.cutoffFor(input.env, now);

  /**
   * Projects with rows past the cutoff, most overdue first — see
   * `GeoRetentionRepository.projectsWithExpiredRows` for why this is ordered by the
   * *data* rather than rotated by a timestamp, and why that matters more here than in
   * the four captures: skipping a project there costs freshness, and here it costs an
   * archive that never ages out.
   */
  const projectIds = (
    await GeoRetentionRepository.projectsWithExpiredRows(cutoff)
  )
    .map((row) => row.projectId)
    // **Still sliced** — a first deploy must not sweep every tenant at once — but now
    // the front of the list is the projects with the *most* expired rows, so the slice
    // does the most good per run rather than whatever the database happened to return.
    .slice(0, limit);

  const result: RetentionRunResult = {
    projectsVisited: 0,
    answersDeleted: 0,
    aiModeSnapshotsDeleted: 0,
    cutoff: "",
    errors: [],
  };

  if (projectIds.length === 0) return result;

  for (const projectId of projectIds) {
    try {
      const purged = await GeoService.purgeExpiredAnswers(
        projectId,
        input.env,
        now,
      );
      result.cutoff = purged.cutoff;
      result.answersDeleted += purged.answersDeleted;
      result.projectsVisited += 1;

      /**
       * AI Mode snapshots are purged **in the same pass**, and they had no caller at all.
       *
       * `purgeAiModeBefore` existed, was tested, and was never invoked — so
       * `ai_mode_snapshots` grew without bound while the sweep that exists to stop exactly
       * that reported success every night. It is the largest table in the schema, because
       * it stores the **verbatim answer markdown**: the whole model response, per keyword,
       * per market, per project, forever.
       *
       * `purgeAnswersBefore` cascades correctly for its own tree — `geo_answers` ->
       * citations, retrievals, fan-out queries and snapshot links all cascade on
       * `onDelete: "cascade"` — but the AI Mode snapshots are a **separate tree** with
       * nothing cascading from an answer row, so the one purge could never have covered
       * them.
       *
       * **Citations are deleted explicitly, and before the parents**: the ids have to be
       * read while the rows still exist, because `ai_mode_snapshot_citations` is keyed on
       * `snapshotId` rather than cascading. Deleting the snapshots first would leave the
       * join table referring to rows that no longer exist.
       */
      const expiredSnapshots =
        await GeoRetentionRepository.expiredAiModeSnapshotIds(
          projectId,
          result.cutoff,
        );
      await GeoRetentionRepository.deleteAiModeCitationsFor(expiredSnapshots);
      result.aiModeSnapshotsDeleted +=
        await GeoRetentionRepository.purgeAiModeBefore(
          projectId,
          result.cutoff,
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${projectId}: ${message}`);
      console.error(`[cron] GEO retention failed for ${projectId}:`, error);
    }
  }

  console.log("[cron] GEO retention complete", {
    projects: result.projectsVisited,
    answersDeleted: result.answersDeleted,
    aiModeSnapshotsDeleted: result.aiModeSnapshotsDeleted,
    errors: result.errors.length,
  });

  return result;
}

export async function runScheduledGeoRetention(
  env: object,
): Promise<RetentionRunResult> {
  return runRetentionSweep({ env });
}
