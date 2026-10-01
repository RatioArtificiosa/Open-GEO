import {
  listCollectableTasks,
  readLastLookedAt,
  reapExpiredTasks,
  settleCollectedTask,
  settleFailedTask,
} from "./queueDrain";
import { getLlmResponseTask } from "@/server/lib/dataforseo/llm-responses-queue";
import { buildArchivedAnswer, type ArchivedAnswer } from "./answerCollector";
import { LLM_MODEL_SLUGS } from "@/server/lib/dataforseo/llm-models";
import {
  DRAIN_INTERVAL_MS,
  isDrainDue,
  skipReason,
} from "./queueDrainSchedule";
import { GeoService } from "./GeoService";
import { GeoSetupRepository } from "../repositories/GeoSetupRepository";
import { alertOnRunChange, ALERT_TRANSPORT } from "./alertRunner";

/**
 * Archive one collected answer and report the run it landed in.
 *
 * ## One snapshot per answer, and what that means for alerting
 *
 * Each answer gets its own snapshot with `prompts_asked: 1`. That is the honest
 * unit — one measurement, one sample — and it is what makes the forecast computable
 * here at all.
 *
 * **It also means two answers to the same prompt are two runs, not one run with
 * two samples.** A queued run asks, say, five prompts; those five answers arrive
 * over up to 72 hours and are archived as five snapshots of one prompt each. So
 * the alerting diff between two of them is a genuine *change in one prompt's
 * answer*, not a shift in a share — and `decideAlerts` reads it that way, because
 * it matches on `platform|prompt` and the prompt is identical.
 *
 * That is the right reading, and it is worth stating because the alternative
 * would be badly wrong: had the five answers been grouped into one snapshot with
 * `prompts_asked: 5`, a single prompt changing would have moved a five-sample rate
 * and produced a *share* figure implying four unchanging samples that were never
 * measured together.
 *
 * The cost is that a queued project's alerting is per-prompt rather than
 * per-run. A reader watching the channel sees "acme.com lost mention of 'best crm'",
 * which names the prompt — accurate, and more specific than a rate would be.
 */
async function archiveAnswer(
  answer: ArchivedAnswer,
  projectId: string,
  now: Date,
): Promise<string | null> {
  const target = await GeoSetupRepository.getTarget(projectId, answer.targetId);
  if (!target) return null;

  // **Claude cannot be archived.**
  //
  // `LLM_MODEL_SLUGS` includes `claude` and the patrol will post a Claude task,
  // but `geo_answers.platform` is a closed set of four that does **not** contain
  // it — the archive was shaped around the `llm_mentions` platforms. So a Claude
  // answer has no column it can honestly occupy.
  //
  // The alternatives were all worse: filing it under `chat_gpt` would put a
  // different model's answer in a platform's history, and every rate computed from
  // that history would then be about two models at once. Dropping it silently is
  // what this function was written to stop. So it is refused with the reason,
  // which is the same shape as `buildArchivedAnswer`'s other refusals — the task
  // is settled as failed and says why.
  //
  // The real fix is adding `claude` to `GEO_PLATFORMS` on both dialects and to
  // every read that filters on it. That is a product decision about whether
  // Claude answers belong in this product's history at all, so it is recorded
  // rather than made here.
  if (!isArchivablePlatform(answer.platform)) return null;
  // Narrowed by the guard above. Passed explicitly so `toInsert` cannot be handed
  // a platform the column does not have.
  const platform: ArchivablePlatform = answer.platform;

  const snapshot = await GeoService.recordRun({
    projectId,
    targetId: answer.targetId,
    createdBy: "schedule",
    answers: [
      toInsert(
        answer,
        {
          projectId,
          // Location and language come from the target, not from the vendor payload.
          //
          // The queued collector has no market of its own — it was told which
          // prompt to ask, not which market to ask in — so the answer inherits the
          // target's measurement context. A hardcoded `0`/`"en"` would also be a
          // lie: every other read filters by location and language, so a row filed
          // under `0`/`"en"` would be invisible to all of them.
          locationCode: target.locationCode,
          languageCode: target.languageCode,
          platform,
        },
        now,
      ),
    ],
    promptsAsked: 1,
  });
  return snapshot?.id ?? null;
}

/**
 * A collected answer's platform, once known to fit the archive's column.
 *
 * Derived rather than declared so it cannot drift from the schema: if the column
 * gains a platform this widens with it, and if it loses one the compiler reports
 * here rather than at a runtime enum rejection.
 */
type ArchivablePlatform = Exclude<ArchivedAnswer["platform"], "claude">;

/**
 * Whether `geo_answers` can store an answer for this platform.
 *
 * The two sets differ deliberately, and the difference *is* the finding: the queue
 * posts for four platforms and the archive holds three of them.
 *
 * A **type predicate** rather than a plain boolean, because the narrowing has to
 * reach the caller. `Exclude<..., "claude">` is a subtype of
 * `ArchivedAnswer["platform"]`, so a predicate is the one form that can legally
 * narrow it — the first version returned `boolean`, and the assignment of
 * `answer.platform` to `ArchivablePlatform` downstream failed exactly as it should.
 *
 * The test is an exclusion and not a membership list because the archive's set is
 * **not** a subset of the collector's: `google_ai_overview` is archivable but never
 * queued. Listing members would duplicate the schema's four values here, and the
 * day one is added this would silently start refusing valid answers.
 */
function isArchivablePlatform(
  platform: ArchivedAnswer["platform"],
): platform is ArchivablePlatform {
  return platform !== "claude";
}

/** Map a collected answer onto the archive's insert shape. */
function toInsert(
  answer: ArchivedAnswer,
  context: {
    projectId: string;
    locationCode: number;
    languageCode: string;
    /**
     * The platform, already known to be archivable.
     *
     * Passed separately rather than read off `answer` so the guarantee made by
     * {@link isArchivablePlatform} travels with the value: the compiler then
     * refuses this function if it is ever called with a `claude` answer, instead
     * of the write failing at runtime on an enum the column does not have.
     */
    platform: ArchivablePlatform;
  },
  now: Date,
): Parameters<typeof GeoService.recordRun>[0]["answers"][number] {
  return {
    answer: {
      id: answer.answerId,
      projectId: context.projectId,
      targetId: answer.targetId,
      promptSetId: null,
      prompt: answer.prompt,
      // Kept verbatim. The schema's rule is "do not transform", and it exists
      // because a diff between two runs needs the exact text.
      answerText: answer.answerText,
      platform: context.platform,
      modelName: answer.modelName,
      source: "llm_responses" as const,
      locationCode: context.locationCode,
      languageCode: context.languageCode,
      answeredAt: now.toISOString(),
      vendorTaskId: answer.vendorTaskId,
      rawJson: answer.rawJson,
    },
    citations: answer.citations,
  };
}

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

  /**
   * The cadence gate, and the answer it reads.
   *
   * `lastLookedAt` is honoured when a caller supplies it, because that is how the
   * tests pin it. **Production supplies nothing**, so it is read from the queue's
   * own rows instead — and before this, the gate was handed `null` on every tick,
   * which makes `isDrainDue` return `true` unconditionally. A documented 24-hour
   * cadence that could never fire, while the cron ran every five minutes: 288
   * passes a day, each re-reading the queue.
   *
   * It was cheap while the drain discarded its collections and is not cheap now
   * that it archives, so the gate is wired rather than merely documented.
   */
  const lastLookedAt =
    options.lastLookedAt !== undefined
      ? options.lastLookedAt
      : await readLastLookedAt();

  if (!isDrainDue(lastLookedAt ?? null, now, options.intervalMs)) {
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
  /** Every snapshot this pass wrote, with the project it belongs to. */
  const archived = new Map<string, string>();

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

      // **Archive first, then settle the task.**
      //
      // The order is the point. Settling first marked the task `collected` and
      // then nothing was written — so a crash between the two lost the answer
      // permanently, and the task could never be collected again. Writing the
      // archive row *before* the settle means a crash in between leaves the task
      // pending, and the next pass collects it again; the archive is keyed on the
      // answer id, so the duplicate is a no-op rather than a second row.
      const snapshotId = await archiveAnswer(built, task.projectId, now);
      if (snapshotId === null) {
        // Collectable, attributable, and **still not archivable** — either the
        // target was deleted in the 72 hours since posting, or the platform has no
        // column in the archive. Settling it as failed with the reason is the
        // honest outcome: the answer is real and paid for, and pretending it was
        // collected is exactly the defect this pass was rewritten to remove.
        await settleFailedTask({
          vendorTaskId: task.vendorTaskId,
          reason: isArchivablePlatform(built.platform)
            ? `Collected an answer for ${built.targetId}, but that target no longer exists, so the answer cannot be attributed to a brand and was not archived.`
            : `Collected a ${built.platform} answer, which the archive cannot store: geo_answers.platform has no ${built.platform} value. The answer was not archived.`,
          completedAt: now.toISOString(),
        });
        failed += 1;
        continue;
      }

      const settled = await settleCollectedTask({
        vendorTaskId: task.vendorTaskId,
        settledUsd: null,
        // The run the answer landed in, so "which run produced this?" is
        // answerable for the queued path rather than a permanent null.
        snapshotId,
        completedAt: now.toISOString(),
      });
      if (settled) {
        collected += 1;
        archived.set(snapshotId, task.projectId);
      }
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

  /**
   * Alert on what this pass archived.
   *
   * `scheduledGeoPatrol` is the **only** production caller of `alertOnRunChange`,
   * and it runs *before* this drain on the same tick — so a queued answer was
   * archived here and never alerted on by anything, ever. It is structurally
   * impossible for the patrol to cover it: the patrol's own snapshot has no
   * answers, because a queued run posts prompts and returns.
   *
   * So this is the only place that can. It is best-effort for the same reason
   * the patrol's own call is: a webhook outage must not fail the collection, and a
   * failed alert leaves the next tick's diff to find the change anyway.
   */
  for (const [snapshotId, projectId] of archived) {
    // Iterating the map rather than a list plus a lookup, so a snapshot can never
    // be alerted on with an unknown project. `?? ""` would look the snapshot up
    // with an empty project, find nothing, and report `not_applicable` — a
    // missing alert that reads as "nothing changed".
    await alertOnRunChange({
      projectId,
      snapshotId,
      transport: ALERT_TRANSPORT,
    }).catch((alertError: unknown) => {
      console.error(
        `[geo-queue] alerting failed and was swallowed so the drain could finish: ${
          alertError instanceof Error ? alertError.message : String(alertError)
        }`,
      );
    });
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
 *
 * ## `collected` now means *archived*
 *
 * That word was the defect. It used to count a task the drain had fetched and
 * validated, while nothing was written anywhere — so the sentence an operator
 * read as success was reporting work that had been thrown away. It is now
 * incremented only after `archiveAnswer` has returned a snapshot id, so
 * "collected 40" means forty rows are in `geo_answers` and can be looked at.
 *
 * It is the sentence an operator trusts when deciding whether the queue is
 * draining, so it is the sentence that has to be true.
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
