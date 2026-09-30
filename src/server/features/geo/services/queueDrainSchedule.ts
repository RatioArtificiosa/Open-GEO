/**
 * When to look at the queue.
 *
 * ## Why this is its own module
 *
 * Two reasons, and the second is the one that matters.
 *
 * 1. The cadence is a **number in a schedule**, and a wrong one produces no
 *    error at all. The drain runs, finds a queue the vendor has not moved, and
 *    reports nothing. There is no stack trace and no red build — just an
 *    archive that quietly stops filling.
 * 2. It has **no business importing a database.** The function that decides
 *    "should I look?" needs a clock and nothing else, and the first version had
 *    it beside the drain, which meant the cadence test could not load the module
 *    without standing up a Worker environment. A rule that cannot be tested
 *    without infrastructure is a rule that will not be tested.
 *
 * So the rule is here, pure, and the drain asks it.
 */

/**
 * How long to wait between looks, in milliseconds.
 *
 * Twenty-four hours, and that is **a third of the vendor's documented 72-hour
 * ceiling** — not a tidiness choice. A cadence coarser than a third of the
 * ceiling means an unlucky task gets exactly one look and then times out, which
 * is the failure the ceiling exists to make visible. A cadence far finer spends
 * looks on a queue the vendor has not moved.
 */
export const DRAIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The vendor's documented worst case for a Standard task. */
export const VENDOR_CEILING_MS = 72 * 60 * 60 * 1000;

/**
 * Is it time to look again?
 *
 * `null` means "we have never looked", and that is the definition of due.
 *
 * An unreadable timestamp is treated as **due**, not as "not due". A clock we
 * cannot read must never be the reason we stop collecting: the alternative is a
 * silent permanent stall, which is the exact failure this whole chain exists to
 * prevent.
 */
export function isDrainDue(
  lastLookedAt: string | null,
  now: Date,
  intervalMs = DRAIN_INTERVAL_MS,
): boolean {
  if (lastLookedAt === null) return true;
  const last = new Date(lastLookedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalMs;
}

/** The sentence a skipped tick carries, so a skip is never silent. */
export function skipReason(intervalMs = DRAIN_INTERVAL_MS): string {
  const hours = Math.round(intervalMs / 3_600_000);
  return (
    `Less than ${hours}h since the last look. The vendor decides when a queued ` +
    `task is ready, so a look this soon would find the same queue.`
  );
}
