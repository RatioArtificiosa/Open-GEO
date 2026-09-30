import { postLlmResponseTasks } from "@/server/lib/dataforseo/llm-responses-queue";
import type { LlmModelSlug } from "@/server/lib/dataforseo/llm-models";

/**
 * Deciding *whether* to use the queue, and what to do when we do.
 *
 * ## The queue is not the default, and the reason is a promise
 *
 * The Standard queue is ~30% cheaper. It is also up to **72 hours** slow. The
 * product's current, shipped, tested behaviour is that a patrol archives answers
 * within the run. So flipping the default would mean: cheaper, and quietly
 * delivering tomorrow's data three days from now, with every existing surface
 * rendering an empty archive and no error anywhere.
 *
 * That is a worse product, and it is worse *quietly* — which is the failure mode
 * this codebase has repeatedly found. So the mode is an explicit, per-run
 * decision, and the default stays Live. If the queue becomes the default, that is
 * a deliberate change to what the product promises, and it should be argued for
 * rather than inherited from a cost optimisation.
 *
 * ## What the planner does and does not decide
 *
 * It decides *how* to post: which prompts, in what order, on what platform, and
 * — the part that matters — **how it will be told the answers arrived**. It does
 * not decide whether the resulting data is current enough for a given surface,
 * because that depends on the surface, and a surface that shows a queued answer
 * without saying it is three days old is the bug this whole design avoids.
 *
 * So every queued result carries its posted-at time, and the archive reads it,
 * because an answer with no age attached cannot be compared against a fresh one.
 */

/** How a run obtains its answers. */
export type AcquisitionMode =
  /**
   * Query now and archive now. The default, and what the product promises.
   * One task per request, so a run is many billed calls.
   */
  | "live"
  /**
   * Post to the Standard queue and archive when the answers arrive, up to 72
   * hours later. Cheaper, and only correct for surfaces that say so.
   */
  | "queued";

/** One prompt we intend to ask. */
export type QueueCandidate = {
  prompt: string;
  /** The target the answer will be attributed to. */
  targetId: string;
  platform: LlmModelSlug;
  modelName: string;
};

/** What a post attempt did, in terms a run log can carry verbatim. */
type PostOutcome =
  | {
      posted: true;
      /** Entries the vendor accepted, each already carrying its own id. */
      accepted: number;
      /**
       * Entries the vendor rejected. Non-zero here is normal and is **not** a
       * failure of the run — a batch can be partially accepted — but it is
       * reported, because a rejection is usually a malformed prompt or a
       * balance problem, and both are silent otherwise.
       */
      rejected: number;
      /** What was charged at post time: the $0.01 advance per accepted task. */
      advanceUsd: number;
    }
  | {
      posted: false;
      /**
       * Why nothing was posted. Never swallowed, because a run that silently
       * archived nothing looks identical to a run where every brand was absent.
       */
      reason: string;
    };

/**
 * How many prompts a single post may carry.
 *
 * The vendor's documented batch cap, re-read here rather than imported so the
 * planner's arithmetic is readable in one place — and so a change to the client's
 * constant surfaces as a test failure rather than as a silent divergence.
 */
const MAX_PER_POST = 100;

/**
 * Split candidates into post-sized batches.
 *
 * **Batching is not an optimisation here, it is a correctness requirement.** A
 * post over the vendor's cap is rejected wholesale with 40006, so a plan of 250
 * prompts posted as one call loses all 250 rather than 150 of them.
 *
 * One candidate per prompt is a rule the caller must respect, not something
 * recoverable below: a single prompt cannot be split across two tasks without
 * asking the model half a question and archiving a nonsense answer.
 */
export function planPosts(candidates: QueueCandidate[]): QueueCandidate[][] {
  const batches: QueueCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += MAX_PER_POST) {
    batches.push(candidates.slice(i, i + MAX_PER_POST));
  }
  return batches;
}

/**
 * The tag that ties a collected answer back to the prompt that asked for it.
 *
 * `${targetId}:${platform}:${index}` — the index within this run's plan, because
 * two targets can legitimately ask the *same* prompt for the same platform, and
 * a tag built from target and platform alone would collide and attach the second
 * answer to the first target. The collision is silent: both rows look complete.
 */
export function tagFor(candidate: QueueCandidate, index: number): string {
  return `${candidate.targetId}:${candidate.platform}:${index}`;
}

/**
 * Post one batch and report exactly what happened.
 *
 * Never throws. A queue post that fails has already been charged for by the
 * vendor, so an exception escaping here would be a failure *after* spending the
 * customer's money, and the run log would never record that it happened. So the
 * outcome carries the reason instead.
 */
export async function postBatch(
  se: LlmModelSlug,
  batch: QueueCandidate[],
  indexOffset: number,
): Promise<PostOutcome> {
  if (batch.length === 0) {
    return { posted: false, reason: "Nothing to post: the batch was empty." };
  }

  try {
    const response = await postLlmResponseTasks({
      se,
      tasks: batch.map((candidate, i) => ({
        userPrompt: candidate.prompt,
        modelName: candidate.modelName,
        tag: tagFor(candidate, indexOffset + i),
        // Web search on, because the product's claim is about what the model
        // *retrieved and cited*, and without it there are no citations to parse.
        // A queued answer with no search is a different, much weaker measurement
        // and would be archived as though it were the same one.
        webSearch: true,
      })),
    });

    const accepted = response.data.length;
    // Rejections are inferred, not reported: the client returns only accepted
    // entries, so the count that did not come back is the count the vendor did
    // not take. Inferring beats trusting, because there is no other field to
    // read it from.
    const rejected = batch.length - accepted;

    return {
      posted: true,
      accepted,
      rejected,
      advanceUsd: response.billing.costUsd,
    };
  } catch (error) {
    return {
      posted: false,
      reason: `The queue refused the post: ${error instanceof Error ? error.message : String(error)}. The advance may still have been taken — this is not proof the work was skipped.`,
    };
  }
}

/**
 * The sentence a run log carries when it has posted rather than collected.
 *
 * It has to say two things, because each one alone is misleading: the work was
 * *started* and it is not *finished*. A note that says "queued 100 prompts"
 * without the second clause reads as success, and the archive stays empty until
 * someone remembers why — which is the failure mode the 72-hour ceiling creates.
 */
export function queueNote(input: {
  posted: number;
  accepted: number;
  rejected: number;
}): string {
  if (input.rejected > 0) {
    // The verb follows the count, for the same reason CL-300a's link validator
    // fixed its pluralisation: a sentence that says "1 were rejected" makes a
    // reader distrust the number next to it.
    const verb = input.rejected === 1 ? "was" : "were";
    return `Queued ${input.accepted} of ${input.posted} prompts — ${input.rejected} ${verb} rejected by the vendor. Results arrive over the next hours, not now, and the archive for this run stays empty until they do.`;
  }
  return `Queued ${input.posted} prompts. Results arrive over the next hours, not now, and the archive for this run stays empty until they do.`;
}
