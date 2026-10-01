import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { geoPendingTasks } from "@/db/schema";
// Imported from the schema module rather than the barrel because the barrel
// destructures table values only — a constant that is not a table would need its
// own entry there, and `schema.ts` is already at its size limit for a reason.
import { MAX_PENDING_AGE_MS } from "@/db/geo-pending-tasks.schema";

/**
 * Draining the Standard queue, and saying what is still in it.
 *
 * ## The problem this exists to solve
 *
 * CL-200 built the queued client. Posting is the easy half. The hard half is that
 * **a Standard task may take up to 72 hours**, so "run the patrol nightly" and
 * "have answers by morning" are incompatible claims. A drain that reports
 * whatever is ready is not a drain; it is a sampling of a queue that may not have
 * moved at all, and reporting its output as *this morning's answers* is a lie
 * with a timestamp on it.
 *
 * So the drain's contract has two halves, and the second matters more than the
 * first:
 *
 * 1. Collect what is ready.
 * 2. **Say plainly what is still outstanding, how old it is, and what the plan's
 *    coverage therefore is.**
 *
 * ## Why `expired` is a status and not a filter
 *
 * A task past the vendor's documented ceiling is not "still running" — the
 * vendor has already given up and refunded the advance. Leaving it `pending`
 * forever would make a capture plan permanently incomplete and unreadable: there
 * is no "later" after 72 hours. Marking it `expired` gives the row a terminal
 * state, and the report counts it as a **coverage gap the customer paid for**,
 * because they did: the $0.01 advance was taken and the work was not delivered.
 *
 * Refunded is not the same as free, and the report says both numbers.
 *
 * ## Idempotency, because the queue will hand us things twice
 *
 * A collection marks `collected` inside the same statement that reads the
 * result, and a second delivery finds nothing to do. That is what makes a
 * retried dispatch safe — which matters because `tasks_ready` **omits** any task
 * whose postback already succeeded, so postback and drain are both live and both
 * can see the same task.
 */

/** One task we are still waiting on. */
type Outstanding = {
  tag: string;
  se: string;
  prompt: string;
  postedAt: string;
  ageMs: number;
  /**
   * True once the task is past the vendor's ceiling. The caller should show it as
   * a failure rather than as progress.
   */
  expired: boolean;
};

/**
 * What a drain tick found, and what it means for coverage.
 *
 * Exported because it is the **return type of two exported functions**, so a
 * caller that stores or forwards the result has to be able to name it. Knip
 * reports it as an unused export only because nothing in *this repo* consumes
 * it yet — which is a fact about the call graph, not about whether the type
 * belongs on the interface.
 */
type DrainReport = {
  /** Tasks still waiting, newest last. */
  outstanding: Outstanding[];
  /** How many are past the vendor's documented ceiling. */
  expired: number;
  /**
   * The sentence a surface must show. Null only when nothing is outstanding, and
   * it is null there because "everything we asked for has arrived" is a fact
   * worth stating plainly rather than leaving to an empty panel.
   */
  coverage: string | null;
  /** What the outstanding work has cost us so far, in USD. */
  atRiskUsd: number;
  /** What the vendor refunded, for expired tasks. */
  refundedUsd: number;
};

/**
 * Mark every task past the vendor's ceiling as expired.
 *
 * Run before reading, so the report and the rows agree. The `status` guard means
 * a second run in the same tick is a no-op rather than an error.
 */
export async function reapExpiredTasks(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - MAX_PENDING_AGE_MS).toISOString();
  const result = await db
    .update(geoPendingTasks)
    .set({
      status: "expired",
      completedAt: now.toISOString(),
      // The vendor refunds the advance on expiry, so the settled cost is zero.
      // That is a *measurement*, not an absence — recording null here would
      // report an unpriced task when we know exactly what it cost.
      settledUsd: 0,
      errorMessage:
        "The vendor's documented ceiling for a queued task is 72 hours, after which it is marked failed and the advance refunded. This task was never collected.",
    })
    .where(
      and(
        eq(geoPendingTasks.status, "pending"),
        lt(geoPendingTasks.postedAt, cutoff),
      ),
    )
    .returning({ id: geoPendingTasks.id });
  return result.length;
}

/**
 * What is still outstanding, and what it means for coverage.
 *
 * Pure given its rows, so the reporting rules are testable without a database.
 * The "coverage" sentence is built here rather than in a component, because a
 * coverage claim is a *claim about the archive* and belongs next to the archive
 * query that could contradict it.
 */
export function buildDrainReport(
  pending: Array<{
    tag: string;
    se: string;
    prompt: string;
    postedAt: string;
    advanceUsd: number | null;
  }>,
  now: Date,
): DrainReport {
  const outstanding: Outstanding[] = pending.map((row) => {
    const posted = new Date(row.postedAt);
    // An unparseable timestamp means the age can never be evaluated, so the
    // honest reading is "older than any ceiling we could check" rather than
    // "brand new". Reporting it as fresh would keep a broken row invisible.
    const ageMs = Number.isNaN(posted.getTime())
      ? Number.POSITIVE_INFINITY
      : now.getTime() - posted.getTime();
    return {
      tag: row.tag,
      se: row.se,
      prompt: row.prompt,
      postedAt: row.postedAt,
      ageMs,
      expired: ageMs > MAX_PENDING_AGE_MS,
    };
  });

  const byTag = new Map(pending.map((r) => [r.tag, r]));
  let atRiskUsd = 0;
  let refundedUsd = 0;
  for (const row of outstanding) {
    const advance = byTag.get(row.tag)?.advanceUsd ?? 0;
    if (row.expired) refundedUsd += advance;
    else atRiskUsd += advance;
  }

  const expired = outstanding.filter((o) => o.expired).length;

  const coverage =
    outstanding.length === 0
      ? null
      : expired > 0
        ? `${expired} of ${outstanding.length} queued ${outstanding.length === 1 ? "task has" : "tasks have"} passed the vendor's 72-hour ceiling and will never arrive. The advance was refunded, but the ${outstanding.length === 1 ? "prompt is" : "prompts are"} not answered, so today's figures cover less than the capture plan asked for.`
        : `${outstanding.length} ${outstanding.length === 1 ? "task is" : "tasks are"} still queued, the oldest for ${describeAge(outstanding)}. DataForSEO documents up to 72 hours for a queued task, so today's figures are not yet the full capture plan.`;

  return { outstanding, expired, coverage, atRiskUsd, refundedUsd };
}

/** A rough, human age. Not a countdown — the vendor gives no ETA. */
function describeAge(rows: Outstanding[]): string {
  let oldest = 0;
  for (const row of rows) {
    if (row.ageMs > oldest) oldest = row.ageMs;
  }
  if (!Number.isFinite(oldest)) return "an unknown amount of time";
  const hours = Math.floor(oldest / (60 * 60 * 1000));
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

/**
 * The outstanding queue for a project, paired with the reaper's expiry count.
 *
 * One function rather than two, because the report and the count are read
 * together every time and a caller that could fetch one without the other would
 * eventually render "0 outstanding" next to an unread expiry count — reading as
 * *"we are merely waiting"* when the truth is *"some of this will never
 * arrive"*. Those are different sentences and only the second is true.
 *
 * The reaper runs first so the rows and the report agree; a caller that skipped
 * it would report a task as still waiting on the same tick that declared it
 * expired.
 */
export async function readQueueState(
  projectId: string,
  now: Date = new Date(),
): Promise<{ report: DrainReport; expired: number }> {
  const reaped = await reapExpiredTasks(now);

  const pending = await db
    .select({
      tag: geoPendingTasks.tag,
      se: geoPendingTasks.se,
      prompt: geoPendingTasks.prompt,
      postedAt: geoPendingTasks.postedAt,
      advanceUsd: geoPendingTasks.advanceUsd,
    })
    .from(geoPendingTasks)
    .where(
      and(
        eq(geoPendingTasks.projectId, projectId),
        eq(geoPendingTasks.status, "pending"),
      ),
    );

  // The reaper's return value is what *this call* expired. A project's total
  // expiry count is a different question and a different query; reporting the
  // delta as the total would reset to zero on every read and make a run look
  // clean on the second read of the same day.
  return { report: buildDrainReport(pending, now), expired: reaped };
}

/**
 * When the queue was last *worked on*, from the queue's own rows.
 *
 * ## Why this exists
 *
 * `isDrainDue` is documented as a 24-hour gate, and `runQueueDrain` accepts a
 * `lastLookedAt` for it — but **nothing in production ever passed one**, so
 * `isDrainDue` was always handed `null` and always returned `true`. The gate was
 * a rule that could never fire, which is the same shape as a feature that is built,
 * tested and mounted nowhere: `queueDrainSchedule.test.ts` passes five cases
 * against the pure function while the real caller bypassed it entirely.
 *
 * It mattered only lightly while the drain *discarded* what it collected — a
 * wasted look was a few vendor calls against an empty queue. It matters now that
 * the drain **archives**, because the cron runs every five minutes: 288 passes a
 * day, each re-reading the queue and re-reporting "collected 0" in the log.
 *
 * ## Why the answer comes from the rows rather than a new column
 *
 * A persisted `last_looked_at` would need a migration on both dialects, and it
 * would need to be written by the drain — meaning a crash between "looked" and
 * "recorded the look" silently skips a whole day of collection. Reading it from
 * the queue's own rows is **self-describing and self-healing**:
 *
 * - A queue with nothing in it has never been looked at and is always due, which
 *   is exactly right — the moment something is posted, the next tick collects it.
 * - A queue with settled work says when it was last touched.
 *
 * The trade-off is that a queue whose tasks all *expired* reports its last look as
 * whenever they were posted, so it stays due for a while and reaps nothing. That is
 * cheap and harmless; the alternative — a column that can silently skip a day — is
 * not.
 */
export async function readLastLookedAt(): Promise<string | null> {
  const [row] = await db
    .select({ completedAt: geoPendingTasks.completedAt })
    .from(geoPendingTasks)
    .where(isNotNull(geoPendingTasks.completedAt))
    .orderBy(desc(geoPendingTasks.completedAt))
    .limit(1);
  return row?.completedAt ?? null;
}

/**
 * Settle a collected task.
 *
 * `status` guarded on `pending`, so a second delivery of the same task — which
 * `tasks_ready` makes possible whenever a postback also succeeded — updates
 * nothing rather than overwriting a settled cost with a second reading of it.
 */
export async function settleCollectedTask(input: {
  vendorTaskId: string;
  settledUsd: number | null;
  snapshotId?: string | null;
  completedAt: string;
}): Promise<boolean> {
  const result = await db
    .update(geoPendingTasks)
    .set({
      status: "collected",
      settledUsd: input.settledUsd,
      completedAt: input.completedAt,
      snapshotId: input.snapshotId ?? null,
    })
    .where(
      and(
        eq(geoPendingTasks.vendorTaskId, input.vendorTaskId),
        eq(geoPendingTasks.status, "pending"),
      ),
    )
    .returning({ id: geoPendingTasks.id });
  return result.length > 0;
}

/** Mark a task the vendor reported as failed, keeping its reason verbatim. */
export async function settleFailedTask(input: {
  vendorTaskId: string;
  reason: string;
  completedAt: string;
}): Promise<boolean> {
  const result = await db
    .update(geoPendingTasks)
    .set({
      status: "failed",
      completedAt: input.completedAt,
      // A failed task's advance is refunded by the vendor, so the settled cost
      // is zero — a measurement, recorded rather than left null.
      settledUsd: 0,
      errorMessage: input.reason,
    })
    .where(
      and(
        eq(geoPendingTasks.vendorTaskId, input.vendorTaskId),
        eq(geoPendingTasks.status, "pending"),
      ),
    )
    .returning({ id: geoPendingTasks.id });
  return result.length > 0;
}

/**
 * Tasks ready for collection, **fairly spread across the projects that have
 * some.**
 *
 * ## The starvation this shape used to allow, and the reaper that made it a bug
 *
 * This used to be one global oldest-first `limit`. That is a fairness problem, but
 * the *harm* was not the slowness — it was in `reapExpiredTasks`. A task past the
 * vendor's 72-hour ceiling is marked `expired` with a **zero** cost, because the
 * advance is refunded. So a small project's answer — paid for, produced by the
 * vendor, sitting ready — was destroyed by a large project's backlog, and nothing
 * anywhere reported it.
 *
 * Measured on this repository's own shape, before the fix: one project with 95
 * tasks and nine with one each, a cap of 100 — and **four of the ten projects got
 * no answer at all.** `queueDrainFairness.test.ts` holds that number.
 *
 * ## Why raising the limit was not the fix
 *
 * Each extra row costs one billed `task_get`, so a larger cap makes the bill larger
 * rather than the wait shorter, and the starved projects are still starved — later.
 * The fix had to change *who* gets the slots, not how many there are.
 *
 * ## And why this was not premature
 *
 * The comment this replaces said the limitation was recorded rather than fixed
 * *because the queued path was dormant*, and that fixing it should wait for the
 * first customer. That was the wrong call, and it was wrong for a reason worth
 * keeping: **"nobody is using it yet" is the reason a defect is safe to leave in,
 * not a reason it is not a defect.** The moment the path was switched on — which
 * is what the previous change did — the limitation became a live defect with a
 * customer's paid-for answers in it, and the correct order would have been to fix
 * it in the same change that made it reachable.
 */
export async function listCollectableTasks(limit = 100): Promise<
  Array<{
    vendorTaskId: string;
    tag: string;
    se: string;
    modelName: string;
    prompt: string;
    projectId: string;
    postedAt: string;
  }>
> {
  /**
   * One query, row-numbered per project.
   *
   * `ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY posted_at)` gives every
   * row its position *within its own project*, so ordering the result by that
   * position walks the projects round by round. `LIMIT` then takes the first
   * `limit` of that sequence, which is fair by construction: a project with one
   * task appears in the first round whatever else is queued, and a project with
   * the whole table to itself fills the cap rather than being held to a quota.
   *
   * ## Why the round-based version this replaced was wrong in two ways
   *
   * The first version looped in JavaScript, reading a window of rows per round and
   * allotting each project `perProject`. It failed twice, and **both failures are
   * the fairness bug wearing a different hat**:
   *
   * 1. **It capped throughput.** A project could take at most `perProject` rows
   *    *in total*, so a single project with a hundred queued tasks drained at a
   *    tenth of the rate the global limit used to allow — pushing its tasks toward
   *    the 72-hour reaper, which is the harm the change was made to prevent. A
   *    fairness rule must not slow the common case down to help the rare one.
   * 2. **Starvation survived.** The window was ordered by `project_id`, so a
   *    project with more than `window` rows filled every window and no other
   *    project appeared at all — `expected [ 'p0' ] to include 'p1'`.
   *
   * It also cost up to ten queries per call. The window function makes the whole
   * rule one statement, and the fairness becomes a property of the `ORDER BY`
   * rather than of arithmetic spread across a loop.
   */
  const rows = await db
    .select({
      vendorTaskId: geoPendingTasks.vendorTaskId,
      tag: geoPendingTasks.tag,
      se: geoPendingTasks.se,
      modelName: geoPendingTasks.modelName,
      prompt: geoPendingTasks.prompt,
      projectId: geoPendingTasks.projectId,
      postedAt: geoPendingTasks.postedAt,
      // The position within its own project. Selected rather than only ordered by,
      // because the ordering has to *be* `rn` and the query has to be read to
      // check it — an expression buried in `orderBy` is invisible at the call site.
      round:
        sql<number>`ROW_NUMBER() OVER (PARTITION BY ${geoPendingTasks.projectId} ORDER BY ${geoPendingTasks.postedAt} ASC)`.as(
          "round",
        ),
    })
    .from(geoPendingTasks)
    .where(eq(geoPendingTasks.status, "pending"))
    // Round first, then oldest within it. The secondary key matters: two projects'
    // first rounds interleave oldest-first, so the log reads in time order rather
    // than grouping by project.
    .orderBy(sql`round`, geoPendingTasks.postedAt)
    .limit(limit);

  // `round` is an ordering key rather than a field of a queued task, so it is
  // dropped rather than carried into the drain's own types.
  return rows.map(({ round: _round, ...task }) => task);
}

/**
 * How many of a project's captures came back, for a coverage fraction.
 *
 * Denominator is *everything ever posted*, not what is still outstanding. A
 * fraction whose denominator quietly shrinks as tasks expire reads as improving
 * coverage while the archive gets worse.
 */
export async function coverageFraction(projectId: string): Promise<{
  collected: number;
  total: number;
  fraction: number | null;
}> {
  const rows = await db
    .select({
      status: geoPendingTasks.status,
      count: sql<number>`count(*)`,
    })
    .from(geoPendingTasks)
    .where(eq(geoPendingTasks.projectId, projectId))
    .groupBy(geoPendingTasks.status);

  let collected = 0;
  let total = 0;
  for (const row of rows) {
    total += row.count;
    if (row.status === "collected") collected += row.count;
  }
  // A project that has never posted has no coverage to report, and 0/0 is not
  // zero coverage — it is an absence of measurement.
  return { collected, total, fraction: total === 0 ? null : collected / total };
}
