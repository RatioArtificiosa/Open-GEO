import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { runRaw } from "@/db/runBatch";
import { monitorRuns } from "@/db/schema";

/**
 * Reading and writing `monitor_runs`.
 *
 * ## A failed insert IS the "already running" signal
 *
 * There is no exception to catch. The partial unique index rejects the second
 * INSERT, and `onConflictDoNothing().returning()` turns that into an **empty
 * result set** — so `tryBeginRun` returns `false` rather than throwing. This is
 * the pattern CL-150 established from `tryCreateRun`, and it is the whole reason
 * an application-level lock was not used instead: every duplicate trigger — the
 * cron, a manual button, a retry, a second region — is a **separate Worker
 * isolate** by the time it matters, and a lock held in one isolate's memory
 * protects nothing from the next.
 *
 * ## The conflict target is explicit, and that is a fix not a style choice
 *
 * An **un-targeted** `ON CONFLICT DO NOTHING` also swallows a **primary-key**
 * collision. `tryCreateRun` in the rank-tracking repository has exactly that
 * shape, with a comment on `insertSnapshots` in the same file explaining why it
 * is wrong. This module targets the partial index by name, so a genuine key
 * collision surfaces as an error rather than as a run that silently never
 * started.
 */

/** Statuses that hold the single-in-flight slot. Mirrors the index exactly. */
const ACTIVE_STATUSES = ["pending", "running"] as const;

/**
 * A claim older than this is dead, not slow: the holder isolate is gone.
 *
 * 12 hours against a nightly cadence and minute-scale vendor calls (60s
 * timeout each). A legitimate run never approaches it; a run past it would
 * be stolen by the next nightly tick anyway, which then double-bills. The
 * horizon trades a bounded double-bill risk in the pathological case for
 * never silently stopping a monitor in the common one — and the theft is
 * recorded with its reason, so it reads as an incident, not a gap.
 */
const STALE_CLAIM_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Either dialect's timestamp as UTC millis, or null when it is not a date.
 *
 * SQLite `current_timestamp` is `YYYY-MM-DD HH:MM:SS` (space, UTC, no zone);
 * Postgres writes ISO with `T` and usually `Z`. Both are UTC by convention
 * here, so a zoneless value is read as UTC rather than local time — parsing
 * it as local would shift the horizon by the server's offset and steal live
 * claims (or shelter dead ones) depending on sign.
 */
function parseRunTimestamp(value: string): number | null {
  const dated = value.includes("T") ? value : value.replace(" ", "T");
  const zoned = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dated) ? dated : `${dated}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

type MonitorIdentity = {
  projectId: string;
  monitorType: string;
  /** Empty string for a whole-project monitor — not null, which means "unset". */
  monitorSubject?: string;
  /** Empty string for a monitor with no vendor platform. */
  platform?: string;
};

type BeginRunResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "already_running"; blockingRunId: string | null };

/**
 * Try to claim the single-in-flight slot for a monitor.
 *
 * Returns `ok: false` rather than throwing when another run holds the slot —
 * that is a normal outcome (two triggers fired), not an error.
 *
 * Both types are module-private: the result is read by narrowing `ok`, and a
 * consumer never needs to name either. `ci:check` runs knip, which is right to
 * object to an export nothing imports.
 */
export async function tryBeginRun(
  identity: MonitorIdentity & {
    id: string;
    plannedItems?: number | null;
    budgetUsd?: number | null;
  },
): Promise<BeginRunResult> {
  const monitorSubject = identity.monitorSubject ?? "";
  const platform = identity.platform ?? "";

  // The conflict clause is raw SQL, and it has to be. See `runRaw` for the two
  // Drizzle shapes that look right in review and are not: a targeted conflict
  // with no predicate (SQLite rejects the *first* insert), and a targeted
  // conflict with `where` (Drizzle renders it after `DO NOTHING`, a syntax
  // error). SQLite's grammar puts the predicate inside the target:
  //
  //     ON CONFLICT (cols) WHERE predicate DO NOTHING
  //
  // Both failures were found by running against a real SQLite rather than by
  // reading — the source-scan gate over this file passed 7/7 through both. A text
  // gate can check that two files agree; it cannot know what the engine's
  // grammar requires. Hence the patrol suite running a real in-memory database.
  const inserted = await insertClaim(identity, monitorSubject, platform);
  const row = inserted[0];
  if (row !== undefined) return { ok: true, runId: row.id };

  // The insert was blocked. Read who holds the slot so the caller can name it —
  // "already running" with no run id is a message a user cannot act on.
  const blocker = await getActiveRun(identity);
  if (blocker !== null && isStaleClaim(blocker.startedAt, Date.now())) {
    // The holder isolate died without releasing (deploys, OOM, timeouts —
    // `finally` never runs on isolate death). A stale slot blocks its monitor
    // FOREVER, so the claim is stolen exactly once: mark failed with the
    // reason stated, then retry the insert. A retry conflict means a live
    // worker claimed between the read and the retry, which is the correct
    // loser for this race — fall through to the refusal below.
    await releaseRun(
      blocker.id,
      `stale claim (started ${blocker.startedAt}); stolen by a new tick`,
    );
    const retried = await insertClaim(identity, monitorSubject, platform);
    const winner = retried[0];
    if (winner !== undefined) return { ok: true, runId: winner.id };
  }

  return {
    ok: false,
    reason: "already_running",
    blockingRunId: blocker?.id ?? null,
  };
}

/**
 * A claim is stale when its holder is older than the horizon, or never:
 * an unreadable timestamp fails closed (refuse) rather than stealing on a
 * guess about whose row this is.
 */
function isStaleClaim(startedAt: string, nowMs: number): boolean {
  const startedMs = parseRunTimestamp(startedAt);
  if (startedMs === null) return false;
  return nowMs - startedMs > STALE_CLAIM_AFTER_MS;
}

async function insertClaim(
  identity: {
    id: string;
    projectId: string;
    monitorType: string;
    plannedItems?: number | null;
    budgetUsd?: number | null;
  },
  monitorSubject: string,
  platform: string,
): Promise<Array<{ id: string }>> {
  return runRaw<{ id: string }>(sql`
    INSERT INTO monitor_runs (
      id, project_id, monitor_type, monitor_subject, platform,
      status, planned_items, budget_usd, completed_at
    ) VALUES (
      ${identity.id}, ${identity.projectId}, ${identity.monitorType},
      ${monitorSubject}, ${platform},
      'pending', ${identity.plannedItems ?? null},
      ${identity.budgetUsd ?? null}, NULL
    )
    ON CONFLICT (project_id, monitor_type, monitor_subject, platform)
      WHERE status IN ('pending', 'running')
      DO NOTHING
    RETURNING id
  `);
}

/** The run currently holding a monitor's slot, if any. */
async function getActiveRun(identity: MonitorIdentity) {
  const rows = await db
    .select()
    .from(monitorRuns)
    .where(
      and(
        eq(monitorRuns.projectId, identity.projectId),
        eq(monitorRuns.monitorType, identity.monitorType),
        eq(monitorRuns.monitorSubject, identity.monitorSubject ?? ""),
        eq(monitorRuns.platform, identity.platform ?? ""),
        inArray(monitorRuns.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Release a run's slot, whatever happened to the work.
 *
 * Called from a `finally`, because a run that threw and never released its slot
 * leaves the monitor **permanently** unable to start: no error, no retry, just a
 * project that silently stopped being monitored. That is the same class of bug as
 * the cron inversion, one level down.
 *
 * The status guard matters as much as the `finally`: without it a late callback
 * could overwrite a real error message with a success, or a real cost with a
 * zero — and the run history is the evidence the next reconciliation reads.
 *
 * Marked `failed` rather than `completed` because from the slot's point of view
 * the two are the same event, and the caller has not reported a clean finish. The
 * reason string says so, so a reader is not misled into thinking the patrol
 * itself failed.
 */
export async function releaseRun(runId: string, reason: string): Promise<void> {
  await db
    .update(monitorRuns)
    .set({
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: reason,
    })
    .where(
      and(
        eq(monitorRuns.id, runId),
        inArray(monitorRuns.status, [...ACTIVE_STATUSES]),
      ),
    );
}
