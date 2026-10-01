/**
 * The refusal a spend cap produces, in words an operator will read.
 *
 * Kept apart from `GeoPatrol` because it is a **policy** rather than a step of the
 * run: the arithmetic is `decidePatrolSpend`'s, and the only thing here is turning
 * its decision into a sentence that names both numbers. A cap that refuses quietly
 * reads as a broken schedule, and one that refuses without a number cannot be
 * argued with.
 *
 * `maxAnswers` is a volume cap and the two are not interchangeable. 500 expensive
 * keywords and 500 cheap ones differ by an order of magnitude, so a volume cap alone
 * permits a bill nobody agreed to — and the customer finds out on an invoice.
 *
 * It refuses rather than truncating, deliberately: a cap that silently drops half
 * the prompts produces a report covering fewer questions than the customer asked
 * about, and the gap is invisible because the archive just looks thinner. Refusing
 * means the customer chooses between a bigger cap and a smaller prompt set.
 */
import { decidePatrolSpend } from "@/server/features/geo/services/patrolSpend";

export function checkRunSpend(input: {
  answers: number;
  budgetUsd: number | null;
  unitCostUsd: number;
}): { allowed: true; notes: string[] } | { allowed: false; note: string } {
  const decision = decidePatrolSpend({
    answers: input.answers,
    budgetUsd: input.budgetUsd,
    unitCostUsd: input.unitCostUsd,
  });
  if (!decision.allowed) {
    return {
      allowed: false,
      // **Four decimal places, not two.** A cap of a tenth of a cent rounded to two
      // reads as $0.00, so the sentence would name a cap of zero and an estimate of
      // zero and explain nothing. These are sub-cent prices; the precision is the
      // message.
      note: `Not run: this patrol would cost about $${decision.estimatedUsd.toFixed(4)} and the run's spend cap is $${(input.budgetUsd ?? 0).toFixed(4)}. ${decision.reason}`,
    };
  }
  return {
    allowed: true,
    // The no-cap case is allowed but not silent. A run with no ceiling is worth
    // naming where an operator will see it, and the decision belongs here rather
    // than at the call site — a caller that forgets to mention it produces an
    // uncapped run that reads exactly like a capped one.
    notes:
      input.budgetUsd === null
        ? [
            "No spend cap was set for this run, so it is bounded by its answer limit only.",
          ]
        : [],
  };
}
