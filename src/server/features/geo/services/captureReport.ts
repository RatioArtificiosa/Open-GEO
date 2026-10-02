/**
 * The shape every nightly capture's report shares.
 *
 * ## Why this exists
 *
 * Four modules produce a nightly report — `aiModeMonitor`, and the three runners
 * that drive it — and until this file each declared its own. **The shared fields are
 * `projectsVisited`, `actualCostUsd` and `estimatedCostUsd`, and all four had them
 * by inspection rather than by construction.**
 *
 * That is not a tidiness point. Three things went wrong in one session precisely
 * because the shape was convention:
 *
 * - `aiModeMonitor` reported `actualCostUsd`; the runner above it summed only the
 *   estimate and **discarded it on the way out** — a value nobody reads, one call
 *   stack away, introduced by the fix for a related defect.
 * - Its sibling log lines printed the cost differently, and one printed a money
 *   figure with no currency symbol — a defect that exists only *between* three
 *   blocks, so it was invisible to any check and to reading them one at a time.
 * - The runner had no test while the module it wraps had eleven, so the aggregation
 *   that produces the printed number was the least-checked part of the chain.
 *
 * A shared type means a fourth capture **cannot** omit the measured figure, and the
 * compiler says so rather than a reviewer having to remember.
 *
 * ## What is deliberately NOT here
 *
 * `droppedForBudget` and `failures` are **not** in the base, because they are not
 * universal: `aiModeMonitor` measures one project and has no budget to drop work
 * from, so requiring both would mean writing `droppedForBudget: 0` forever — a zero
 * that is a measurement rather than a measurement that is zero. Each runner extends
 * the base with what it actually has, and the log line names whatever is present.
 *
 * That distinction is the same absence-versus-zero rule the rest of this feature
 * applies, applied to a type: **do not add a field because every caller would have to
 * write a lie into it.**
 *
 * And for the same reason there is **no shared failure type**: the three runners name
 * their subject differently (`projectId`, `domain`), so a generic would be a weaker
 * type than what each already has.
 */
/** What every nightly capture reports, whatever it measures. */
export type CaptureCostReport = {
  /**
   * Projects this run actually visited — **not** how many exist, and not how many
   * were configured.
   *
   * The distinction is not pedantic: a report that counted the unvisited would say
   * "40 projects visited" on a tick that asked three, and an operator reading the log
   * could not reconcile it with the spend on the next line.
   */
  projectsVisited: number;
  /**
   * What the **vendor** says the run cost, summed from each response's
   * `billing.costUsd`.
   *
   * **And `estimatedCostUsd` is the estimate beside it, never a replacement for
   * it.** The two answer different questions: the estimate is what the budget was
   * enforced against, and this is what will appear on an invoice. A single field
   * would have to be one or the other, and either choice loses something.
   *
   * Their *difference* is the point: a drift between them means the price book is
   * stale, and it is visible on the first night rather than on a bill.
   */
  actualCostUsd: number;
  /** What the planner expected to spend, for comparison against the measured figure. */
  estimatedCostUsd: number;
};

/**
 * A report for a capture that can run out of budget.
 *
 * **The dropped-work fields are here and not on the base**, and the reason is in the
 * file's header: a capture with no budget cannot honestly report one.
 */
export type BudgetedCaptureReport = CaptureCostReport & {
  /**
   * Work skipped because the budget was spent.
   *
   * **Never a bare count in a log line.** "We captured everything" and "we captured
   * what we could afford" are different claims, and only one is safe to repeat from
   * a log — so the caller names it and the omission is visible.
   */
  droppedForBudget: number;
};
