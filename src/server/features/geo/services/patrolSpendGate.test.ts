import { describe, expect, it } from "vitest";
import { checkRunSpend } from "./patrolSpendGate";

/**
 * The spend-cap decision as the patrol applies it — the words, not the arithmetic.
 *
 * `patrolSpend.test.ts` covers `decidePatrolSpend`, which is the money maths. This
 * covers the two things only this layer does: **it refuses rather than truncates**,
 * and **an allowed run is never silent about whether it had a cap**.
 *
 * ## Why it is a pure-function suite rather than a patrol suite
 *
 * The first attempt drove these through `GeoPatrol.run` in a file of its own, with
 * its own copy of that suite's mock harness. Two of the three tests failed with
 * `expected "vi.fn()" to be called` because the copied harness was incomplete —
 * the vendor mock was present but the repositories and the project settings were
 * not, so the run returned before reaching the vendor.
 *
 * **Two harnesses drift exactly the way two migration fixtures drift**, and this
 * repository already has a gate about that. The refusal itself is a pure decision,
 * so it is tested as one; the one test that genuinely needs the patrol — that no
 * vendor call happens — lives in `GeoPatrol.test.ts`, which already has a harness
 * that works.
 */
const PRICE = 0.0012;

describe("checkRunSpend", () => {
  it("refuses above the cap, naming both numbers", () => {
    const decision = checkRunSpend({
      answers: 3,
      budgetUsd: 0.0001,
      unitCostUsd: PRICE,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected a refusal");

    // **Four decimal places, not two.** These are sub-cent prices: at two, a
    // $0.0001 cap rounds to $0.00 and a $0.0036 estimate rounds to $0.00, so the
    // sentence would name a cap of zero and an estimate of zero and explain
    // nothing. The precision *is* the message.
    expect(decision.note).toContain("0.0036");
    expect(decision.note).toContain("0.0001");
    expect(decision.note).toMatch(/not run/i);
  });

  it("allows at or under the cap, with no note about a missing cap", () => {
    const decision = checkRunSpend({
      answers: 3,
      budgetUsd: 10,
      unitCostUsd: PRICE,
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("expected an allowance");
    expect(decision.notes).toEqual([]);
  });

  it("allows a run with no cap, and says so rather than running silently", () => {
    // `null` is a real state — the product has no per-project spend setting yet —
    // and "allowed" must not mean "invisible", or an operator cannot tell an
    // uncapped run from a capped one.
    const decision = checkRunSpend({
      answers: 100,
      budgetUsd: null,
      unitCostUsd: PRICE,
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("expected an allowance");
    expect(decision.notes.join(" ")).toMatch(/no spend cap/i);
  });

  it("treats a zero cap as a cap, not as 'no cap set'", () => {
    // `$0` and `null` look alike at the call site and mean opposite things: one is
    // "spend nothing", the other is "no ceiling". Reading `0` as unset would let a
    // project that was deliberately capped at nothing run unbounded.
    const decision = checkRunSpend({
      answers: 1,
      budgetUsd: 0,
      unitCostUsd: PRICE,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected a refusal");
    expect(decision.note).not.toMatch(/no spend cap/i);
  });
});
