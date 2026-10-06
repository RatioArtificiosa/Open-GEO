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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches, runBatch } from "@/db/runBatch";
import {
  aiKeywordMetrics,
  aiModeSnapshotCitations,
  aiModeSnapshots,
  geoAnswerCitations,
  geoAnswers,
  geoCitationDomains,
  geoSnapshotAnswers,
  geoSnapshots,
  geoTargetMetrics,
  keywordMetrics,
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

/**
 * Every (answer, cited host) pair inside one run, for the co-citation graph.
 *
 * **A flat read, not a self-join.** The pairs are derived in
 * `citationCoCitations`, because that is where the caps and the tie-breaks live
 * and a pure function can be tested without a database. The join here is the one
 * that scopes the read: `geo_answers` carries no `snapshot_id`, so membership
 * comes through `geo_snapshot_answers` — the same trap the forecast reader was
 * caught by, and the reason the `WHERE` is on the link table's column.
 */
async function listSnapshotCitations(
  projectId: string,
  snapshotId: string,
): Promise<Array<{ answerId: string; domain: string | null }>> {
  const snapshot = await getSnapshot(projectId, snapshotId);
  if (!snapshot) return [];
  return db
    .select({
      answerId: geoAnswerCitations.answerId,
      domain: geoAnswerCitations.domain,
    })
    .from(geoAnswerCitations)
    .innerJoin(
      geoSnapshotAnswers,
      eq(geoSnapshotAnswers.answerId, geoAnswerCitations.answerId),
    )
    .where(eq(geoSnapshotAnswers.snapshotId, snapshotId));
}

/**
 * Every AI keyword this project holds demand for, with its most recent month.
 *
 * **The prompt-set generator's ranking seed, and it costs nothing** — this is the
 * cached result of an `ai_keyword_data` pull, not a vendor call.
 *
 * **No `LIMIT`, deliberately.** The obvious version truncates to the newest N rows,
 * which cuts by *month* rather than by demand and can drop a high-demand keyword
 * whose last pull was older — the cap would then hide exactly the topics worth
 * asking about. Truncating before ranking is a defect, so the ranking happens in
 * `buildPromptSet` and the cap is applied there, after it. The read is bounded by
 * keywords × months for one project, which the nightly capture's own caps hold.
 *
 * The latest month per keyword is chosen in code rather than with a window
 * function: a portable `ORDER BY month DESC` plus first-one-wins cannot disagree
 * with itself about which row is "latest", and SQLite, Postgres and libSQL all
 * spell that differently.
 */
async function listAiKeywordDemand(
  projectId: string,
): Promise<Array<{ keyword: string; aiSearchVolume: number | null }>> {
  const rows = await db
    .select({
      keyword: aiKeywordMetrics.keyword,
      aiSearchVolume: aiKeywordMetrics.aiSearchVolume,
      month: aiKeywordMetrics.month,
    })
    .from(aiKeywordMetrics)
    .where(eq(aiKeywordMetrics.projectId, projectId))
    .orderBy(desc(aiKeywordMetrics.month), asc(aiKeywordMetrics.keyword));

  const latest = new Map<string, number | null>();
  for (const row of rows) {
    // Newest-first, so the first row per keyword is its latest month. A month with
    // no recorded volume keeps `null` — "not measured" is not zero.
    if (latest.has(row.keyword)) continue;
    latest.set(row.keyword, row.aiSearchVolume ?? null);
  }
  return [...latest.entries()].map(([keyword, aiSearchVolume]) => ({
    keyword,
    aiSearchVolume,
  }));
}

/**
 * The cached search intent for a specific set of keywords.
 *
 * Read for the keywords the AI-demand read returned rather than for the whole
 * project, so the join is small and cannot drift. **The key match is exact** —
 * `keyword_metrics.keyword` is stored `trim().toLowerCase()` by
 * `normalizeKeyword` and `ai_keyword_metrics.keyword` by `normaliseAiKeyword`,
 * which are the same two operations in the same order. A near-miss here would
 * silently label every keyword unclassified, which is a prompt set of
 * `what is …` questions and nothing to point at.
 */
async function listKeywordIntents(
  projectId: string,
  keywords: string[],
): Promise<Array<{ keyword: string; intent: string | null }>> {
  if (keywords.length === 0) return [];
  return db
    .select({
      keyword: keywordMetrics.keyword,
      intent: keywordMetrics.intent,
    })
    .from(keywordMetrics)
    .where(
      and(
        eq(keywordMetrics.projectId, projectId),
        inArray(keywordMetrics.keyword, keywords),
      ),
    );
}

/**
 * Questions this project's runs have already asked, most recent first.
 *
 * **This is the honest half of the blocked mentions call.** The row asks to seed
 * from *"existing mention questions (`search_scope:["question"]`)"* — questions the
 * engines have already been asked about the brand — and the archive is where those
 * actually live today, because every stored answer records the prompt that produced
 * it. A vendor call would add prompts we have not asked yet; it would not change
 * what we have, and it cannot be made while the account is unverified.
 */
async function listRecentArchivedPrompts(
  projectId: string,
  limit = 200,
): Promise<string[]> {
  const rows = await db
    .select({ prompt: geoAnswers.prompt })
    .from(geoAnswers)
    .where(eq(geoAnswers.projectId, projectId))
    .orderBy(desc(geoAnswers.answeredAt))
    .limit(limit);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const prompt = row.prompt.trim().replace(/\s+/g, " ");
    const key = prompt.toLowerCase();
    if (prompt.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(prompt);
  }
  return out;
}

export const GeoRunRepository = {
  listSnapshots,
  getSnapshot,
  insertSnapshot,
  completeSnapshot,
  listTargetMetrics,
  listCitationDomains,
  listSnapshotCitations,
  listAiKeywordDemand,
  listKeywordIntents,
  listRecentArchivedPrompts,
  insertTargetMetrics,
  insertCitationDomains,
  listAiKeywordHistory,
  upsertAiKeywordMetrics,
  listAiModeSnapshots,
  insertAiModeSnapshot,
} as const;
