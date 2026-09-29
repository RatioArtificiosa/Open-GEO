/**
 * Data access for the GEO answer archive: stored answers and the citation,
 * retrieval and fan-out sets hanging off them, plus the gap query.
 *
 * Provider-aware (D1 or Postgres) via the `@/db` handle.
 *
 * Two invariants are load-bearing here, not decoration:
 *
 * 1. Nothing is ever filtered or aggregated across `platform`. Google AI
 *    Overviews and ChatGPT compute `ai_search_volume` differently (Google's is
 *    real search volume, ChatGPT's is People-Also-Ask modelled). A query that
 *    omitted the platform predicate would return a number that looks
 *    authoritative and means nothing.
 *
 * 2. Citations and retrievals are separate tables. The gap between them is the
 *    product's most valuable output, so it is never collapsed into one nullable
 *    column, and the gap query is written out longhand rather than hidden.
 */
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  geoAnswerCitations,
  geoAnswerRetrievals,
  geoAnswers,
  geoFanoutQueries,
  geoSnapshotAnswers,
} from "@/db/schema";
import type { GeoPlatform, GeoTx } from "./GeoSetupRepository";

export type GeoAnswerRow = typeof geoAnswers.$inferSelect;
export type GeoAnswerCitationRow = typeof geoAnswerCitations.$inferSelect;
export type GeoAnswerRetrievalRow = typeof geoAnswerRetrievals.$inferSelect;

export type GeoAnswerWithSets = {
  answer: GeoAnswerRow;
  citations: GeoAnswerCitationRow[];
  retrievals: GeoAnswerRetrievalRow[];
  fanOutQueries: string[];
};

/** One archived answer being written: the answer plus whatever it came with. */
export type GeoAnswerInsert = {
  answer: typeof geoAnswers.$inferInsert;
  citations?: Array<Omit<typeof geoAnswerCitations.$inferInsert, "answerId">>;
  retrievals?: Array<Omit<typeof geoAnswerRetrievals.$inferInsert, "answerId">>;
  fanOutQueries?: string[];
};

/**
 * The diff read: every archived answer for a target on ONE platform, newest
 * first. `platform` is a required parameter, not an option — see the header.
 */
async function listAnswersForTarget(
  projectId: string,
  targetId: string,
  platform: GeoPlatform,
  options: { since?: string; limit?: number } = {},
): Promise<GeoAnswerRow[]> {
  const filters = [
    eq(geoAnswers.projectId, projectId),
    eq(geoAnswers.targetId, targetId),
    eq(geoAnswers.platform, platform),
  ];
  if (options.since) filters.push(gte(geoAnswers.answeredAt, options.since));
  return db
    .select()
    .from(geoAnswers)
    .where(and(...filters))
    .orderBy(desc(geoAnswers.answeredAt))
    .limit(options.limit ?? 200);
}

/** Answers matching a prompt, for diffing one specific question over time. */
async function listAnswersForPrompt(
  projectId: string,
  prompt: string,
  platform: GeoPlatform,
  limit = 100,
): Promise<GeoAnswerRow[]> {
  return db
    .select()
    .from(geoAnswers)
    .where(
      and(
        eq(geoAnswers.projectId, projectId),
        eq(geoAnswers.prompt, prompt),
        eq(geoAnswers.platform, platform),
      ),
    )
    .orderBy(desc(geoAnswers.answeredAt))
    .limit(limit);
}

/** Answers for a caller that already holds the ids, e.g. after a batch write. */
async function listAnswersByIds(
  projectId: string,
  answerIds: string[],
): Promise<GeoAnswerRow[]> {
  if (answerIds.length === 0) return [];
  return db
    .select()
    .from(geoAnswers)
    .where(
      and(
        eq(geoAnswers.projectId, projectId),
        inArray(geoAnswers.id, answerIds),
      ),
    );
}

/** One answer with its citation set, retrieval set and fan-out queries. */
async function getAnswerWithSets(
  projectId: string,
  answerId: string,
): Promise<GeoAnswerWithSets | null> {
  const [answer] = await db
    .select()
    .from(geoAnswers)
    .where(
      and(eq(geoAnswers.id, answerId), eq(geoAnswers.projectId, projectId)),
    )
    .limit(1);
  if (!answer) return null;

  const [citations, retrievals, fanOut] = await Promise.all([
    db
      .select()
      .from(geoAnswerCitations)
      .where(eq(geoAnswerCitations.answerId, answerId)),
    db
      .select()
      .from(geoAnswerRetrievals)
      .where(eq(geoAnswerRetrievals.answerId, answerId)),
    db
      .select()
      .from(geoFanoutQueries)
      .where(eq(geoFanoutQueries.answerId, answerId))
      .orderBy(geoFanoutQueries.position),
  ]);

  return {
    answer,
    citations,
    retrievals,
    fanOutQueries: fanOut.map((row) => row.query),
  };
}

/** Builders for one answer and its child rows, composed into a caller's batch. */
function buildAnswerStatements(
  tx: GeoTx,
  entry: GeoAnswerInsert,
  snapshotId: string | null,
): Array<Promise<unknown>> {
  const answerId = entry.answer.id;
  if (!answerId) {
    throw new Error("geo answer insert requires an explicit id");
  }

  const statements: Array<Promise<unknown>> = [
    tx.insert(geoAnswers).values(entry.answer),
  ];

  // ON CONFLICT DO NOTHING on both child tables: they are keyed on
  // (answerId, url), and the same source URL legitimately appears more than
  // once in one answer's list. Without this the batch aborts on the duplicate.
  for (const citation of entry.citations ?? []) {
    statements.push(
      tx
        .insert(geoAnswerCitations)
        .values({ ...citation, answerId })
        .onConflictDoNothing(),
    );
  }
  for (const retrieval of entry.retrievals ?? []) {
    statements.push(
      tx
        .insert(geoAnswerRetrievals)
        .values({ ...retrieval, answerId })
        .onConflictDoNothing(),
    );
  }
  entry.fanOutQueries?.forEach((query, index) => {
    statements.push(
      tx
        .insert(geoFanoutQueries)
        .values({ answerId, query, position: index })
        .onConflictDoNothing(),
    );
  });

  // Link the answer to the run that produced it. Without this a snapshot has no
  // answers, which makes "what did this run find?" unanswerable — the whole
  // point of recording the run at all.
  if (snapshotId) {
    statements.push(
      tx
        .insert(geoSnapshotAnswers)
        .values({ snapshotId, answerId })
        .onConflictDoNothing(),
    );
  }

  return statements;
}

/**
 * Write a batch of answers and everything hanging off them atomically.
 *
 * `answer.id` must be set by the caller: the child rows reference it, and the
 * same value has to appear in the parent and child inserts.
 */
async function insertAnswers(
  inserts: GeoAnswerInsert[],
  snapshotId?: string,
): Promise<void> {
  if (inserts.length === 0) return;

  const stamped = new Date().toISOString();
  await runBatch((tx) =>
    inserts.flatMap((entry) =>
      buildAnswerStatements(
        tx,
        { ...entry, answer: { createdAt: stamped, ...entry.answer } },
        snapshotId ?? null,
      ),
    ),
  );
}

/**
 * Pages a model retrieved without citing, for a target on a platform that
 * reports retrieval.
 *
 * Returns [] for platforms without retrieval coverage (Google AI Overviews)
 * rather than throwing, so a caller can render one honest empty state instead
 * of four different errors. `platformSupportsRetrieval` is how they explain it.
 */
async function listCitationGaps(
  projectId: string,
  targetId: string,
  platform: GeoPlatform,
  domain: string,
  options: { since?: string; limit?: number } = {},
): Promise<Array<{ url: string; rank: number | null; answerId: string }>> {
  const answerFilters = [
    eq(geoAnswers.projectId, projectId),
    eq(geoAnswers.targetId, targetId),
    eq(geoAnswers.platform, platform),
  ];
  if (options.since)
    answerFilters.push(gte(geoAnswers.answeredAt, options.since));

  // A LEFT JOIN from retrievals to citations keeping only rows with no matching
  // citation. This is the whole product in one query, so it is written out
  // rather than hidden behind a helper: the `IS NULL` is doing the real work.
  return db
    .select({
      url: geoAnswerRetrievals.url,
      rank: geoAnswerRetrievals.rank,
      answerId: geoAnswerRetrievals.answerId,
    })
    .from(geoAnswerRetrievals)
    .innerJoin(geoAnswers, eq(geoAnswerRetrievals.answerId, geoAnswers.id))
    .leftJoin(
      geoAnswerCitations,
      sql`${geoAnswerCitations.url} = ${geoAnswerRetrievals.url}
          AND ${geoAnswerCitations.answerId} = ${geoAnswerRetrievals.answerId}`,
    )
    .where(
      and(
        ...answerFilters,
        sql`${geoAnswerCitations.url} IS NULL`,
        sql`${geoAnswerRetrievals.domain} = ${domain}`,
      ),
    )
    .limit(options.limit ?? 100);
}

async function countAnswers(
  projectId: string,
  platform?: GeoPlatform,
): Promise<number> {
  const filters = [eq(geoAnswers.projectId, projectId)];
  if (platform) filters.push(eq(geoAnswers.platform, platform));
  const [row] = await db
    .select({ value: count() })
    .from(geoAnswers)
    .where(and(...filters));
  return row?.value ?? 0;
}

/** Distinct prompts archived for a project, for coverage reporting. */
async function listCoveredPrompts(
  projectId: string,
  platform: GeoPlatform,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ prompt: geoAnswers.prompt })
    .from(geoAnswers)
    .where(
      and(
        eq(geoAnswers.projectId, projectId),
        eq(geoAnswers.platform, platform),
      ),
    );
  return rows.map((row) => row.prompt);
}

export const GeoAnswerRepository = {
  listAnswersForTarget,
  listAnswersForPrompt,
  listAnswersByIds,
  getAnswerWithSets,
  insertAnswers,
  listCitationGaps,
  countAnswers,
  listCoveredPrompts,
} as const;
