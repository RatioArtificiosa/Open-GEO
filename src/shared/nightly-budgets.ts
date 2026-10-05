/**
 * What the nightly sweeps are allowed to spend, per run.
 *
 * ## Policy, not prices
 *
 * `dataforseo-pricing.ts` records **what the vendor charges**. This records **what we
 * allow ourselves to spend**, which is a different kind of number, arrived at
 * differently. `AI_KEYWORD_UNIT_COST_USD` is the unit *rate*, so it stayed in the
 * price book.
 *
 * ## Why they moved
 *
 * The price book was one line over its limit, and the fix was not to trim a comment.
 * The caveat that went over records that DataForSEO removed the $100/month minimum on
 * 2026-07-01, and **a price book's most expensive misstatement is one about whether
 * the thing is usable at all.**
 *
 * ## Not a product limit
 *
 * The patrol runner says it outright: *"it is not a product limit — raise it once real
 * spend is known."* **Consolidating it does not make it one**, so the name and this
 * comment say otherwise. A shared constant reads as a decision somebody made, and
 * nobody has made this one. It is a placeholder somebody owes.
 *
 * ## Do not tune these without reading the sweeps
 *
 * The caps are per project, so one large customer cannot spend the night's whole budget
 * and starve every other one. That is the failure which actually happens in
 * production, and the reason this is a cap and not a total.
 */

/**
 * What one night of each capture may spend, in USD.
 *
 * ## Why these live here and not in the runners
 *
 * **Three separate reasons, and the third is the one that settles it.**
 *
 * 1. **They are policy, not mechanism.** A budget says what the product is willing to
 *    spend overnight; a cron runner says how it spends it. Those change for different
 *    reasons and at different times.
 * 2. **The runners cannot be imported to read them.** `scheduledEtvCapture` reaches
 *    `@/db` → `db/provider.ts` → `import { env } from "cloudflare:workers"`, which does not
 *    resolve outside a Worker. A test that imported the constant would load **zero tests**.
 * 3. **Beside the price book is where a reader looks.** These numbers only mean anything
 *    against a unit price, and `DFS_LABS.standard` lives here — so the budget and the
 *    price it divides by can never drift apart by being edited in different files.
 *
 * ## And the honesty about them
 *
 * **All three are placeholders**, pending a live DataForSEO measurement — which is blocked
 * on account verification. `scripts/nightly-budgets.test.ts` asserts the *relationships*
 * between them (what a night can afford, and whether the ceiling can bind at all) rather
 * than endorsing an amount, because a test that endorsed a placeholder would make it
 * permanent by making it unchangeable.
 *
 * The keyword unit price is the soft one: it is the only figure here that has never been
 * compared against what the vendor actually charges.
 */
export const NIGHTLY_BUDGET_USD = {
  /** `scheduledEtvCapture` — shared across the night's projects. */
  etv: 5,
  /** `scheduledAiKeywordCapture` — shared across the night's projects. */
  aiKeyword: 5,
  /**
   * `scheduledAiModeCapture` — **per project, not shared.**
   *
   * The other two share one night budget across projects; this runner gives each project
   * the whole amount, because dividing it would make the bound depend on how many other
   * customers happen to be watching. **The divergence is deliberate and is the reason
   * these are named rather than summed.**
   */
  aiMode: 0.1,
} as const;

/**
 * How much of one project the capture covers per night.
 *
 * **A count, not a price**, and that is the design working: coverage does not move when
 * the price book is corrected. A money cap would make the budget the thing that decides
 * what a customer is measured on.
 */
export const PER_PROJECT_NIGHTLY_CAP = {
  /** One ETV point per tracked domain, per night. */
  etvDomains: 25,
  /** One vendor call per prompt. */
  aiKeywords: 25,
} as const;

/**
 * How many customers one nightly tick may touch, across the whole product.
 *
 * ## One policy, four files, and this is the third instance of one failure mode
 *
 * `scheduledEtvCapture`, `scheduledAiKeywordCapture`, `scheduledAiModeCapture` and
 * `scheduledGeoPatrol` each declared their own `?? 25`, and **each comment credited the
 * others**: *"the same first-deploy safety valve both siblings carry"*, *"the same
 * first-deploy safety valve `runDuePatrols` has"*, *"a safety valve for the first
 * production deploy"*.
 *
 * **Cross-referencing each other and nothing else is not four coincidences.** It is one
 * decision restated four times — and restating is how the two CodeRabbit majors of the same
 * session happened: a clamp order in two places, and a budget in two places. **A gate cannot
 * see any of them**, because every declaration really is used; only a reader comparing two
 * files notices they ought to agree.
 *
 * Found by a sweep for policy-adjacent literals after the budgets were consolidated for
 * exactly this reason — **which is the part worth keeping: a refactor that fixes one instance
 * of a rule and leaves its siblings reads as finished, because the part anyone looked at
 * is finished.**
 *
 * ## Not a product limit
 *
 * The patrol runner says it outright: *"it is not a product limit — raise it once real spend
 * is known."* **Consolidating it does not make it one**, so the name and this comment say
 * otherwise — a shared constant reads as a decision somebody made, and nobody has made this
 * one. It is a placeholder somebody owes.
 */
export const NIGHTLY_PROJECT_SWEEP_LIMIT = 25;
