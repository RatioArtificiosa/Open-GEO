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
import { and, eq, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  aiModeSnapshotCitations,
  aiModeSnapshots,
  geoAnswers,
  geoSnapshots,
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

/** Remove snapshot links whose answer is gone, so the join table cannot rot. */
async function pruneOrphanedSnapshotAnswers(snapshotId: string): Promise<void> {
  await db.delete(geoSnapshots).where(eq(geoSnapshots.id, snapshotId));
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
  cutoffFor,
  purgeAnswersBefore,
  purgeAiModeBefore,
  pruneOrphanedSnapshotAnswers,
  countRetainedAnswers,
  deleteAiModeCitationsFor,
  DEFAULT_RETENTION_DAYS,
} as const;
