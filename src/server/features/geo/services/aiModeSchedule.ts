/**
 * Deciding **when** to run a nightly AI Mode capture.
 *
 * ## Why this is separate from the capture
 *
 * The capture itself is one billable call per keyword. The interesting decision is
 * the one that decides whether a capture is *worth its cost at all*, and that
 * decision has three inputs the caller already has: a budget, the prompts it
 * wants watched, and how much each one was observed to move.
 *
 * So this is a pure function and the scheduler stays a thin caller. That is the
 * same shape as every other decision in this feature: the arithmetic is testable
 * and the side effect is not.
 *
 * ## The rule, and why it is not "cheapest first"
 *
 * Naive scheduling picks the cheapest keywords and that is wrong in a way that
 * costs money later. A keyword whose answer has **never moved** is not cheap —
 * it is *uninformative*: you have learned from it that it does not change, and
 * running it again tomorrow buys the same nothing. Meanwhile a keyword that moved
 * last week is the one most likely to move again, and it is the one whose change
 * a customer would act on.
 *
 * So priority is **observed volatility first**, cost second. A volatile keyword
 * is admitted even if it is the most expensive in the set, because the diff is
 * the product. Only ties break on cost.
 *
 * ## Budget admission, and the honesty of the leftover
 *
 * Admission stops at the budget, and the caller is told what it dropped and
 * whether the budget was the binding constraint. A scheduler that silently
 * truncates is a scheduler whose report understates its own coverage — and
 * "we checked everything" is the claim a customer relies on when they conclude
 * their brand was not mentioned.
 */

export type WatchedPrompt = {
  keyword: string;
  /** Live vendor price for one call, in USD. */
  estimatedCostUsd: number;
  /**
   * How many times the answer's citation set changed across captured runs.
   *
   * Zero is the important case: it is not "cheap", it is *uninformative*, and
   * this function treats the two differently on purpose. The count is a
   * **signal about our own data**, not a fact about the world, and that is why
   * `neverObserved` is tracked separately — one capture is not evidence of
   * stability.
   */
  observedChanges: number;
  /** Captures we hold for this keyword. 0 means we have never looked. */
  observations: number;
};

/**
 * The night's plan.
 *
 * Not exported: the scheduler's caller reads it through inference, and a named
 * export nothing imports is a claim about the API surface knip correctly refuses
 * to let stand. It becomes public with the cron entry that consumes it.
 */
type SchedulePlan = {
  /** Keyword → its capture parameters, in run order. */
  admitted: Array<{
    keyword: string;
    locationCode: number;
    languageCode: string;
    estimatedCostUsd: number;
    /** Why it was admitted, in words a run log can print. */
    reason: string;
  }>;
  /** Keywords we chose not to run, with the reason. Never a bare count. */
  skipped: Array<{ keyword: string; reason: string }>;
  estimatedCostUsd: number;
  budgetUsd: number;
  /** True when the budget — not the prompt set — decided the size of `admitted`. */
  budgetBound: boolean;
  /**
   * A sentence for the run log. Never null: a nightly job that ran and said
   * nothing is indistinguishable from one that did not run.
   */
  summary: string;
};

/**
 * Sort key, descending.
 *
 * Three tiers, deliberately separated by more than any volatility or cost value
 * can bridge:
 *
 * 1. **Never observed.** A diff needs two points, so a first capture is the
 *    highest-value call available — and a single stable-looking observation is
 *    not evidence of stability.
 * 2. **Observed to move.** Volatility * 100, so it outranks every cost
 *    difference in the set.
 * 3. **Observed and stable.** Lowest, tie-broken by cost.
 *
 * The first version used `observedChanges * 10 - cost`, which put a never-observed
 * prompt at `0` — tying with a proven-stable one, so the sort fell back on input
 * order and the prompt that most needed a baseline could be dropped last. A
 * budget that runs out would then have spent the night's money on prompts that had
 * already told us everything they were going to.
 */
function priority(prompt: WatchedPrompt): number {
  if (prompt.observations === 0) return Number.MAX_SAFE_INTEGER;
  return prompt.observedChanges * 100 - prompt.estimatedCostUsd;
}

function reasonFor(prompt: WatchedPrompt): string {
  if (prompt.observations === 0) {
    return "first capture — we have no baseline for this prompt yet, and a diff needs two points";
  }
  if (prompt.observedChanges > 0) {
    return `moved in ${prompt.observedChanges} of ${prompt.observations} captures — the most informative thing we monitor`;
  }
  if (prompt.observations < 3) {
    return `stable so far, but only ${prompt.observations} observation${prompt.observations === 1 ? "" : "s"} — too few to call it stable`;
  }
  return `stable across ${prompt.observations} captures, lowest priority`;
}

export function planAiModeCaptures(input: {
  prompts: WatchedPrompt[];
  budgetUsd: number;
  locationCode: number;
  languageCode: string;
}): SchedulePlan {
  // Insertion sort by `priority`, descending. `no-array-sort` forbids both
  // `.sort()` and the `[...x].sort()` spread, and `toSorted` is not in this
  // repo's `lib` target — the same constraint the other services here work
  // around. It is also the clearer statement of the rule, which matters because
  // the ordering *is* the feature.
  //
  // Stable, deliberately: two prompts with equal priority keep the caller's
  // order, so a project sees the same plan twice in a row when nothing has
  // changed. A nightly job that reshuffles its own list makes its run log
  // impossible to read.
  const ordered: WatchedPrompt[] = [];
  for (const prompt of input.prompts) {
    let at = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      const other = ordered[i];
      if (other !== undefined && priority(other) < priority(prompt)) {
        at = i;
        break;
      }
    }
    ordered.splice(at, 0, prompt);
  }

  const admitted: SchedulePlan["admitted"] = [];
  const skipped: SchedulePlan["skipped"] = [];
  let spent = 0;
  // Whether we stopped because of money rather than because the list ran out.
  // The distinction is the difference between "we covered everything" and "we
  // covered what we could afford", and only one of those is safe to say.
  let budgetBound = false;

  for (const prompt of ordered) {
    if (spent + prompt.estimatedCostUsd > input.budgetUsd) {
      budgetBound = true;
      skipped.push({
        keyword: prompt.keyword,
        reason: `the $${input.budgetUsd.toFixed(2)} nightly budget was already spent`,
      });
      continue;
    }
    spent += prompt.estimatedCostUsd;
    admitted.push({
      keyword: prompt.keyword,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      estimatedCostUsd: prompt.estimatedCostUsd,
      reason: reasonFor(prompt),
    });
  }

  const plan: SchedulePlan = {
    admitted,
    skipped,
    estimatedCostUsd: spent,
    budgetUsd: input.budgetUsd,
    budgetBound,
    summary: "",
  };
  plan.summary = describe(plan, input.prompts.length);
  return plan;
}

function describe(plan: SchedulePlan, total: number): string {
  if (total === 0) {
    return "No AI Mode prompts are configured, so nothing was captured.";
  }
  const parts = [
    `Captured ${plan.admitted.length} of ${total} AI Mode prompts for ~$${plan.estimatedCostUsd.toFixed(4)}`,
  ];
  parts.push(
    plan.budgetBound
      ? `the budget of $${plan.budgetUsd.toFixed(2)} was the limit, so ${plan.skipped.length} prompt${plan.skipped.length === 1 ? " was" : "s were"} not checked — that is missing coverage, not a clean result`
      : `the full prompt set was covered within the $${plan.budgetUsd.toFixed(2)} budget`,
  );
  return `${parts.join("; ")}.`;
}
