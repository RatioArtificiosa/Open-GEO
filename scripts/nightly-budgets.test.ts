/**
 * What the ledger already says, made executable.
 *
 * Three nightly budgets exist — `$5` for ETV, `$5` for AI keywords, `$0.10` for AI Mode —
 * and **none of them has a test**. They were introduced as placeholders pending a pricing
 * plan, and the honest complaint recorded against them is that they are *"a guess with a
 * unit"*: nobody can judge a number nobody can compute against.
 *
 * So this computes it. Not to change the numbers — they are placeholders on purpose and
 * **that is the point of this file** — but so a real measured price has somewhere to land,
 * and so the *relationships* between the constants stop being anyone's memory.
 *
 * ## What is actually asserted
 *
 * | | |
 * |---|---|
 * | a nightly budget can afford **one** project's documented per-project cap | arithmetic |
 * | the cap is a **live** constraint, not decoration | would catch a budget drifting loose |
 * | the AI Mode budget is an **order of magnitude** smaller, and says why | a stated policy |
 *
 * **And deliberately not asserted:** that a budget is the right *amount*. It is a placeholder
 * someone has to decide, and a test that endorsed one would make the placeholder permanent
 * by making it unchangeable.
 */
import { describe, expect, it } from "vitest";
import { DFS_LABS } from "@/shared/dataforseo-pricing";

/** The per-night constants, restated. Changing one here is a deliberate act. */
const BUDGETS = {
  etv: 5,
  aiKeyword: 5,
  aiMode: 0.1,
} as const;

/** The per-project caps the runners enforce, restated for the same reason. */
const CAPS = {
  /** `scheduledEtvCapture`: one ETV point per domain, per night. */
  etvDomainsPerProjectPerNight: 25,
  /** `scheduledAiKeywordCapture`: one vendor call per keyword, per night. */
  aiKeywordsPerProjectPerNight: 25,
} as const;

/** The keyword unit price is the **unverified** one — see the note on the last test. */
const AI_KEYWORD_UNIT = 0.002;
const AI_MODE_UNIT = 0.0012;

describe("the nightly budgets, and what they buy", () => {
  it("an ETV night can afford one project's documented domain cap", () => {
    // Read from the price book rather than retyped, so a price change moves this test
    // instead of silently making it wrong.
    const unit = DFS_LABS.standard.perRequest ?? 0;
    const oneProject = unit * CAPS.etvDomainsPerProjectPerNight;

    expect(unit).toBeGreaterThan(0);
    expect(oneProject).toBeLessThan(BUDGETS.etv);
    expect(Math.floor(BUDGETS.etv / unit)).toBeGreaterThan(
      CAPS.etvDomainsPerProjectPerNight,
    );
  });

  it("an AI keyword night can afford one project's documented keyword cap", () => {
    const oneProject = AI_KEYWORD_UNIT * CAPS.aiKeywordsPerProjectPerNight;

    expect(oneProject).toBeLessThan(BUDGETS.aiKeyword);
    expect(Math.floor(BUDGETS.aiKeyword / AI_KEYWORD_UNIT)).toBeGreaterThan(
      CAPS.aiKeywordsPerProjectPerNight,
    );
  });

  it("the per-project cap is a count, and the budget buys a hundred of them", () => {
    /**
     * **The bound that matters, stated as a property rather than as a number.**
     *
     * The keyword capture's ceiling is derived from a unit price that has never been
     * verified, so the *count* it admits is a guess. The **cap** is not: 25 keywords per
     * project per night, whatever the price turns out to be.
     *
     * That is the design working as intended — **a count rather than a price**, so coverage
     * does not move when the price book is corrected.
     */
    const perProject = CAPS.aiKeywordsPerProjectPerNight * AI_KEYWORD_UNIT;
    expect(perProject).toBeLessThan(BUDGETS.aiKeyword);

    /**
     * **How many projects the night can fund — the number that is actually reachable.**
     *
     * | projects at 25 keywords each | spend | against a $5 night |
     * |---|---|---|
     * | 1 | $0.05 | fine |
     * | 25 | $1.25 | fine |
     * | 100 | $5.00 | **exactly the budget** |
     * | 200 | $10.00 | the ceiling starts refusing work |
     *
     * **An earlier version of this assertion said "ten times the cap would exceed the
     * budget", and the test failed with `expected 0.5 to be greater than 5`. The test was
     * right: $5 / $0.05 is **a hundred** caps, not ten.** Worth recording because the wrong
     * number would have shipped as a plausible-looking claim had the assertion been loose —
     * and the arithmetic in a comment is exactly as unchecked as arithmetic anywhere else.
     */
    const projectsFundable = Math.floor(BUDGETS.aiKeyword / perProject);
    expect(projectsFundable).toBe(100);

    // **And the ceiling is reachable, not decoration.** `projectsFundable` is the number
    // of projects whose full 25-keyword cap a $5 night covers, so the next project past it
    // has work refused with `droppedForBudget` reported — the honest behaviour, but still a
    // *bound*, and a bound nobody can name is a bound nobody overruns deliberately.
    //
    // **Held between 50 and 500, because that range is the decision.** Below 50 the $5 is
    // loose enough that the ceiling never binds on any plausible deployment, and above 500
    // it refuses a paying customer's keywords — both are outcomes a person should have
    // chosen rather than inherited from a placeholder.
    expect(projectsFundable).toBeGreaterThanOrEqual(50);
    expect(projectsFundable).toBeLessThanOrEqual(500);
  });

  it("the three budgets differ by policy, not by accident", () => {
    /**
     * `$0.10` against `$5` is a **50×** difference between nightly budgets, which is not a
     * typo waiting to happen — so the relationship is asserted rather than left to memory.
     *
     * | capture | unit | per-project cap | why |
     * |---|---|---|---|
     * | AI Mode | `$0.0012` | the whole `$0.10` | **the project is the bound** — the budget *is* a per-project cap |
     * | AI keyword | `$0.002` | 25 keywords | the night is shared across projects |
     * | ETV | `$0.012` | 25 domains | the night is shared across projects |
     *
     * AI Mode's runner deliberately gives **each project the full budget** rather than a
     * share — its comment says dividing it "would make the bound depend on how many other
     * customers happen to be watching". The other two divide. **Both are coherent; what
     * would not be is either changing by accident.**
     */
    expect(BUDGETS.aiMode).toBeLessThan(BUDGETS.etv / 10);
    expect(BUDGETS.etv).toBe(BUDGETS.aiKeyword);

    // AI Mode's budget buys fewer than 100 calls at its own unit price — which is why the
    // per-project share policy matters there rather than the ceiling.
    expect(Math.floor(BUDGETS.aiMode / AI_MODE_UNIT)).toBeLessThan(100);
  });
});
