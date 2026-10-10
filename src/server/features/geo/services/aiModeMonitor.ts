/**
 * Running one project's AI Mode capture.
 *
 * ## Why this is a separate runner rather than a mode on `GeoPatrol`
 *
 * AI Mode is a **billable SERP call with no task queue**: $0.004 per keyword, paid
 * whether or not there is work behind it, and the answer is a single document
 * rather than a prompt to be answered asynchronously. The queued path exists
 * precisely because that shape does not fit it, so putting this in the patrol would
 * make the patrol grow a second acquisition strategy rather than one acquisition
 * strategy.
 *
 * ## What it does NOT do
 *
 * It does not decide *which* keywords to capture. `planAiModeCaptures` does, and it
 * is a pure function precisely so that this file stays a thin caller of a decision
 * somebody can test without a database. The arithmetic is the feature; the side
 * effect is not.
 *
 * ## The two costs this has to respect
 *
 * 1. **The nightly budget.** Admission already happened; this spends it.
 * 2. **Not being billed twice.** Two monitors running in the same window would both
 *    fetch every keyword and the customer would pay for the pair. The idempotency
 *    check is therefore **before any vendor call**, which means the check costs a
 *    row read and getting it wrong costs a duplicate bill.
 */
import { GeoRunRepository } from "../repositories/GeoRunRepository";
import { runBatch } from "@/db/runBatch";
// Type-only: the runtime call now goes through the metered client, so this
// module names the fetcher solely for its input type.
import type { fetchAiModeAnswer } from "@/server/lib/dataforseo/ai-mode";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { planAiModeCaptures, type WatchedPrompt } from "./aiModeSchedule";
import { diffAnswers } from "./answerDiff";
import { randomUUID } from "node:crypto";

/**
 * One project's nightly outcome, as the caller and the run log see it.
 *
 * `changes` carries the shared `AnswerDiff` rather than an AI-Mode-specific shape.
 * **I had written a second diff module from scratch, three directories away from the
 * one that already existed**, with fewer features and no rank tracking. Reusing
 * `answerDiff` is the point: the AI Mode capture is one more source of answers, and
 * the diff that reads it is the product's moat precisely because it is *one*
 * implementation rather than one per acquisition path.
 */
export type AiModeNightResult = {
  projectId: string;
  /** False when a monitor for this project already ran in this window. */
  ran: boolean;
  /** Why it did not run, when it did not. */
  skippedReason: string | null;
  captured: number;
  /** Captures that could not be fetched, by keyword. */
  failed: Array<{ keyword: string; reason: string }>;
  /** The diff for each captured keyword that had a previous capture to compare. */
  changes: Array<{
    keyword: string;
    diff: ReturnType<typeof diffAnswers> | null;
  }>;
  estimatedCostUsd: number;
  /**
   * What the **vendor** reported the night cost, from each response's
   * `billing.costUsd` plus any billed failure.
   *
   * **Beside the estimate, never replacing it**, because the two answer different
   * questions: the estimate is what the *budget* was enforced against, and this is
   * what was *actually charged*. A single field would have to be one or the other,
   * and either choice loses something — the estimate is what bounded the run, and
   * this is what a customer will be invoiced.
   *
   * `estimatedCostUsd` was previously the only cost figure on this path, which made
   * it the only number anyone could compare against an invoice. The sibling keyword
   * capture hit the same omission.
   */
  actualCostUsd: number;
  summary: string;
};

/**
 * What a thrown error cost, when it says.
 *
 * `DataforseoChargedTaskError` is thrown for a task that failed **after** being
 * billed and carries its `billing`; anything else failed before a bill existed.
 *
 * **Zero for the unbilled case, and the distinction is the point.** A failure that
 * never reached the vendor cost nothing, so counting an estimate for it would
 * overstate the bill. A failure that *was* billed cost money whether or not we got
 * an answer — and omitting it would understate the bill in exactly the direction
 * that hides our own gap. Both are real failures; the honest figure for each is
 * different, and `0` is the honest figure for one of them.
 */
function billedCostOf(error: unknown): number {
  return error instanceof DataforseoChargedTaskError
    ? error.billing.costUsd
    : 0;
}

/**
 * The vendor call, injectable so a test can fail it without a network.
 *
 * Not exported: the only caller that substitutes it is a test inside this module's
 * own suite, and an exported alias nothing imports is a claim about the API that
 * is not true.
 */
type AiModeFetcher = typeof fetchAiModeAnswer;

/**
 * The metered vendor call for one project, or nothing when there is no context.
 *
 * **Returns undefined rather than falling back to the raw fetcher.** Without a
 * customer there is nobody to bill, and silently calling the vendor unmetered is
 * the exact failure this whole change removes — the platform account paying for a
 * nightly capture while the org balance is never read.
 *
 * The envelope sibling, so the monitor's `actualCostUsd` carries the vendor's
 * figure rather than `undefined`.
 */
function buildMeteredAnswer(
  customer: BillingCustomerContext | undefined,
): AiModeFetcher | undefined {
  if (!customer) return undefined;
  return (input: Parameters<typeof fetchAiModeAnswer>[0]) =>
    createDataforseoClient(customer).serp.aiModeEnvelope(input);
}

export async function runAiModeMonitor(input: {
  projectId: string;
  /** The keywords this project watches, with what we have observed about each. */
  prompts: WatchedPrompt[];
  budgetUsd: number;
  locationCode: number;
  languageCode: string;
  now?: Date;
  fetchAnswer?: AiModeFetcher;
  /**
   * The billing context, because this is where the vendor call happens.
   *
   * A cron has no user, so the context is assembled from real ids. Without it
   * the monitor's vendor calls ran unmetered: the platform account paid, no org
   * balance was read, and a zero-credit org kept receiving captures.
   */
  customer?: BillingCustomerContext;
  /**
   * Whether a monitor already ran in this window.
   *
   * Injected rather than read here, because reading it means a query and the query
   * means this function can no longer be tested without a database — and the part
   * worth testing is the ordering of the idempotency check against the vendor calls,
   * which is invisible either way.
   */
  alreadyRanInWindow?: () => Promise<boolean>;
  /** Records the run so the next window can see it. */
  recordRun?: (input: {
    projectId: string;
    runId: string;
    startedAt: string;
  }) => Promise<void>;
}): Promise<AiModeNightResult> {
  const now = input.now ?? new Date();
  /**
   * The injected stand-in, or the **metered** client.
   *
   * The default is the metered envelope sibling, not the raw fetcher — that is
   * the whole point. The seam stays so a test can drive the monitor without a
   * vendor or a billing context, and a double is a drop-in replacement.
   */
  const fetchAnswer = input.fetchAnswer ?? buildMeteredAnswer(input.customer);
  if (!fetchAnswer) {
    throw new AppError(
      "INTERNAL_ERROR",
      "AI Mode capture has no billing context: a vendor call without a customer to charge would be paid by the platform account",
    );
  }

  const alreadyRan = (await input.alreadyRanInWindow?.()) ?? false;
  if (alreadyRan) {
    return {
      projectId: input.projectId,
      ran: false,
      skippedReason:
        "an AI Mode monitor for this project already ran in this window, and a second one would bill the same calls twice",
      captured: 0,
      failed: [],
      changes: [],
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      summary:
        "No AI Mode capture tonight: this project was already captured in this window.",
    };
  }

  const plan = planAiModeCaptures({
    prompts: input.prompts,
    budgetUsd: input.budgetUsd,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  });

  const runId = randomUUID();
  let captured = 0;
  let spent = 0;
  /**
   * What the **vendor** says the night cost, beside the planner's `spent`.
   *
   * `AI_MODE_UNIT_COST_USD` is *verified* against a real vendor response, so this
   * is not about correcting a placeholder — it is about **detecting a price change**.
   * DataForSEO repriced endpoints before, and a verified constant that nobody
   * re-checks is a stale fact that looks current. Two numbers make the drift
   * visible on the first night it appears.
   *
   * The sibling keyword capture needed this more urgently — its unit cost is an
   * unverified placeholder — but the argument is identical, and having one path
   * report a measured cost and the other not would make the two incomparable.
   */
  let measuredSpent = 0;
  const failed: AiModeNightResult["failed"] = [];
  const changes: AiModeNightResult["changes"] = [];

  for (const admitted of plan.admitted) {
    /**
     * Read the previous captures **before** the fetch, not after.
     *
     * The diff compares this capture against what came before it, and writing first
     * would make every capture its own baseline — reporting "nothing changed"
     * forever, because the only thing it ever compared was itself.
     *
     * **Two, not fifty**: the diff compares the pair, so loading more is a larger
     * query for the same answer.
     */
    const previous = await GeoRunRepository.listAiModeSnapshots(
      input.projectId,
      admitted.keyword,
      2,
    );

    let answer;
    /**
     * What the **vendor** says this call cost.
     *
     * Held outside the `try` because a billed failure still cost money, and a
     * failure that cannot say what it cost is a failure nobody can reconcile. The
     * `catch` below reads it for exactly that reason.
     */
    let billedUsd = 0;
    try {
      const response = await fetchAnswer({
        keyword: admitted.keyword,
        locationCode: admitted.locationCode,
        languageCode: admitted.languageCode,
      });
      answer = response.data;
      billedUsd = response.billing.costUsd;
    } catch (error) {
      /**
       * A failed call is **recorded, not retried.**
       *
       * The vendor charges whether or not the call succeeded, so a retry here is a
       * second bill for the same question — and treating it as a capture would
       * claim a baseline that is not there.
       */
      // A *billed* failure carries its cost on the thrown error, and it is still
      // this night's spending. Counting only the successes would under-report the
      // bill in exactly the direction that hides our own gap.
      measuredSpent += billedCostOf(error);
      failed.push({
        keyword: admitted.keyword,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    measuredSpent += billedUsd;
    spent += admitted.estimatedCostUsd;

    /**
     * The references that will become citation rows, held before the insert so the
     * diff and the archive cannot disagree about what was cited. A reference with no
     * URL is evidence but not a citation, so it is not a row — and `diffAnswers` is
     * given the same list, or the diff would report a change the archive never
     * recorded.
     */
    const references = answer.references.filter(
      (reference): reference is typeof reference & { url: string } =>
        typeof reference.url === "string" && reference.url !== "",
    );

    await GeoRunRepository.insertAiModeSnapshot(
      {
        id: randomUUID(),
        projectId: input.projectId,
        keyword: admitted.keyword,
        // Stored because the market is part of what was asked: an answer for one
        // country is not an answer for another, and a diff across two markets is a
        // diff of two different questions.
        locationCode: admitted.locationCode,
        languageCode: admitted.languageCode,
        capturedAt: now.toISOString(),
        // Verbatim. The diff compares this string, so any transformation here is a
        // transformation of the measurement.
        answerMarkdown: markdownOf(answer.elements),
        checkUrl: answer.checkUrl,
        rawJson: null,
      },
      references.map((reference) => ({
        url: reference.url,
        domain: reference.domain ?? null,
        title: reference.title ?? null,
        snippet: reference.text ?? null,
      })),
    );
    captured += 1;

    /**
     * The diff against the previous capture, or `null` when there is none.
     *
     * `null` rather than an "unchanged" diff, and the distinction matters: one
     * capture is not a comparison. Reporting stability from a single capture would
     * be a claim about a measurement never made — and since this monitor's first
     * run captures every keyword, **every diff is `null` on the night a project is
     * switched on**, which is exactly when a reader is most likely to be looking.
     *
     * `diffAnswers` throws rather than sorts when given two answers in the wrong
     * order, which is the right behaviour: the repository returns newest-first, so
     * the pair has to be reversed here rather than inside the function.
     */
    const older = previous[1];
    const newer = previous[0];
    changes.push({
      keyword: admitted.keyword,
      diff:
        older === undefined || newer === undefined
          ? null
          : diffAnswers({
              prompt: admitted.keyword,
              before: {
                id: older.id,
                answeredAt: older.capturedAt,
                citations: [],
              },
              after: {
                id: newer.id,
                answeredAt: newer.capturedAt,
                citations: references.map((reference, index) => ({
                  url: reference.url,
                  rank: index + 1,
                })),
              },
            }),
    });
  }

  if (captured > 0 || failed.length > 0) {
    const record = input.recordRun ?? writeRunRecord;
    await record({
      projectId: input.projectId,
      runId,
      startedAt: now.toISOString(),
    });
  }

  return {
    projectId: input.projectId,
    ran: true,
    skippedReason: null,
    captured,
    failed,
    changes,
    estimatedCostUsd: spent,
    actualCostUsd: measuredSpent,
    summary: describe(captured, failed, changes, plan.budgetBound),
  };
}

/**
 * The answer as one markdown string.
 *
 * AI Mode returns several element types — prose, comparison tables, shopping — and
 * only some carry markdown. Joining the ones that do, in position order, keeps the
 * text verbatim where there is text at all, which is what the diff needs; an element
 * with no markdown contributes nothing rather than the string "undefined".
 */
function markdownOf(
  elements: ReadonlyArray<{ markdown?: string | null }>,
): string | null {
  const parts = elements
    .map((element) => element.markdown)
    .filter((part): part is string => typeof part === "string" && part !== "");
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Record the run so the next window can see it.
 *
 * A capture *is* a monitor run, so this writes into the GEO run log rather than a
 * new table — a second table would be a second source of truth for the single
 * question "did we bill this customer tonight", and two answers to one billing
 * question is how a customer gets charged twice.
 *
 * `insertSnapshot` takes `tx` and returns an **unawaited builder**, by the
 * repository's convention, so it is composed into a `runBatch` rather than awaited
 * directly. Awaiting the builder would escape the transaction, and `db.batch` is
 * never used here because the Postgres driver has none.
 *
 * **`promptsAsked: null`, not a count.** The planner admitted N keywords, but this
 * run is not a prompt set: the column is the denominator for a *mention rate*, and
 * an AI Mode capture measures one SERP per keyword rather than asking a brand
 * whether it was mentioned. Writing the admitted count here would make a later
 * reader compute a mention rate from a number that was never a denominator. `null`
 * is the state the column's own docstring names for a run that cannot say what it
 * asked.
 */
async function writeRunRecord(input: {
  projectId: string;
  runId: string;
  startedAt: string;
}): Promise<void> {
  await runBatch((tx) => [
    GeoRunRepository.insertSnapshot(tx, {
      id: input.runId,
      projectId: input.projectId,
      startedAt: input.startedAt,
      promptsAsked: null,
      createdBy: "schedule",
    }),
  ]);
}

/**
 * The sentence an operator reads.
 *
 * **A budget that ran out is stated, not hidden.** "We captured everything" and "we
 * captured what we could afford" are different claims, and only one of them is safe
 * for a customer to rely on when they conclude their brand was not mentioned.
 */
function describe(
  captured: number,
  failed: Array<{ keyword: string; reason: string }>,
  changes: AiModeNightResult["changes"],
  budgetBound: boolean,
): string {
  if (captured === 0 && failed.length === 0) {
    return "No AI Mode answers were captured tonight.";
  }
  const moved = changes.filter(
    (c) =>
      c.diff !== null &&
      (c.diff.changes.some((change) => change.kind === "gained") ||
        c.diff.changes.some((change) => change.kind === "lost")),
  );
  /**
   * How many captures had nothing to compare against.
   *
   * Counted rather than folded into "no changes", because a first night captures
   * every keyword and produces no diff at all — and an operator reading "0 changed"
   * on the night they switched a project on would conclude the brand is stable when
   * the truth is that we have one data point.
   */
  const noBaseline = changes.filter((c) => c.diff === null).length;
  const parts = [
    `Captured ${captured} AI Mode answer${captured === 1 ? "" : "s"}.`,
  ];
  if (moved.length > 0) {
    parts.push(
      `${moved.length} changed since the previous capture: ${moved.map((c) => c.keyword).join(", ")}.`,
    );
  }
  if (noBaseline > 0) {
    parts.push(
      `${noBaseline} had no earlier capture to compare against, so we cannot say whether they changed.`,
    );
  }
  if (failed.length > 0) {
    // Named, so the operator sees *which* question went unanswered rather than a
    // count that reads as a completeness claim.
    parts.push(
      `${failed.length} failed and were not retried, because the vendor charges for a failed call too: ${failed.map((f) => f.keyword).join(", ")}.`,
    );
  }
  if (budgetBound) {
    parts.push(
      "The nightly budget was the binding constraint, so some watched questions were not captured.",
    );
  }
  return parts.join(" ");
}
