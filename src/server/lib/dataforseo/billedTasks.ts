/**
 * Idempotency for billed, non-idempotent vendor calls.
 *
 * ## The bug this module exists to prevent
 *
 * `business.ts` documents the rule — *"task_post creates a billed task. A 5xx
 * does not prove the provider skipped the charge"* — and passes
 * `NO_RETRY` on all three of its `task_post` calls. `serp.ts` posts **billed**
 * tasks too, and did not. So `postRankCheckTasks` inherited the shared default of
 * **two retries on any 5xx**, meaning:
 *
 * 1. We post 100 queued rank checks. DataForSEO accepts and bills them.
 * 2. The response is a 502 on the way back.
 * 3. We retry, and DataForSEO bills **another 100 tasks**.
 * 4. The customer is charged twice for work done once, and the duplicate tasks
 *    sit in their queue burning their own budget.
 *
 * Nothing crashes, nothing logs an error, and the customer sees a bill roughly
 * double what it should be. It is the same shape as CL-137 — a wrong assumption
 * that costs money and reports nothing.
 *
 * ## The fix has two halves, and the second is the honest one
 *
 * The first is mechanical: mark every billed post `NO_RETRY`. Done in `serp.ts`.
 *
 * The second is that **`NO_RETRY` is not a safety property, it is a
 * convention**, and a convention one call site forgets is one billed call too
 * many. So the marking is derived from a single declaration of which endpoints
 * create a billed task, and a test asserts every `task_post` in the SDK directory
 * is covered by it. The next person adding a post gets a failing test rather than
 * a doubled bill.
 */

/**
 * Endpoint paths that create a **billed, non-idempotent** task.
 *
 * A POST here is charged at the moment it is accepted, and replaying it creates a
 * *second* charge. Matching is on the `task_post` segment rather than the whole
 * path, so an endpoint gaining sub-paths later stays covered.
 *
 * The terminator class includes **quotes** as well as `/` and end-of-input,
 * because a path in real source is a string literal — `"/v3/serp/google/organic/
 * task_post"` — and the first version of this pattern only accepted `/` or the
 * end of the string, so it did not match a single actual call site. The detection
 * test caught that immediately, which is exactly the test that exists here.
 *
 * A **backtick** is in that class for the same reason and was missing for the
 * same length of time: a client that builds its path with a template literal —
 * `` `${base(se)}/task_post` `` — has no `"` or `'` after the segment, so the
 * pattern did not match and the gate reported no offender for a genuinely billed
 * post. Both misses are the same lesson: a terminator class derived from one
 * example of real source is a terminator class missing every other spelling.
 *
 * `task_get` is deliberately absent: collection is free, and the existing
 * comments in `serp.ts` and `business.ts` are right that routing it through the
 * metering seam would charge twice for a task already paid for.
 */
const BILLED_POST_PATTERNS: RegExp[] = [/\/task_post(?=[/"'`\s,;)]|$)/];

/**
 * Does this text contain a call that creates a billed task?
 *
 * Accepts the path *or* a chunk of source around it, because the gate scans
 * source lines: the path arrives embedded in a string literal, often with a
 * leading quote. Matching on a bare `/task_post` boundary rather than a quoted
 * full path is what lets the same predicate serve both a caller holding
 * `"/v3/serp/google/organic/task_post"` and the gate holding a window of source.
 */
export function createsBilledTask(text: string): boolean {
  for (const pattern of BILLED_POST_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Retry options for a call that creates a billed task.
 *
 * Zero server-error retries, and a comment saying why, because the default is
 * two and the default is wrong here. The `signal` is threaded through so a
 * caller's own abort still applies — this removes *our* replay, not theirs.
 */
export const NO_RETRY_BILLED_POST = { maxServerErrorRetries: 0 } as const;
