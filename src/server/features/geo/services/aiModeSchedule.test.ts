import { describe, expect, it } from "vitest";
import { planAiModeCaptures, type WatchedPrompt } from "./aiModeSchedule";

/**
 * The nightly AI Mode capture plan.
 *
 * The rule under test is one the obvious implementation gets wrong: **pick the
 * cheapest keywords**. A keyword whose answer has never moved is not cheap — it
 * is *uninformative*, and running it again buys the same nothing. Meanwhile the
 * prompt that moved last week is the one most likely to move again, and the one
 * whose change a customer would act on.
 *
 * The second property under test is the honesty of a truncated plan: a scheduler
 * that silently drops prompts underreports its own coverage, and "we checked
 * everything" is the claim a customer relies on when they conclude their brand
 * was not mentioned.
 */

const prompt = (
  over: Partial<WatchedPrompt> & { keyword: string },
): WatchedPrompt => ({
  estimatedCostUsd: 0.004,
  observedChanges: 0,
  observations: 5,
  ...over,
});

const plan = (prompts: WatchedPrompt[], budgetUsd = 1, locationCode = 2840) =>
  planAiModeCaptures({ prompts, budgetUsd, locationCode, languageCode: "en" });

describe("planAiModeCaptures", () => {
  it("prefers a prompt that has moved over a cheaper stable one", () => {
    // The whole point. Cheapest-first would put "steady" first and capture
    // nothing the customer can act on.
    const result = plan([
      prompt({ keyword: "steady", observedChanges: 0, observations: 9 }),
      prompt({ keyword: "volatile", observedChanges: 3, observations: 9 }),
    ]);
    expect(result.admitted[0]?.keyword).toBe("volatile");
    expect(result.admitted[0]?.reason).toMatch(/moved in 3 of 9/i);
  });

  it("will pay more for a volatile prompt than for a cheap one", () => {
    // Volatility dominates cost. The expensive prompt is admitted and the cheap
    // one is not, which is the opposite of budget-first thinking and the correct
    // trade, because the diff is the product.
    const result = plan([
      prompt({
        keyword: "cheap-stable",
        estimatedCostUsd: 0.001,
        observations: 9,
      }),
      prompt({
        keyword: "pricey-volatile",
        estimatedCostUsd: 0.02,
        observedChanges: 2,
      }),
    ]);
    expect(result.admitted[0]?.keyword).toBe("pricey-volatile");
  });

  it("ranks a never-observed prompt above a proven-stable one", () => {
    // Zero changes means different things at different sample sizes, and one
    // capture is not evidence of stability.
    const result = plan([
      prompt({ keyword: "stable", observations: 12 }),
      prompt({ keyword: "unknown", observedChanges: 0, observations: 0 }),
    ]);
    expect(result.admitted[0]?.keyword).toBe("unknown");
    expect(result.admitted[0]?.reason).toMatch(/no baseline/i);
  });

  it("treats a barely-observed prompt as not yet stable", () => {
    const result = plan([
      prompt({ keyword: "once", observations: 1 }),
      prompt({ keyword: "often", observations: 11 }),
    ]);
    expect(result.admitted[0]?.keyword).toMatch(/once|often/);
    expect(
      result.admitted.some(
        (a) => a.keyword === "once" && /too few/.test(a.reason),
      ),
    ).toBe(true);
  });

  it("stops at the budget and says the budget was the limit", () => {
    // The distinction that matters: "we covered what we could afford" and "we
    // covered everything" are different claims, and only the second one is safe.
    const result = plan(
      Array.from({ length: 10 }, (_, i) =>
        prompt({ keyword: `k${i}`, estimatedCostUsd: 0.004 }),
      ),
      0.01,
    );
    expect(result.admitted).toHaveLength(2);
    expect(result.budgetBound).toBe(true);
    expect(result.skipped).toHaveLength(8);
    expect(result.summary).toMatch(/not checked — that is missing coverage/i);
  });

  it("says the full set was covered when the budget was not the limit", () => {
    const result = plan(
      [prompt({ keyword: "a" }), prompt({ keyword: "b" })],
      1,
    );
    expect(result.budgetBound).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.summary).toMatch(/full prompt set was covered/i);
  });

  it("names every skipped prompt rather than reporting a count", () => {
    // A bare number cannot be acted on and cannot be shown to a customer.
    const result = plan(
      Array.from({ length: 3 }, (_, i) =>
        prompt({ keyword: `k${i}`, estimatedCostUsd: 0.004 }),
      ),
      0.004,
    );
    expect(result.skipped.map((s) => s.keyword)).toEqual(["k1", "k2"]);
    for (const skip of result.skipped) {
      expect(skip.reason).toMatch(/budget/i);
    }
  });

  it("reports an empty prompt set rather than claiming a clean run", () => {
    // A nightly job that ran and found nothing must not read like one that
    // found nothing to report.
    const result = plan([]);
    expect(result.admitted).toEqual([]);
    expect(result.summary).toMatch(/no AI Mode prompts are configured/i);
  });

  it("spends at most the budget, and never a fraction over", () => {
    // A cost that overshoots by a rounding error is still a real overshoot when
    // the budget is a hard ceiling.
    const result = plan(
      [
        prompt({ keyword: "a", estimatedCostUsd: 0.006 }),
        prompt({ keyword: "b", estimatedCostUsd: 0.006 }),
      ],
      0.01,
    );
    expect(result.estimatedCostUsd).toBeLessThanOrEqual(0.01);
    expect(result.admitted).toHaveLength(1);
  });

  it("carries the market onto every admitted capture", () => {
    // AI Mode is not available everywhere, and the guard in the client turns an
    // unset market into a clear message — a planner that dropped the market
    // would produce exactly those rejections, nightly.
    const result = plan([prompt({ keyword: "a" })], 1, 2823);
    expect(result.admitted[0]?.locationCode).toBe(2823);
    expect(result.admitted[0]?.languageCode).toBe("en");
  });
});
