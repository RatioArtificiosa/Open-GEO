import { describe, expect, it } from "vitest";
import { decidePatrolSpend, reconcilePatrolSpend } from "./patrolSpend";

/**
 * The patrol spend cap.
 *
 * The point of the module is the gap `DEFAULT_MAX_ANSWERS` leaves: a *volume*
 * cap is not a *money* cap, and a run bounded only by volume can bill a customer
 * an amount nobody agreed to. The tests are therefore mostly about two refusals:
 * **refuse rather than truncate**, and **never absorb an overrun in silence**.
 */

const UNIT = 0.0002; // $0.02 per 100 answers.

describe("decidePatrolSpend", () => {
  it("allows a run inside its cap", () => {
    const decision = decidePatrolSpend({
      answers: 100,
      budgetUsd: 0.05,
      unitCostUsd: UNIT,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.estimatedUsd).toBeCloseTo(0.02, 6);
  });

  it("refuses a run over its cap, and says nothing ran", () => {
    // The refusal is the feature. A cap that silently drops half the work
    // produces a report covering fewer prompts than the customer asked about,
    // and the only symptom is an archive that looks thinner.
    const decision = decidePatrolSpend({
      answers: 500,
      budgetUsd: 0.01,
      unitCostUsd: UNIT,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/nothing was run/i);
      expect(decision.reason).toMatch(
        /answer limit alone is not a spend limit/i,
      );
    }
  });

  it("names the two levers, because a refusal without them is a dead end", () => {
    const decision = decidePatrolSpend({
      answers: 500,
      budgetUsd: 0.01,
      unitCostUsd: UNIT,
    });
    if (!decision.allowed) {
      expect(decision.reason).toMatch(
        /raise the cap or narrow the prompt set/i,
      );
    }
  });

  it("reports no cap as a note rather than as unlimited silence", () => {
    // A run with no ceiling is normal for a small plan and worth saying out loud
    // anyway — "we had no limit" and "the limit was not reached" are different
    // sentences, and only one of them is true.
    const decision = decidePatrolSpend({
      answers: 10,
      budgetUsd: null,
      unitCostUsd: UNIT,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.notes.join(" ")).toMatch(/no spend cap was set/i);
    }
  });

  it("prices a run of nothing at nothing", () => {
    const decision = decidePatrolSpend({
      answers: 0,
      budgetUsd: 0.01,
      unitCostUsd: UNIT,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.estimatedUsd).toBe(0);
  });

  it("accounts for the per-call ceiling when answers are batched", () => {
    // The estimate is per metered call, because each call is rounded up to whole
    // credits. A total rounded once is always an undercount — the same reason
    // `estimateRankCheckCredits` loops rather than multiplying out.
    const single = decidePatrolSpend({
      answers: 100,
      budgetUsd: null,
      unitCostUsd: UNIT,
    });
    const batched = decidePatrolSpend({
      answers: 100,
      budgetUsd: null,
      unitCostUsd: UNIT,
      answersPerCall: 25,
    });
    if (single.allowed && batched.allowed) {
      expect(batched.estimatedUsd).toBeCloseTo(single.estimatedUsd, 6);
      expect(batched.notes.join(" ")).toMatch(/batched several to a call/i);
    }
  });

  it("treats a zero or negative answer count as no work, not as negative spend", () => {
    const decision = decidePatrolSpend({
      answers: -50,
      budgetUsd: 0.01,
      unitCostUsd: UNIT,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.estimatedUsd).toBe(0);
  });

  it("allows a run exactly at its cap", () => {
    // Off-by-one on a boundary is how a cap becomes a surprise on someone's
    // invoice.
    const decision = decidePatrolSpend({
      answers: 100,
      budgetUsd: 0.02,
      unitCostUsd: UNIT,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("reconcilePatrolSpend", () => {
  it("stays quiet when the estimate was right", () => {
    const result = reconcilePatrolSpend({
      estimatedUsd: 0.02,
      actualUsd: 0.02,
      budgetUsd: 0.05,
    });
    expect(result.overran).toBe(false);
    expect(result.note).toBeNull();
  });

  it("reports an overrun rather than absorbing it", () => {
    // The cap governs what we start; the vendor's figure governs what we settle.
    // A run that overran did so because the vendor charged more than planned,
    // and presenting that as "within budget" would be a lie with a receipt.
    const result = reconcilePatrolSpend({
      estimatedUsd: 0.02,
      actualUsd: 0.06,
      budgetUsd: 0.05,
    });
    expect(result.overran).toBe(true);
    expect(result.note).toMatch(/over the \$0\.05 cap/i);
    expect(result.note).toMatch(/recording the difference/i);
  });

  it("notes a drift that did not breach the cap", () => {
    // Actual and estimate differing is normal — a task that times out can be
    // re-run at the live rate. It is worth a line even when nothing broke.
    const result = reconcilePatrolSpend({
      estimatedUsd: 0.02,
      actualUsd: 0.021,
      budgetUsd: 0.05,
    });
    expect(result.overran).toBe(false);
    expect(result.note).toMatch(/differs from the estimate/i);
    expect(result.note).toMatch(/neither replaces the other/i);
  });

  it("says nothing when there is no cap to breach", () => {
    const result = reconcilePatrolSpend({
      estimatedUsd: 0.02,
      actualUsd: 0.9,
      budgetUsd: null,
    });
    expect(result.overran).toBe(false);
    expect(result.note).toMatch(/differs from the estimate/i);
  });
});
