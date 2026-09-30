/**
 * What a patrol costs, and when to stop.
 *
 * ## Why an answer cap is not a spend cap
 *
 * `GeoPatrol` bounds a run with `DEFAULT_MAX_ANSWERS = 500`. That is a bound on
 * *volume*, and the two are not interchangeable: a prompt set of 500 expensive
 * keywords and a prompt set of 500 cheap ones cost an order of magnitude apart.
 * A volume cap therefore permits a bill nobody agreed to, and the customer finds
 * out on an invoice.
 *
 * So this is a **money** cap, and it is checked the same way rank checking does
 * it: estimate first, refuse above the ceiling, and never let a run proceed
 * silently over.
 *
 * ## The estimation mirrors the metering, deliberately
 *
 * `meterDataforseoCall` charges per **call**, and each call is ceilinged to whole
 * credits. So a sum-then-round of the total *understates* the charge — the same
 * reason `estimateRankCheckCredits` loops per call. Reusing that reasoning here
 * rather than multiplying out a single number is the difference between an
 * estimate and a promise.
 *
 * ## Two costs, because they are different money
 *
 * - **Nominal** — what the planned calls should cost.
 * - **Actual** — what the vendor billed, which is what reconciles a dispute.
 *
 * The gap between them is normal: a task that times out or is rejected can be
 * re-run at the live rate, roughly 3× queued. A cap is set against the nominal
 * figure and reconciled against the actual one, and the summary says when they
 * disagree — a cap that silently absorbed an overrun is not a cap.
 */

type CostDecision =
  /** Within budget; proceed. */
  | { allowed: true; estimatedUsd: number; notes: string[] }
  /**
   * Over budget. `reason` is a sentence a customer can act on, and it never
   * offers a number we cannot fund.
   */
  | { allowed: false; estimatedUsd: number; reason: string };

type CostInput = {
  /** Planned answer fetches. */
  answers: number;
  /**
   * The cap in USD. Null means **no cap was set**, which is reported as a note
   * rather than treated as unlimited — a run with no ceiling is worth saying out
   * loud even when it is the normal case for a small plan.
   */
  budgetUsd: number | null;
  /** Published vendor price per fetched answer, in USD. */
  unitCostUsd: number;
  /**
   * How many fetches share one metered call. One today; a future batched endpoint
   * would raise it, and the per-call ceiling has to follow.
   */
  answersPerCall?: number;
};

const NOTES = {
  noBudget:
    "No spend cap was set for this run, so it is bounded by its answer limit only.",
  batching:
    "Answers are batched several to a call; the estimate accounts for the per-call credit ceiling.",
} as const;

/**
 * Decide whether a planned run fits its budget.
 *
 * Refuses rather than truncating, on purpose. A cap that silently drops half the
 * work produces a report covering fewer prompts than the customer asked about,
 * and the gap is invisible — the archive just looks thinner. Refusing means the
 * customer chooses between raising the cap and narrowing the prompt set.
 */
export function decidePatrolSpend(input: CostInput): CostDecision {
  const answers = Math.max(0, input.answers);
  const perCall = Math.max(1, input.answersPerCall ?? 1);
  const notes: string[] = [];

  if (input.budgetUsd === null) notes.push(NOTES.noBudget);
  if (perCall > 1) notes.push(NOTES.batching);

  // Per-call, not per-total: each metered call is independently rounded up to
  // whole credits, so one total rounded once is always an undercount.
  let estimatedUsd = 0;
  for (let offset = 0; offset < answers; offset += perCall) {
    const inCall = Math.min(perCall, answers - offset);
    estimatedUsd += inCall * input.unitCostUsd;
  }
  estimatedUsd = roundUsd(estimatedUsd);

  if (input.budgetUsd === null) {
    return { allowed: true, estimatedUsd, notes };
  }

  if (estimatedUsd > input.budgetUsd) {
    return {
      allowed: false,
      estimatedUsd,
      reason:
        `This run would cost about $${estimatedUsd.toFixed(4)}, over the $${input.budgetUsd.toFixed(2)} cap. ` +
        `Nothing was run. Raise the cap or narrow the prompt set — the answer limit alone is not a spend limit, because a longer prompt is not a cheaper one.`,
    };
  }

  return { allowed: true, estimatedUsd, notes };
}

/**
 * Reconcile the estimate against what the vendor actually billed.
 *
 * Reported rather than enforced, and the wording is deliberate: the cap governs
 * what we *start*, and the actual figure governs what we *settle*. A run that
 * overran did so because the vendor charged more than planned, which is the
 * vendor's number and not a decision we made — so the message says the overrun
 * happened and does not pretend the cap held.
 */
export function reconcilePatrolSpend(input: {
  estimatedUsd: number;
  actualUsd: number;
  budgetUsd: number | null;
}): { overran: boolean; note: string | null } {
  const overran = input.budgetUsd !== null && input.actualUsd > input.budgetUsd;
  if (!overran) {
    const drifted = Math.abs(input.actualUsd - input.estimatedUsd) > 0.0005;
    if (drifted) {
      return {
        overran: false,
        note: `Actual spend ($${input.actualUsd.toFixed(4)}) differs from the estimate ($${input.estimatedUsd.toFixed(4)}). Both are recorded; neither replaces the other.`,
      };
    }
    return { overran: false, note: null };
  }
  return {
    overran: true,
    note:
      `This run billed $${input.actualUsd.toFixed(4)}, over the $${input.budgetUsd?.toFixed(2)} cap and above the ` +
      `$${input.estimatedUsd.toFixed(4)} estimate. The cap bounds what we start; a vendor price change or a ` +
      `live fallback moves what we settle. We are recording the difference rather than absorbing it quietly.`,
  };
}

/** Six decimals — the vendor reports costs at that precision. */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
