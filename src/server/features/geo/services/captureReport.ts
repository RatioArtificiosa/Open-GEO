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

  /**
   * Work skipped because the project had no organization to bill.
   *
   * A scheduled capture has no user, so its billing context is assembled from
   * real ids. A project whose org is missing **cannot** be charged, and guessing
   * an `organizationId` would let the usage-credit check pass against a customer
   * that does not exist — the guard failing in the direction it exists to prevent.
   *
   * Counted on the shared report rather than per capture, because all three
   * nightly captures face the same skip and a field one of them invents is a field
   * the other two drift from.
   */
  skippedNoOrganization?: number;
};

/**
 * Format the cost pair every nightly log line prints.
 *
 * ## Why this is a function and not three template literals
 *
 * The three cron log lines were written at three different times, and one of them
 * printed a vendor cost **with no currency symbol** where its two siblings printed one.
 * Nothing failed, nothing was wrong in isolation — the defect only existed *between*
 * the lines, so only reading them side by side could find it.
 *
 * That is the same argument as the shared type above, applied to the string that prints
 * it: a fourth capture should inherit the format rather than reproduce it, and the `$`
 * should be impossible to forget rather than merely noticed.
 *
 * **The estimate is always shown.** A single number would have to be either the measured
 * figure or the estimate, and either choice loses the comparison that makes drift visible.
 */
export function formatCaptureCost(report: CaptureCostReport): string {
  return `vendor $${report.actualCostUsd.toFixed(4)} (est. $${report.estimatedCostUsd.toFixed(4)})`;
}

/**
 * The tail a budgeted capture appends when it dropped work.
 *
 * **Separate, because the omission is the point.** "We captured everything" and "we
 * captured what we could afford" are different claims, and only one is safe to repeat from
 * a log — so a caller that drops work says so, and a caller that drops none prints nothing
 * rather than a `0` that reads as a measurement.
 */
export function formatDropped(droppedForBudget: number): string {
  return droppedForBudget > 0 ? `, ${droppedForBudget} dropped for budget` : "";
}
