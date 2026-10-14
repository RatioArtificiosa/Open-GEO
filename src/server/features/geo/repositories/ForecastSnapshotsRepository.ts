import { and, desc, eq, gte, lte } from "drizzle-orm";

import { db } from "@/db";
import { geoForecastSnapshots } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import {
  asForecastKind,
  type ForecastKind,
  type ForecastSnapshotRow,
} from "@/server/features/geo/services/forecastSnapshot";

/**
 * `YYYY-MM-DD`, and a real day in the calendar.
 *
 * Anchored, and round-tripped through `Date` rather than trusted from the shape:
 * `2026-13-45` matches the pattern and is not a date, and the reads below compare
 * this column as a string, so a plausible-looking spelling would sort into the
 * wrong place rather than fail.
 */
function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  // The round trip is the check: `Date` normalises an impossible day into a
  // different one, so the round trip only succeeds for a day that exists.
  return new Date(parsed).toISOString().startsWith(value);
}

/**
 * Reads and writes for `geo_forecast_snapshots`.
 *
 * ## Why the write ignores a conflict instead of updating
 *
 * The unique key carries `issued_on`, so a second run on the same night produces
 * the *same* key rather than a new row. `onConflictDoNothing` is therefore not an
 * optimisation — it is the rule that makes a re-run harmless. The alternative,
 * an upsert, would let a cron that fires twice rewrite the evening's forecast with
 * a value computed minutes later from a slightly different archive, and the row's
 * whole claim is that it was made on the date it names.
 *
 * ## Why the reads are split the way they are
 *
 * Three questions, three shapes, and none of them is "all rows for a project":
 *
 * 1. `latestFor` — what the product says today. A re-derivation of the forecast on
 *    every read is exactly what this table exists to stop, and it also lets the
 *    caller show *when* the sentence was written.
 * 2. `historyFor` — one subject's series, oldest first, so a chart can show the
 *    forecast moving over time rather than only its final value.
 * 3. `asOfFor` — the row issued on or before a given day, which is what an accuracy
 *    check needs: the forecast that was *standing* on the day the measurement was
 *    taken, not the one written afterwards. Reading the newest row instead would
 *    score today's opinion against today's fact, and that comparison always agrees.
 */

/** The row shape this repository returns, as stored. */
type ForecastSnapshotRecord = {
  id: number;
  projectId: string;
  kind: ForecastKind;
  subject: string;
  modelVersion: string;
  issuedOn: string;
  horizonDays: number;
  shareBp: number | null;
  lowBp: number | null;
  highBp: number | null;
  perWeekBp: number | null;
  nowBp: number | null;
  basedOn: number;
  basedOnWeeks: number | null;
  confidence: string | null;
  note: string | null;
};

/** The row shape drizzle returns, before the `kind` string is narrowed. */
type RawForecastRow = {
  id: number;
  projectId: string;
  kind: string;
  subject: string;
  modelVersion: string;
  issuedOn: string;
  horizonDays: number;
  shareBp: number | null;
  lowBp: number | null;
  highBp: number | null;
  perWeekBp: number | null;
  nowBp: number | null;
  basedOn: number;
  basedOnWeeks: number | null;
  confidence: string | null;
  note: string | null;
  createdAt: string;
};

/**
 * Narrow one stored row, dropping the two columns nobody reads.
 *
 * `createdAt` is dropped because the row's claim is its `issuedOn`: the insert time
 * is an implementation detail of when the job happened to run, and a reader that
 * showed it would be showing the scheduler rather than the forecast.
 */
function toRecord(row: RawForecastRow): ForecastSnapshotRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: asForecastKind(row.kind),
    subject: row.subject,
    modelVersion: row.modelVersion,
    issuedOn: row.issuedOn,
    horizonDays: row.horizonDays,
    shareBp: row.shareBp,
    lowBp: row.lowBp,
    highBp: row.highBp,
    perWeekBp: row.perWeekBp,
    nowBp: row.nowBp,
    basedOn: row.basedOn,
    basedOnWeeks: row.basedOnWeeks,
    confidence: row.confidence,
    note: row.note,
  };
}

export const ForecastSnapshotsRepository = {
  /**
   * Write one dated snapshot. A repeat of the same key is ignored.
   *
   * Refuses the four states it would not be able to read back: an empty subject, an
   * unstamped model version, a negative horizon, and an `issuedOn` that is not
   * `YYYY-MM-DD`. A constraint violation from the database is a worse way to learn
   * any of them than a named error, and the date one is worse still — every
   * date-bounded read in this repository is a *string* comparison, so a timestamp
   * in this column would make `asOfFor` quietly wrong rather than loudly broken.
   */
  async insertSnapshot(input: ForecastSnapshotRow): Promise<void> {
    if (input.subject.trim().length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "ForecastSnapshotsRepository refuses to store a snapshot with no subject: " +
          "a row nobody can name is a row nobody can read back",
      );
    }
    if (input.modelVersion.trim().length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "ForecastSnapshotsRepository refuses to store a snapshot with no model version: " +
          "an unstamped row is unreadable once the estimator changes",
      );
    }
    if (input.horizonDays < 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "ForecastSnapshotsRepository refuses a negative horizon: " +
          "a forecast that speaks over less than no days is not a forecast",
      );
    }
    if (!isIsoDay(input.issuedOn)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `ForecastSnapshotsRepository refuses the issue date "${input.issuedOn}": ` +
          "every date-bounded read compares this column as a string, so a date in " +
          "any other shape would make those reads quietly wrong instead of loudly broken",
      );
    }

    await db
      .insert(geoForecastSnapshots)
      .values({
        projectId: input.projectId,
        kind: input.kind,
        subject: input.subject,
        modelVersion: input.modelVersion,
        issuedOn: input.issuedOn,
        horizonDays: input.horizonDays,
        shareBp: input.shareBp,
        lowBp: input.lowBp,
        highBp: input.highBp,
        perWeekBp: input.perWeekBp,
        nowBp: input.nowBp,
        basedOn: input.basedOn,
        basedOnWeeks: input.basedOnWeeks,
        confidence: input.confidence,
        note: input.note,
      })
      .onConflictDoNothing();
  },

  /**
   * The newest snapshot for one (project, kind, subject), or null.
   *
   * Ordered by `issued_on` descending and **not** by `id`: two snapshots can be
   * written on the same day by two code paths, and the date is the claim while the
   * id is an accident of insertion order. A reader that trusted `id` would show
   * whichever row happened to be inserted last as "today's forecast".
   */
  async latestFor(input: {
    projectId: string;
    kind: ForecastKind;
    subject: string;
  }): Promise<ForecastSnapshotRecord | null> {
    const rows = await db
      .select()
      .from(geoForecastSnapshots)
      .where(
        and(
          eq(geoForecastSnapshots.projectId, input.projectId),
          eq(geoForecastSnapshots.kind, input.kind),
          eq(geoForecastSnapshots.subject, input.subject),
        ),
      )
      .orderBy(desc(geoForecastSnapshots.issuedOn))
      .limit(1);

    return rows[0] === undefined ? null : toRecord(rows[0]);
  },

  /**
   * One subject's snapshots, oldest first.
   *
   * `limit` bounds the read rather than defaulting to the whole archive: the sweep
   * writes one row per subject per night, and a chart that read every row ever
   * written would grow without bound on the one query a page load makes.
   */
  async historyFor(input: {
    projectId: string;
    kind: ForecastKind;
    subject: string;
    limit?: number;
  }): Promise<ForecastSnapshotRecord[]> {
    const bounded = Math.max(1, Math.floor(input.limit ?? 60));

    const rows = await db
      .select()
      .from(geoForecastSnapshots)
      .where(
        and(
          eq(geoForecastSnapshots.projectId, input.projectId),
          eq(geoForecastSnapshots.kind, input.kind),
          eq(geoForecastSnapshots.subject, input.subject),
        ),
      )
      .orderBy(geoForecastSnapshots.issuedOn)
      .limit(bounded);

    return rows.map(toRecord);
  },

  /**
   * Every subject with a snapshot of this kind for the project, with its newest row.
   *
   * Read as one query over the newest-per-subject rows rather than a loop per
   * subject: the caller is a page that renders one panel per platform, and it does
   * not know the platform list.
   *
   * **Sorted on a copy, not on the map's values.** The repo bans `Array#sort()` on
   * the grounds that it mutates, and `toSorted` is not available to this build — the
   * lib is ES2022, so `no-array-sort` is enforced by discipline rather than by a
   * newer method. The copy makes the sort honest either way.
   */
  async latestBySubject(input: {
    projectId: string;
    kind: ForecastKind;
    limit?: number;
  }): Promise<ForecastSnapshotRecord[]> {
    const bounded = Math.max(1, Math.floor(input.limit ?? 50));

    const rows = await db
      .select()
      .from(geoForecastSnapshots)
      .where(
        and(
          eq(geoForecastSnapshots.projectId, input.projectId),
          eq(geoForecastSnapshots.kind, input.kind),
        ),
      )
      .orderBy(desc(geoForecastSnapshots.issuedOn))
      .limit(bounded);

    // Newest-per-subject in the reader, not in SQL: a `DISTINCT ON` is Postgres-only
    // and a window function is unavailable on SQLite, so the pair that works on both
    // dialects is "read the newest rows, keep the first per subject". The bound above
    // is what makes that safe rather than a full scan — a project with more subjects
    // than rows read gets its newest ones, which is the half a panel shows anyway.
    const bySubject = new Map<string, ForecastSnapshotRecord>();
    for (const row of rows.map(toRecord)) {
      if (!bySubject.has(row.subject)) bySubject.set(row.subject, row);
    }

    const ordered = [...bySubject.values()];
    ordered.sort((a, b) => a.subject.localeCompare(b.subject));
    return ordered;
  },

  /**
   * The snapshot that was standing on a given day, for one subject.
   *
   * **On or before, not after.** An accuracy check asks what was predicted when the
   * window started, so the query stops at the day being scored. Multiple rows can
   * qualify inside a horizon — a weekly projection standing for ninety days is
   * restated every night — so the newest qualifying row is the one returned, and it
   * is the most recent statement of the same claim rather than a different one.
   *
   * The comparison is `lte` on a **text** column, which is only correct because
   * `insertSnapshot` refuses any `issuedOn` that is not `YYYY-MM-DD`: ISO dates sort
   * lexicographically exactly when they sort chronologically, and a writer that
   * ever stored a timestamp there would silently break this bound. The guard is at
   * the write rather than here because a read cannot repair what a write allowed.
   */
  async asOfFor(input: {
    projectId: string;
    kind: ForecastKind;
    subject: string;
    /** `YYYY-MM-DD`, inclusive. */
    onOrBefore: string;
  }): Promise<ForecastSnapshotRecord | null> {
    const rows = await db
      .select()
      .from(geoForecastSnapshots)
      .where(
        and(
          eq(geoForecastSnapshots.projectId, input.projectId),
          eq(geoForecastSnapshots.kind, input.kind),
          eq(geoForecastSnapshots.subject, input.subject),
          lte(geoForecastSnapshots.issuedOn, input.onOrBefore),
        ),
      )
      .orderBy(desc(geoForecastSnapshots.issuedOn))
      .limit(1);

    return rows[0] === undefined ? null : toRecord(rows[0]);
  },

  /**
   * Snapshot counts per day, newest first — the sweep's own log.
   *
   * Reported rather than computed from the sweep's return value because a count the
   * sweep reports is a count of what it *tried*; this is a count of what the table
   * actually holds. The two differ after a partial failure, and that difference is
   * the thing worth seeing.
   */
  async countSince(input: {
    projectId: string;
    since: string;
  }): Promise<number> {
    const rows = await db
      .select()
      .from(geoForecastSnapshots)
      .where(
        and(
          eq(geoForecastSnapshots.projectId, input.projectId),
          gte(geoForecastSnapshots.issuedOn, input.since),
        ),
      );

    return rows.length;
  },
};
