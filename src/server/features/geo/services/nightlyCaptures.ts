/**
 * The three nightly captures that bill the vendor, in one place.
 *
 * ## Why this module exists
 *
 * `src/server.ts` used to run these inline, on **every** tick. The fix was to
 * gate them on the nightly cron, but the gate has to hold for all three
 * *forever*, and the only version of that a reader can check is one where the
 * three of them are visibly one unit. Leaving them inline in the cron handler
 * makes the fourth capture — the one someone adds next year, when the
 * opportunity-inputs service stops being dead code — a fresh chance to forget
 * the gate, and the failure is silent and metered.
 *
 * So the gate lives in `server.ts` as one `if`, and this module holds the
 * dispatch, the ordering and the logging for the three it applies to. Adding a
 * billable capture means adding it here, next to the comment that says why.
 *
 * ## The ordering is load-bearing
 *
 * Cheap work first, billable work last, and each capture in its own `try`:
 * a DataForSEO outage in one must not stop the other two, and none of them may
 * stop the free work that fills the archive on the same tick. That is the same
 * fault-isolation rule the cron handler applies to the patrol and the drain.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not decide *whether* the night has already run. That is the cron
 * gate's job now, and it was the bug: the runners each carried a `lastAskedAt`
 * rotation, which reorders who gets measured and never decides whether to
 * measure at all. **A budget that is checked per tick bounds a tick, not a
 * night.** See the comment above the call site in `src/server.ts`.
 */

import { runDueAiModeCaptures } from "@/server/features/geo/services/scheduledAiModeCapture";
import { runDueAiKeywordCaptures } from "@/server/features/geo/services/scheduledAiKeywordCapture";
import { runDueEtvCaptures } from "@/server/features/domain/services/scheduledEtvCapture";
import { runDueOpportunityInputCaptures } from "@/server/features/domain/services/scheduledOpportunityInputs";
import {
  formatCaptureCost,
  formatDropped,
} from "@/server/features/geo/services/captureReport";

/**
 * Run the three billable nightly captures, in order, each isolated.
 *
 * Never throws: a vendor outage in one capture is a log line, not a failed
 * invocation, because the alternative is that one dead endpoint stops the other
 * two from collecting and the archive silently stops filling.
 */
export async function runNightlyBillableCaptures(): Promise<void> {
  // AI Mode first of the three because it is the most shape-dependent: the
  // handler reads the watch list, so a project with no prompts costs nothing to
  // discover and an outage here is the cheapest one to lose.
  try {
    const aiMode = await runDueAiModeCaptures();
    if (aiMode.projectsVisited > 0) {
      // **Vendor cost beside the estimate.** The monitor has reported
      // `actualCostUsd` since the billing fix; the line that printed only the
      // estimate dropped the one figure that would show the $0.004 constant
      // drifting. The two numbers answer different questions — the estimate is
      // what the budget was enforced against, this is what an invoice will say —
      // and their *difference* is the point.
      console.log(
        `[cron] AI Mode: ${aiMode.captured} captured, ${aiMode.failed} failed, ${formatCaptureCost(aiMode)} across ${aiMode.projectsVisited} project(s)`,
      );
    }
  } catch (err) {
    console.error("[cron] AI Mode capture failed:", err);
  }

  try {
    const aiKeywords = await runDueAiKeywordCaptures();
    if (aiKeywords.projectsVisited > 0) {
      console.log(
        `[cron] AI keywords: ${aiKeywords.rowsStored} monthly row(s) from ${aiKeywords.keywordsAsked} keyword(s) in ${aiKeywords.callsMade} call(s), ${formatCaptureCost(aiKeywords)} across ${aiKeywords.projectsVisited} project(s)` +
          // Dropped work is named by the shared formatter, so "we captured
          // everything" and "we captured what we could afford" cannot read alike.
          formatDropped(aiKeywords.droppedForBudget),
      );
    }
    // One line per failure: the night failed for this project, and a reader of
    // the log needs to know which one rather than only how many.
    for (const failure of aiKeywords.failures) {
      console.error(
        `[cron] AI keyword capture failed for project ${failure.projectId}: ${failure.reason}`,
      );
    }
  } catch (err) {
    console.error("[cron] AI keyword capture failed:", err);
  }

  // ETV last, because it is the one whose per-call price is checked against the
  // price book on every call — so if the price book is wrong, this is the
  // capture whose estimate column will show it.
  try {
    const etv = await runDueEtvCaptures();
    if (etv.projectsVisited > 0) {
      console.log(
        `[cron] ETV: ${etv.rowsStored} point(s) from ${etv.domainsAsked} domain(s), ${formatCaptureCost(etv)} across ${etv.projectsVisited} project(s)` +
          formatDropped(etv.droppedForBudget),
      );
    }
    for (const failure of etv.failures) {
      console.error(
        `[cron] ETV capture failed for ${failure.domain}: ${failure.reason}`,
      );
    }
  } catch (err) {
    console.error("[cron] ETV capture failed:", err);
  }

  // The Opportunity Score's inputs, and the fourth capture — added because it
  // shipped as a writer with no caller, which is the failure this whole module
  // exists to prevent. Its inputs come from `TrackedKeywordsRepository`, so it
  // is a real job on the same nightly tick rather than a service in the index.
  //
  // It is cheapest-first in the log and last in the dispatch: like the other
  // three, it bills the vendor, so it goes after the cheap work that must not
  // be blocked by it, and inside its own try/catch so an outage here cannot
  // stop the archive filling.
  //
  // **Each count is reported separately, never summed** — `difficultyStored`,
  // `competitorsStored` and `intentStored` are three different measurements, and
  // a silent total is what would let "we captured one of three" read as a
  // complete night.
  try {
    const opportunity = await runDueOpportunityInputCaptures();
    if (opportunity.projectsVisited > 0) {
      console.log(
        `[cron] Opportunity inputs: ${opportunity.keywordsAsked} keyword(s) in ${opportunity.callsMade} call(s), $${opportunity.costUsd.toFixed(4)} across ${opportunity.projectsVisited} project(s)` +
          ` — difficulty ${opportunity.difficultyStored}, competitors ${opportunity.competitorsStored}, intent ${opportunity.intentStored}`,
      );
    }
    for (const failure of opportunity.errors) {
      console.error(`[cron] Opportunity input capture failed: ${failure}`);
    }
  } catch (err) {
    console.error("[cron] Opportunity input capture failed:", err);
  }
}
