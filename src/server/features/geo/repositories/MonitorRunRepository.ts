import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
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

export type MonitorIdentity = {
  projectId: string;
  monitorType: string;
  /** Empty string for a whole-project monitor — not null, which means "unset". */
  monitorSubject?: string;
  /** Empty string for a monitor with no vendor platform. */
  platform?: string;
};

export type BeginRunResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "already_running"; blockingRunId: string | null };

/**
 * Try to claim the single-in-flight slot for a monitor.
 *
 * Returns `ok: false` rather than throwing when another run holds the slot —
 * that is a normal outcome (two triggers fired), not an error.
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

  // Targeted, never un-targeted: see the module docblock.
  const inserted = await db
    .insert(monitorRuns)
    .values({
      id: identity.id,
      projectId: identity.projectId,
      monitorType: identity.monitorType,
      monitorSubject,
      platform,
      status: "pending",
      plannedItems: identity.plannedItems ?? null,
      budgetUsd: identity.budgetUsd ?? null,
    })
    .onConflictDoNothing({
      target: [
        monitorRuns.projectId,
        monitorRuns.monitorType,
        monitorRuns.monitorSubject,
        monitorRuns.platform,
      ],
    })
    .returning({ id: monitorRuns.id });

  const row = inserted[0];
  if (row !== undefined) return { ok: true, runId: row.id };

  // The insert was blocked. Read who holds the slot so the caller can name it —
  // "already running" with no run id is a message a user cannot act on.
  const blocker = await getActiveRun(identity);
  return {
    ok: false,
    reason: "already_running",
    blockingRunId: blocker?.id ?? null,
  };
}

/** The run currently holding a monitor's slot, if any. */
export async function getActiveRun(identity: MonitorIdentity) {
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
 * A run that started and never finished, with the age that makes it stale.
 *
 * The age is returned rather than judged here, because "how long is too long"
 * depends on the monitor: a Lighthouse audit legitimately runs for minutes, a
 * patrol for a second. A shared constant would be wrong for one of them, and
 * quietly terminating a long legitimate run is worse than tolerating a stale row
 * for a tick.
 */
export async function getStaleRun(input: {
  identity: MonitorIdentity;
  ageMs: number;
  now?: Date;
}): Promise<{ id: string; reason: string } | null> {
  const run = await getActiveRun(input.identity);
  if (run === null) return null;
  const now = input.now ?? new Date();
  const startedAt = new Date(run.startedAt).getTime();
  // A startedAt we cannot parse is itself a reason to reap: an unparseable
  // timestamp means the slot can never be evaluated as fresh, so leaving it
  // locked forever is the one outcome with no recovery.
  if (Number.isNaN(startedAt)) {
    return {
      id: run.id,
      reason: "run start time is unreadable, so it can never be judged current",
    };
  }
  const age = now.getTime() - startedAt;
  if (age <= input.ageMs) return null;
  return {
    id: run.id,
    reason: `no progress for ${Math.round(age / 1000)}s`,
  };
}

/** Flip a run to `running`. No-op when it is not in `pending`. */
export async function markRunStarted(runId: string): Promise<void> {
  await db
    .update(monitorRuns)
    .set({ status: "running" })
    .where(and(eq(monitorRuns.id, runId), eq(monitorRuns.status, "pending")));
}

/**
 * Finish a run, which is what frees the slot.
 *
 * The status guard matters: a run that already completed must not be
 * re-completed by a late callback, or a second writer could overwrite a real
 * error message with a success one and a real cost with a zero.
 */
export async function finishRun(
  runId: string,
  outcome: {
    status: "completed" | "failed";
    completedItems?: number | null;
    costUsdMicros?: number | null;
    chargedUsdMicros?: number | null;
    errorMessage?: string | null;
  },
): Promise<boolean> {
  const result = await db
    .update(monitorRuns)
    .set({
      status: outcome.status,
      completedAt: new Date().toISOString(),
      completedItems: outcome.completedItems ?? null,
      costUsdMicros: outcome.costUsdMicros ?? null,
      chargedUsdMicros: outcome.chargedUsdMicros ?? null,
      errorMessage: outcome.errorMessage ?? null,
    })
    .where(
      and(
        eq(monitorRuns.id, runId),
        inArray(monitorRuns.status, [...ACTIVE_STATUSES]),
      ),
    )
    .returning({ id: monitorRuns.id });
  return result.length > 0;
}

/** Force a run to `failed`, freeing the slot. Used by the stale-run reaper. */
export async function failRunIfActive(
  runId: string,
  reason: string,
): Promise<boolean> {
  return finishRun(runId, { status: "failed", errorMessage: reason });
}

/** A project's runs, newest first. The evidence drawer's read. */
export async function listRunsForProject(
  projectId: string,
  limit = 50,
): Promise<Array<typeof monitorRuns.$inferSelect>> {
  return db
    .select()
    .from(monitorRuns)
    .where(eq(monitorRuns.projectId, projectId))
    .orderBy(desc(monitorRuns.startedAt))
    .limit(limit);
}
