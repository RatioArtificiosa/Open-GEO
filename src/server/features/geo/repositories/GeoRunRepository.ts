/**
 * Data access for GEO monitoring runs: the snapshot row, the per-run rollups
 * (target metrics, citation domains), AI keyword demand series, and AI Mode
 * snapshots.
 *
 * Provider-aware (D1 or Postgres) via the `@/db` handle.
 *
 * The rollups are stored per platform and must be read per platform. Google AI
 * Overviews and ChatGPT compute `ai_search_volume` differently, so a combined
 * row would be a number that looks authoritative and means nothing.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches, runBatch } from "@/db/runBatch";
import {
  aiKeywordMetrics,
  aiModeSnapshotCitations,
  aiModeSnapshots,
  geoCitationDomains,
  geoSnapshots,
  geoTargetMetrics,
} from "@/db/schema";
import type { GeoPlatform, GeoTx } from "./GeoSetupRepository";

type GeoSnapshotRow = typeof geoSnapshots.$inferSelect;
type GeoTargetMetricRow = typeof geoTargetMetrics.$inferSelect;
type GeoCitationDomainRow = typeof geoCitationDomains.$inferSelect;
type AiKeywordMetricRow = typeof aiKeywordMetrics.$inferSelect;
type AiModeSnapshotRow = typeof aiModeSnapshots.$inferSelect;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

async function listSnapshots(
  projectId: string,
  limit = 50,
): Promise<GeoSnapshotRow[]> {
  return db
    .select()
    .from(geoSnapshots)
    .where(eq(geoSnapshots.projectId, projectId))
    .orderBy(desc(geoSnapshots.startedAt))
    .limit(limit);
}

async function getSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<GeoSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(geoSnapshots)
    .where(
      and(
        eq(geoSnapshots.id, snapshotId),
        eq(geoSnapshots.projectId, projectId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function insertSnapshot(tx: GeoTx, snapshot: typeof geoSnapshots.$inferInsert) {
  return tx.insert(geoSnapshots).values(snapshot);
}

/** Stamp the end of a run. Cost is what the vendor actually billed. */
function completeSnapshot(
  tx: GeoTx,
  snapshotId: string,
  patch: {
    costUsd?: number;
    status?: GeoSnapshotRow["status"];
  },
) {
  return tx
    .update(geoSnapshots)
    .set({ completedAt: new Date().toISOString(), ...patch })
    .where(eq(geoSnapshots.id, snapshotId));
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

/**
 * Per-target metrics for a run, one row per platform. Callers must render each
 * platform as its own number; the ordering makes that the natural iteration.
 */
async function listTargetMetrics(
  projectId: string,
  snapshotId: string,
): Promise<GeoTargetMetricRow[]> {
  return db
    .select()
    .from(geoTargetMetrics)
    .where(
      and(
        eq(geoTargetMetrics.projectId, projectId),
        eq(geoTargetMetrics.snapshotId, snapshotId),
      ),
    )
    .orderBy(asc(geoTargetMetrics.platform));
}

/** Top cited domains for a run on one platform, for share-of-voice. */
async function listCitationDomains(
  projectId: string,
  snapshotId: string,
  platform: GeoPlatform,
  limit = 50,
): Promise<GeoCitationDomainRow[]> {
  const snapshot = await getSnapshot(projectId, snapshotId);
  if (!snapshot) return [];
  return db
    .select()
    .from(geoCitationDomains)
    .where(
      and(
        eq(geoCitationDomains.snapshotId, snapshotId),
        eq(geoCitationDomains.platform, platform),
      ),
    )
    .orderBy(desc(geoCitationDomains.mentions))
    .limit(limit);
}

/**
 * Write the per-platform rollups for a run. Runs its own batches rather than
 * returning builders, because a patrol can exceed one batch and the chunking
 * has to happen here.
 */
async function insertTargetMetrics(
  rows: Array<typeof geoTargetMetrics.$inferInsert>,
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx.insert(geoTargetMetrics).values(row),
  );
}

function insertCitationDomains(
  tx: GeoTx,
  rows: Array<typeof geoCitationDomains.$inferInsert>,
) {
  return rows.map((row) =>
    tx
      .insert(geoCitationDomains)
      .values(row)
      .onConflictDoUpdate({
        target: [
          geoCitationDomains.snapshotId,
          geoCitationDomains.platform,
          geoCitationDomains.domain,
        ],
        set: {
          mentions: row.mentions,
          aiSearchVolume: row.aiSearchVolume ?? null,
        },
      }),
  );
}

// ---------------------------------------------------------------------------
// AI keyword demand
// ---------------------------------------------------------------------------

/**
 * The demand series for a keyword, oldest first. Months may be absent from the
 * vendor payload; a missing month stays missing rather than being interpolated
 * to zero, which would invent a dip that never happened.
 */
async function listAiKeywordHistory(
  projectId: string,
  keyword: string,
): Promise<AiKeywordMetricRow[]> {
  return db
    .select()
    .from(aiKeywordMetrics)
    .where(
      and(
        eq(aiKeywordMetrics.projectId, projectId),
        eq(aiKeywordMetrics.keyword, keyword),
      ),
    )
    .orderBy(asc(aiKeywordMetrics.month));
}

/**
 * Upsert monthly demand. Keyed on project+keyword+market+month, so re-running
 * a month's pull corrects the value instead of duplicating the point.
 */
async function upsertAiKeywordMetrics(
  rows: Array<typeof aiKeywordMetrics.$inferInsert>,
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(aiKeywordMetrics)
      .values(row)
      .onConflictDoUpdate({
        target: [
          aiKeywordMetrics.projectId,
          aiKeywordMetrics.keyword,
          aiKeywordMetrics.locationCode,
          aiKeywordMetrics.languageCode,
          aiKeywordMetrics.month,
        ],
        set: {
          aiSearchVolume: row.aiSearchVolume ?? null,
          capturedAt: row.capturedAt,
        },
      }),
  );
}

// ---------------------------------------------------------------------------
// AI Mode
// ---------------------------------------------------------------------------

/** AI Mode captures for a keyword, newest first, for the answer-change diff. */
async function listAiModeSnapshots(
  projectId: string,
  keyword: string,
  limit = 50,
): Promise<AiModeSnapshotRow[]> {
  return db
    .select()
    .from(aiModeSnapshots)
    .where(
      and(
        eq(aiModeSnapshots.projectId, projectId),
        eq(aiModeSnapshots.keyword, keyword),
      ),
    )
    .orderBy(desc(aiModeSnapshots.capturedAt))
    .limit(limit);
}

/** Write an AI Mode capture and its citation set atomically. */
async function insertAiModeSnapshot(
  snapshot: typeof aiModeSnapshots.$inferInsert & { id: string },
  citations: Array<
    Omit<typeof aiModeSnapshotCitations.$inferInsert, "snapshotId">
  >,
): Promise<void> {
  await runBatch((tx) => {
    const statements: Array<Promise<unknown>> = [
      tx.insert(aiModeSnapshots).values(snapshot),
    ];
    for (const citation of citations) {
      statements.push(
        tx
          .insert(aiModeSnapshotCitations)
          .values({ ...citation, snapshotId: snapshot.id })
          .onConflictDoNothing(),
      );
    }
    return statements;
  });
}

export const GeoRunRepository = {
  listSnapshots,
  getSnapshot,
  insertSnapshot,
  completeSnapshot,
  listTargetMetrics,
  listCitationDomains,
  insertTargetMetrics,
  insertCitationDomains,
  listAiKeywordHistory,
  upsertAiKeywordMetrics,
  listAiModeSnapshots,
  insertAiModeSnapshot,
} as const;
