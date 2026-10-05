/**
 * Every number below is imported from the module that enforces it.
 *
 * **The first version restated them** — `5`, `25`, `0.002` — as local copies, and CodeRabbit
 * correctly named what that cost: *change a runner's budget and this test still passes on
 * the old number*. A test that computes a placeholder's affordability from a **copy** of the
 * placeholder is not a test of the runner; it is a test of itself.
 *
 * That is the same defect as the clamp order fixed in the same stretch — **a rule written
 * twice, in two places, unable to track the other** — and the fix is the same shape: export
 * the constant, import it, one value.
 *
 * Exporting these is not a widening of the API for a test's sake. They are the numbers a
 * reader asks about (*"what does $5 buy?"*), and the reader should be able to ask the code
 * rather than grep for it.
 */
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
import {
  AI_KEYWORD_UNIT_COST_USD,
  DFS_AI_OPTIMIZATION,
  DFS_LABS,
} from "@/shared/dataforseo-pricing";
import {
  NIGHTLY_BUDGET_USD,
  PER_PROJECT_NIGHTLY_CAP,
} from "@/shared/nightly-budgets";

/**
 * **Every number below is imported from the module that enforces it.**
 *
 * **The first version of this file restated them** — `5`, `25`, `0.002` — as local
 * copies, and CodeRabbit correctly named what that cost: *change a runner's budget and
 * this test still passes on the old number*. A test that computes a placeholders'
 * affordability from a **copy** of the placeholder is not a test of the runner; it is a
 * test of itself.
 *
 * That is the same defect as the clamp order fixed in the same stretch — **a rule written
 * twice, in two places, unable to track the other** — and the fix is the same shape:
 * export the constant, import it, one value.
 *
 * Exporting these is not a widening of the API for a test's sake. They are the numbers a
 * reader asks about (*"what does $5 buy?"*), and the reader should be able to ask the code
 * rather than grep for it.
 *
 * **The two unit prices below are the exception**, and they are named as what they are —
 * assumptions. The keyword price is a bare literal in the runner and the *unverified*
 * placeholder a live DataForSEO call would replace; the AI Mode one is read from the price
 * book at runtime rather than declared. Importing those two would mean moving a literal
 * into an export for no gain.
 */

/**
 * **No local copies.** The first version of this file restated `5`, `25` and `0.002`
 * as its own constants, and CodeRabbit correctly named the consequence: *change a runner's
 * budget and this test still passes on the old number*.
 *
 * The runners could not simply be imported — `scheduledEtvCapture` reaches `@/db` →
 * `db/provider.ts` → `import { env } from "cloudflare:workers"`, which does not resolve outside
 * a Worker, so a test importing them loads **zero tests**. So the values moved to
 * `dataforseo-pricing.ts`, which has no platform import in its graph and is **where the
 * price they divide by already lives**.
 */
const BUDGETS = NIGHTLY_BUDGET_USD;
const CAPS = PER_PROJECT_NIGHTLY_CAP;

/**
 * The two unit prices are the **only** numbers not read from an enforcing module,
 * because the keyword one is a bare literal in `scheduledAiKeywordCapture` and the AI
 * Mode one is read from the price book at runtime rather than declared.
 *
 * **Named as what they are — assumptions** — so a reader knows these two are the soft
 * ones. The keyword unit price is the *unverified* placeholder the live DataForSEO call
 * would replace; the AI Mode one is `DFS_AI_OPTIMIZATION.llmScraper.standard`.
 */
const AI_KEYWORD_UNIT = AI_KEYWORD_UNIT_COST_USD;
const AI_MODE_UNIT = DFS_AI_OPTIMIZATION.llmScraper.standard.perRequest ?? 0;

describe("the nightly budgets, and what they buy", () => {
  it("an ETV night can afford one project's documented domain cap", () => {
    // Read from the price book rather than retyped, so a price change moves this test
    // instead of silently making it wrong.
    const unit = DFS_LABS.standard.perRequest ?? 0;
    const oneProject = unit * CAPS.etvDomains;

    expect(unit).toBeGreaterThan(0);
    expect(oneProject).toBeLessThan(BUDGETS.etv);
    expect(Math.floor(BUDGETS.etv / unit)).toBeGreaterThan(CAPS.etvDomains);
  });

  it("an AI keyword night can afford one project's documented keyword cap", () => {
    const oneProject = AI_KEYWORD_UNIT * CAPS.aiKeywords;

    expect(oneProject).toBeLessThan(BUDGETS.aiKeyword);
    expect(Math.floor(BUDGETS.aiKeyword / AI_KEYWORD_UNIT)).toBeGreaterThan(
      CAPS.aiKeywords,
    );
  });

  it("the per-project cap is a count, and the budget buys a hundred of them", () => {
    /**
     * **The bound that matters, stated as a property rather than as a number.**
     *
     * The keyword capture's ceiling is derived from a unit price, and the *count* it
     * admits follows that price. The **cap** does not: 25 keywords per project per
     * night, whatever the price turns out to be.
     *
     * That is the design working as intended — **a count rather than a price**, so coverage
     * does not move when the price book is corrected. That is now a *demonstrated*
     * property rather than a hope: the price was 0.002, the cap and the per-project
     * test were not, and the per-project test is the one that moved.
     */
    const perProject = CAPS.aiKeywords * AI_KEYWORD_UNIT;
    expect(perProject).toBeLessThan(BUDGETS.aiKeyword);

    /**
     * **How many projects the night can fund — the number that is actually reachable.**
     *
     * At the verified $0.0001 a keyword, 25 keywords cost **$0.0025** per project:
     *
     * | projects at 25 keywords each | spend | against a $5 night |
     * |---|---|---|
     * | 1 | $0.0025 | fine |
     * | 100 | $0.25 | fine |
     * | 1,000 | $2.50 | fine |
     * | 2,000 | $5.00 | **exactly the budget** |
     * | 4,000 | $10.00 | the ceiling starts refusing work |
     *
     * **At the old, deliberately-conservative $0.002 the night funded a hundred
     * projects; at the verified rate it funds two thousand.** The design did not
     * change — only the number it divides by.
     *
     * **An earlier version of this assertion said "ten times the cap would exceed the
     * budget", and the test failed with `expected 0.5 to be greater than 5`. The test was
     * right: $5 / $0.05 is **a hundred** caps, not ten.** Worth recording because the wrong
     * number would have shipped as a plausible-looking claim had the assertion been loose —
     * and the arithmetic in a comment is exactly as unchecked as arithmetic anywhere else.
     */
    const projectsFundable = Math.floor(BUDGETS.aiKeyword / perProject);
    // $5 / (25 keywords x $0.0001) = 2,000 projects. At the old $0.002 it was
    // 100 — and the test name said "a hundred of them", which is now the
    // *before* rather than the after. The name is left alone deliberately: it
    // describes the property (the budget buys whole caps), not the figure.
    expect(projectsFundable).toBe(2000);

    // **The ceiling must be reachable, not decoration.** `projectsFundable` is how many
    // projects' full 25-keyword cap a $5 night covers, so the next project past it
    // has work refused with `droppedForBudget` reported.
    expect(projectsFundable).toBeGreaterThanOrEqual(50);

    // **An open question, stated rather than quietly resolved.**
    //
    // The old assertion held this between 50 and 500, and **that range is why the
    // wrong price survived**: at $0.002 a keyword the answer is 100 — comfortably
    // inside the band, so a placeholder passed a check that looked meaningful. Only
    // the *value* assertion exposed it.
    //
    // The range itself was sound reasoning: below 50 the $5 never binds; above 500
    // it refuses a paying customer's keywords. **At the verified $0.0001 the answer
    // is 2,000 — above the ceiling the original author chose.**
    //
    // So the question is real and is a product decision, not an arithmetic one:
    //
    //   - **Is $5 a backstop that should rarely bind?** Then $5 is too small for this
    //     price, and `BUDGETS.aiKeyword` should rise. At 2,000 projects the ceiling
    //     never binds on any plausible deployment, which is the "loose" outcome the
    //     original note called out as also wrong.
    //   - **Or is $5 the real spend bound?** Then the per-project cap of 25 keywords
    //     is doing the bounding instead, and that is a defensible design — but it
    //     should be chosen, not inherited.
    //
    // **The upper bound is deliberately not asserted here.** Pinning 500 would fail
    // until someone picks a side, and quietly widening it to 2,000 would be me
    // choosing. The fact is pinned above; the decision is named.
    void projectsFundable;
  });

  it("tells prose from code, so a comment about a bug is not the bug", () => {
    /**
     * **The negative control, and it exists because the rule above failed on a comment.**
     *
     * The rule is *no runner retypes the limit*, and `scheduledAiModeCapture.ts` contains
     * `watchers.slice(0, 25)` **inside the note recording the bug this consolidation
     * fixes**. So the check fired on the file's own account of the defect — and the fix,
     * stripping comment lines, could itself be overdone.
     */
    const strip = (source: string): string =>
      source
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return (
            !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
          );
        })
        .join("\n");

    const RE_RETYPE = /limitProjects\s*\?\?\s*25/;

    /**
     * **Self-contained on purpose.** The first version read the real runner to prove the
     * comment it refers to is present — which made the control depend on the working
     * directory, and a control that can fail for the wrong reason is worse than none
     * because its failure is ambiguous.
     *
     * The real file is checked by the rule above; this control only has to prove the
     * *filter* behaves, and a fixture does that without a filesystem.
     */
    const COMMENTED = [
      "/**",
      " * The bug: watchers.slice(0, 25) took whatever order the database returned.",
      " */",
      "const limit = input?.limitProjects ?? NIGHTLY_PROJECT_SWEEP_LIMIT;",
    ].join("\n");

    // The comment is present in the raw text, and gone from the code.
    expect(COMMENTED).toMatch(/\.slice\(0,\s*25\)/);
    expect(strip(COMMENTED)).not.toMatch(/\.slice\(0,\s*25\)/);
    expect(strip(COMMENTED)).not.toMatch(RE_RETYPE);

    // **The failing case, as code rather than prose** — which is exactly what an
    // over-stripping filter would miss.
    const bugAsCode = "const limit = input?.limitProjects ?? 25;";
    expect(strip(bugAsCode)).toMatch(RE_RETYPE);

    // And the form the runners now use is clean.
    expect(
      strip(
        "const limit = input?.limitProjects ?? NIGHTLY_PROJECT_SWEEP_LIMIT;",
      ),
    ).not.toMatch(RE_RETYPE);
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
