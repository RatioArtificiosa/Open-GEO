import { normaliseUrlForJoin } from "./urlIdentity";

/**
 * Deciding what is worth interrupting someone about.
 *
 * ## The unit of this file is the *decision*, not the notification
 *
 * There is no transport here — no Discord webhook, no email, no push. That is
 * deliberate, and the reason is worth stating because it is the whole design:
 *
 * **The expensive mistake in alerting is not missing an event, it is sending one
 * that turns out to be noise.** A missed mention is a customer who asks. A
 * nightly ping saying "sentiment moved" four times a week, three of which are the
 * same thing re-reported, is a product that has trained its users to ignore it —
 * and then the fourth, real one, is not read either. Every competitor can send a
 * message; the moat is knowing which messages to send.
 *
 * So this answers a single question: **given the previous run and this one, is
 * there anything here a human would want to know about?** Everything downstream
 * — channel, batching, wording — is a transport concern that should not be able
 * to change that judgement.
 *
 * ## What is deliberately NOT an alert
 *
 * - **A citation that merely moved rank.** `answerDiff` already classifies these
 *   separately from gains and losses. Rank churn between weekly runs is the
 * * normal texture of a model answer, and alerting on it is how you get 200
 *   notifications a month and none of them matter.
 * - **A gained citation with no corresponding loss.** A model adding a source is
 *   mildly good news and not urgent. A *loss* is a regression someone can act on.
 * - **A sentiment word appearing in an answer.** Sentiment is derived from model
 *   output by our own classification, so a "swing" is often the classifier being
 *   unstable on a near-neutral sentence, not the world changing. Only a swing that
 *   clears a margin **and** repeats is reported, and a single observation is
 *   never reported at all — see `swingIsReal`.
 * - **Anything at all when the previous run is missing or empty.** A first run
 *   establishes a baseline; diffing against nothing produces a change for every
 *   item, which is a notification storm that teaches nothing.
 *
 * ## One detector for "the same question, a different answer", not two
 *
 * The obvious thing here was to call `answerDiff` and filter for `lost`, since
 * that is the reviewed implementation with the weighting decision and the
 * causality refusal already in it. A `citationLosses` helper doing exactly that
 * was written first, and then **deleted** — because the loop below already does
 * the same comparison, and two detectors for one fact is two detectors that can
 * disagree, with the disagreement invisible.
 *
 * What is shared instead is the part that is genuinely shared and genuinely
 * load-bearing: `normaliseUrlForJoin`, one definition of "the same page", used
 * by this, by the diff, and by the inclusion–citation gap. That is the piece
 * where a second spelling produced a real phantom finding (CL-206), so it stays
 * one function. The *loss detection* is scoped to this file because it needs the
 * per-run `Observation` shape and the alert-suppression policy, which
 * `answerDiff` has no opinion about.
 *
 * ## The one thing this never claims
 *
 * It never says *why* something changed. Models change for reasons we cannot
 * observe — a retraining, a sampling draw, a query expansion. "You lost the
 * citation because we published that post" is a causal claim with no evidence
 * behind it, and it is the kind that makes a customer abandon the product after
 * acting on advice that was never real. `answerDiff` refuses the same thing and
 * this inherits the refusal rather than reopening it in a new file.
 *
 * Verified 2026-09-29.
 */

/**
 * A change in one dimension between two runs, before severity is applied.
 *
 * Module-private: a consumer narrows the union by `kind` and never names this,
 * so exporting it would offer an import path nothing takes.
 */
export type Change =
  | {
      kind: "mention_lost";
      /** The brand domain that stopped being mentioned. */
      domain: string;
      platform: string;
      /** The prompt it was being mentioned for. */
      prompt: string;
    }
  | {
      kind: "mention_gained";
      domain: string;
      platform: string;
      prompt: string;
    }
  | {
      kind: "citation_lost";
      url: string;
      platform: string;
      prompt: string;
    }
  | {
      kind: "sentiment_swing";
      platform: string;
      prompt: string;
      from: string;
      to: string;
    };

/** One prompt's worth of observations for a single run. */
export type Observation = {
  platform: string;
  prompt: string;
  /** The brand being watched. */
  domain: string | null;
  /**
   * Whether the brand was mentioned in this answer.
   *
   * **Three states, not two.** `null` means the vendor task had not finished, and
   * it is the one that matters: a pending task is not an absence, and treating it
   * as one would manufacture a "you were dropped" alert out of a request that
   * has not come back yet.
   */
  mentioned: boolean | null;
  /** Null when we have no sentiment for this answer. Never inferred. */
  sentiment: string | null;
  citations: string[];
};

export type AlertDecision =
  | {
      /** Nothing worth interrupting anyone about. Not an error — the common case. */
      shouldAlert: false;
      /** What was considered and dismissed, so the silence is auditable. */
      suppressed: Change[];
    }
  | { shouldAlert: true; alerts: Change[]; suppressed: Change[] };

/**
 * How many consecutive runs a sentiment swing must appear in before it is real.
 *
 * Two, not one. A single observation is a coin flip on a near-neutral sentence,
 * and our classifier is a heuristic — reporting it would make every third alert
 * a false alarm, which is the rate at which people stop reading alerts. Two
 * consecutive agreeing observations is the cheapest test that materially beats a
 * coin flip, and it costs one run of latency.
 */
const SENTIMENT_SWING_RUNS = 2;

/**
 * Is this sentiment swing real, or classifier noise?
 *
 * Exported and pure so the policy can be tested directly. `recentSwings` is the
 * run before this one, oldest first.
 */
export function swingIsReal(
  swing: { from: string; to: string },
  recentSwings: ReadonlyArray<{ from: string; to: string }>,
): boolean {
  const sameDirection = recentSwings.filter(
    (s) => s.from === swing.from && s.to === swing.to,
  );
  return sameDirection.length + 1 >= SENTIMENT_SWING_RUNS;
}

/**
 * Decide whether a run's changes are worth alerting on.
 *
 * The ordering matters and is not alphabetical: **losses are evaluated before
 * gains** so a run containing both reports the regression first. A reader who
 * stops after the first line must see the thing that lost, not the thing that
 * appeared — the same reasoning `answerDiff` uses.
 */
export function decideAlerts(input: {
  previous: Observation[] | null;
  current: Observation[];
  /** The prior run's swings, for the repeat test. */
  recentSwings?: ReadonlyArray<{ from: string; to: string }>;
}): AlertDecision {
  const { previous, current, recentSwings = [] } = input;

  // No baseline means no diff. A first run establishes a reference; treating
  // every item as "new" would produce a notification that says "we started
  // monitoring you", which is not news to the person who pressed the button.
  if (previous === null || previous.length === 0) {
    return { shouldAlert: false, suppressed: [] };
  }

  const byKey = new Map(
    previous.map((o) => [`${o.platform}|${normaliseUrlForJoin(o.prompt)}`, o]),
  );

  const changes: Change[] = [];
  for (const now of current) {
    const key = `${now.platform}|${normaliseUrlForJoin(now.prompt)}`;
    const before = byKey.get(key);
    if (before === undefined) continue;

    // A pending vendor task is not an absence. Diffing `true` against `null`
    // would manufacture a "you were dropped" alert out of a request that has
    // not come back yet — the single most damaging thing this file could do,
    // because the customer is told they lost a mention that was never looked
    // up. The same guard covers the current run, and a run where *both* sides
    // are pending is not a change at all.
    if (now.mentioned === null || before.mentioned === null) continue;
    // Bound to a local so the non-null type flows into the changes below.
    // Reading `now.domain` again re-widens to `string | null` and the compiler
    // is right to refuse it.
    const domain = now.domain;
    if (domain === null || before.domain === null) continue;

    // Whether the brand was mentioned, not whether two domain strings match.
    // `domain` is the brand being watched, so a "change" in it is a change in
    // what was *asked about* — which is a different event entirely, and treating
    // it as a mention gain or loss would fire an alert when someone edited a
    // target's domain. The `null` guard above has already narrowed both to a
    // plain boolean, so these are direct comparisons rather than `=== true`.
    if (before.mentioned && !now.mentioned) {
      changes.push({
        kind: "mention_lost",
        domain,
        platform: now.platform,
        prompt: now.prompt,
      });
    } else if (!before.mentioned && now.mentioned) {
      changes.push({
        kind: "mention_gained",
        domain,
        platform: now.platform,
        prompt: now.prompt,
      });
    }

    // Citations are diffed on normalised identity — the same function the
    // inclusion–citation gap uses, so a "new citation" is never the same page
    // under a new `utm_source`. The loop finds *losses*; gains and rank moves
    // are suppressed by design, and `answerDiff` already classifies all three.
    const afterUrls = new Set(now.citations.map(normaliseUrlForJoin));
    for (const url of before.citations) {
      const identity = normaliseUrlForJoin(url);
      // A URL that will not normalise is not comparable to anything, so it is
      // not a loss — it is a row we cannot reason about. Reporting it would
      // manufacture a "you lost this citation" for a malformed string, and the
      // drawer would then be unable to show the reader what was dropped.
      if (identity === null) continue;
      if (afterUrls.has(identity)) continue;
      changes.push({
        kind: "citation_lost",
        url: identity,
        platform: now.platform,
        prompt: now.prompt,
      });
    }

    if (
      before.sentiment &&
      now.sentiment &&
      before.sentiment !== now.sentiment
    ) {
      const swing = { from: before.sentiment, to: now.sentiment };
      if (swingIsReal(swing, recentSwings)) {
        changes.push({
          kind: "sentiment_swing",
          platform: now.platform,
          prompt: now.prompt,
          from: before.sentiment,
          to: now.sentiment,
        });
      }
    }
  }

  // Losses and confirmed swings are the alert. Gains and rank moves are not,
  // and are reported as `suppressed` so the silence is auditable rather than
  // looking like nothing happened.
  const alerts = changes.filter(
    (c) =>
      c.kind === "mention_lost" ||
      c.kind === "sentiment_swing" ||
      c.kind === "citation_lost",
  );
  const suppressed = changes.filter((c) => c.kind === "mention_gained");

  return alerts.length > 0
    ? { shouldAlert: true, alerts, suppressed }
    : { shouldAlert: false, suppressed };
}
