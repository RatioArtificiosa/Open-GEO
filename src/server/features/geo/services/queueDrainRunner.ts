import {
  listCollectableTasks,
  reapExpiredTasks,
  settleCollectedTask,
  settleFailedTask,
} from "./queueDrain";
import { getLlmResponseTask } from "@/server/lib/dataforseo/llm-responses-queue";
import { buildArchivedAnswer } from "./answerCollector";
import { LLM_MODEL_SLUGS } from "@/server/lib/dataforseo/llm-models";
import {
  DRAIN_INTERVAL_MS,
  isDrainDue,
  skipReason,
} from "./queueDrainSchedule";

/**
 * Narrow the stored `se` to a model slug the client accepts.
 *
 * The column is free text because the model list is fetched from the vendor, so a
 * value can arrive that this build does not know. Passing it straight through
 * would build a path like `/v3/ai_optimization/gpt-9/llm_responses/task_get/...`
 * and 404 — so an unknown queue is **reported as unknown** rather than called.
 * That is a different outcome from a pending task, and conflating them would
 * mean a vendor adding a model quietly stops the drain.
 */
function toModelSlug(value: string): (typeof LLM_MODEL_SLUGS)[number] | null {
  const found = LLM_MODEL_SLUGS.find((slug) => slug === value);
  return found ?? null;
}

/**
 * One pass of the queue drain.
 *
 * ## Why this runs on its own cadence, and not with the patrol
 *
 * The patrol posts and returns. This collects. Those are **different clocks**,
 * and running them together would be the same class of error as CL-200c's
 * "cheaper and three days late":
 *
 * - The vendor documents **up to 72 hours** for a Standard task. A drain that
 *   runs only when a patrol posts therefore runs at most once a day, and most
 *   passes would find a queue that has not moved — a *sample* of a backlog,
 *   presented as though it were a collection.
 * - Nothing arrives on a schedule we control. The vendor decides when a task is
 *   ready, so the only way to collect promptly is to **look more often than we
 *   post**, which is the opposite of the patrol's arrangement.
 *
 * So this is dispatched on **every** tick and gated internally by
 * `isDrainDue`, which compares the queue's own age rather than the clock. That is
 * the honest shape: a tick that arrives 40 minutes after the last look does
 * nothing and says so, and a tick that arrives after the ceiling has elapsed
 * looks immediately.
 *
 * ## The order is reap, then collect, then report
 *
 * Reaping first means a task past the ceiling is never *reported* as still
 * waiting — which is the sentence CL-200b exists to prevent.
 */
type DrainResult = {
  /** True when the look happened, false when the gate said not to yet. */
  attempted: boolean;
  /** Why it was skipped, when it was. */
  skipped: string | null;
  attemptedTasks: number;
  collected: number;
  failed: number;
  /** Still outstanding after this pass. */
  outstanding: number;
  /** The sentence a run log should carry, or null when the queue is clear. */
  coverage: string | null;
};

export async function runQueueDrain(
  options: {
    now?: Date;
    lastLookedAt?: string | null;
    intervalMs?: number;
    /** Injected so the collector is testable without a vendor. */
    fetchTask?: typeof getLlmResponseTask;
    limit?: number;
  } = {},
): Promise<DrainResult> {
  const now = options.now ?? new Date();

  if (!isDrainDue(options.lastLookedAt ?? null, now, options.intervalMs)) {
    return {
      attempted: false,
      skipped: skipReason(options.intervalMs ?? DRAIN_INTERVAL_MS),
      attemptedTasks: 0,
      collected: 0,
      failed: 0,
      outstanding: 0,
      coverage: null,
    };
  }

  // Reap first, so a task past the ceiling is never *reported* as waiting.
  const reaped = await reapExpiredTasks(now);

  const fetchTask = options.fetchTask ?? getLlmResponseTask;
  const pending = await listCollectableTasks(options.limit ?? 100);

  let collected = 0;
  let failed = 0;

  for (const task of pending) {
    const slug = toModelSlug(task.se);
    if (slug === null) {
      // Settled as failed, with the reason, rather than skipped. A task we
      // cannot address is a task that will never be collected, and leaving it
      // pending would hold the queue open until it expired.
      await settleFailedTask({
        vendorTaskId: task.vendorTaskId,
        reason: `Unknown queue "${task.se}": this build does not know that model, so the task cannot be addressed.`,
        completedAt: now.toISOString(),
      });
      failed += 1;
      continue;
    }

    try {
      const result = await fetchTask(slug, task.vendorTaskId);

      const built = buildArchivedAnswer({
        task: result.data,
        // The tag we posted with, because a response that does not echo it is a
        // shape change and the pending row is the only other record of which
        // prompt this was.
        fallbackTag: task.tag,
        prompt: task.prompt,
        vendorTaskId: task.vendorTaskId,
      });

      if ("ok" in built) {
        // A refusal is **not** a failure to collect. `still_pending` in
        // particular is the normal state of a task on a queue that is still
        // moving, and recording it as failed would fill the log with warnings
        // that describe a working system.
        if (built.reason === "still_pending") continue;
        // The other refusals mean the task will never be attributable, so it is
        // settled as failed rather than retried forever.
        await settleFailedTask({
          vendorTaskId: task.vendorTaskId,
          reason: built.detail,
          completedAt: now.toISOString(),
        });
        failed += 1;
        continue;
      }

      const settled = await settleCollectedTask({
        vendorTaskId: task.vendorTaskId,
        settledUsd: null,
        completedAt: now.toISOString(),
      });
      if (settled) collected += 1;
    } catch (error) {
      // A vendor failure settles as failed, which the duplicate check ignores, so
      // the next look retries it. Settling as *collected* here would record a
      // delivery for an answer we do not have.
      await settleFailedTask({
        vendorTaskId: task.vendorTaskId,
        reason: error instanceof Error ? error.message : String(error),
        completedAt: now.toISOString(),
      });
      failed += 1;
    }
  }

  return {
    attempted: true,
    skipped: null,
    attemptedTasks: pending.length,
    collected,
    failed,
    outstanding: pending.length - collected - failed,
    coverage: buildCoverage(collected, failed, reaped),
  };
}

/**
 * The one sentence a run log carries.
 *
 * Counts a `reaped` number alongside the collections on purpose: an operator
 * looking at "collected 40, failed 0" needs to know that 3 of those 40 had
 * already passed the ceiling, and that this pass found the queue **after** the
 * reaping rather than before it.
 */
function buildCoverage(
  collected: number,
  failed: number,
  reaped: number,
): string | null {
  if (collected === 0 && failed === 0 && reaped === 0) {
    return "The queue was empty: nothing outstanding, nothing to reap.";
  }
  const parts: string[] = [];
  if (collected > 0) parts.push(`collected ${collected}`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (reaped > 0) {
    parts.push(
      `${reaped} had already passed the 72-hour ceiling and will never arrive`,
    );
  }
  return `${parts.join(", ")}.`;
}
