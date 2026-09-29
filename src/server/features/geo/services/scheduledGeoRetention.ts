import { eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { geoTargets, projects } from "@/db/schema";
import { GeoService } from "@/server/features/geo/services/GeoService";

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
  const active = await db
    .selectDistinct({ projectId: projects.id })
    .from(geoTargets)
    .innerJoin(projects, eq(geoTargets.projectId, projects.id))
    .where(isNull(projects.archivedAt));

  const projectIds = active.map((row) => row.projectId).slice(0, limit);
  const result: RetentionRunResult = {
    projectsVisited: 0,
    answersDeleted: 0,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${projectId}: ${message}`);
      console.error(`[cron] GEO retention failed for ${projectId}:`, error);
    }
  }

  console.log("[cron] GEO retention complete", {
    projects: result.projectsVisited,
    answersDeleted: result.answersDeleted,
    errors: result.errors.length,
  });

  return result;
}

export async function runScheduledGeoRetention(
  env: object,
): Promise<RetentionRunResult> {
  return runRetentionSweep({ env });
}
