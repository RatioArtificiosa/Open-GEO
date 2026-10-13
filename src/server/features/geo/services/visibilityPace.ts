import { MIN_PROMPTS_FOR_DIRECTION } from "./visibilityForecast";

/**
 * "At this pace, this brand reaches X% of prompts in N days."
 *
 * ## Why this exists beside a module that refuses to forecast upward
 *
 * `visibilityForecast.ts` refuses a growth curve on the ground that *what moves
 * a model is not observable*: an exponential fitted to twelve points is a
 * promise about a competitor's release schedule. That refusal stands, and this
 * module does not contradict it, because the two make different claims:
 *
 * - **A growth curve is a claim about the world** — it says the rate *will*
 *   rise, because a curve points that way.
 * - **This is a claim about arithmetic** — it takes the slope the archive has
 *   already measured, extends it linearly over a stated horizon, and says what
 *   share that implies *if the pace holds*. Every sentence carries the
 *   condition, and the refusals below are the cases where the condition cannot
 *   be stated at all.
 *
 * The distinction is the whole design: "at this pace you reach 30% in ten
 * weeks" is a statement a reader can check against the history, and "your
 * visibility will reach 30%" is a statement nobody can. The module prints the
 * first sentence and refuses to imply the second.
 *
 * ## What the projection will not do
 *
 * - **It does not run when no pace has been measured.** The floor is
 *   `visibilityForecast`'s own — eight weeks — imported rather than restated so
 *   the two cannot disagree about where "measured" begins.
 * - **A flat or falling share has no arrival date.** "X% in N days" with a
 *   negative pace is a countdown to something that moves away, and the answer
 *   says so instead.
 * - **The share is capped at every prompt measured.** A pace that reaches 100%
 *   inside the horizon is reported as the bound it is, because a projection
 *   that prints past the ceiling is a number about the model of the world
 *   rather than the slope.
 */

/** The horizon the sentence speaks over: the product's standard 90-day band. */
export const PACE_HORIZON_DAYS = 90;

/**
 * The share the "reach X%" sentence aims at, when the caller names none.
 *
 * Not exported: no other file names it, and a consumer that wants a different
 * target passes one. A constant exporting nothing is a number that can drift
 * from the default actually used.
 */
const DEFAULT_TARGET_SHARE = 0.3;

/**
 * A pace projection for one platform.
 *
 * The type is not exported either — a caller reaching for it writes
 * `ReturnType<typeof projectVisibilityPace>`, which cannot drift from the
 * function it describes.
 */
type VisibilityPace = {
  platform: string;
  /** The measured weekly change, as a fraction, or null when unmeasured. */
  perWeek: number | null;
  /** The share now, 0-1, or null when unmeasured. */
  rateNow: number | null;
  /** Weeks at this pace to reach the target, or null when it is not reachable. */
  weeksToTarget: number | null;
  /** The share after the horizon at this pace, 0-1, capped. Null when unmeasured. */
  shareAfterHorizon: number | null;
  /** The target share the sentence names. */
  targetShare: number;
  /** The horizon in days. */
  horizonDays: number;
  /** The sentence a reader sees. Never a bare number. */
  summary: string;
  /** What this projection does not claim. */
  doesNotClaim: string;
};

/**
 * Project the measured pace over the horizon.
 *
 * Pure: the numbers are the archive's, and every refusal is returned rather
 * than thrown, so a dashboard can say why there is no arrival date instead of
 * rendering nothing.
 */
export function projectVisibilityPace(input: {
  platform: string;
  /** The share now, 0-1. Null when the run's denominator is unknown. */
  rateNow: number | null;
  /** The measured weekly change. Null when the history is under the floor. */
  perWeek: number | null;
  /** How many weeks the pace rests on. */
  basedOnWeeks: number;
  targetShare?: number;
  horizonDays?: number;
}): VisibilityPace {
  const targetShare = input.targetShare ?? DEFAULT_TARGET_SHARE;
  const horizonDays = input.horizonDays ?? PACE_HORIZON_DAYS;
  const horizonWeeks = Math.round(horizonDays / 7);

  const doesNotClaim =
    "This is a linear extension of a slope the archive measured, not a prediction: " +
    "it says what the recent pace implies if nothing changes, and nothing here knows " +
    "whether the model's behaviour will change. Asking a different question set moves " +
    "the share without the brand changing at all.";

  // **No pace, no projection.** The floor is imported from the module that owns
  // it, so the refusal and the measurement cannot disagree about where a slope
  // starts being real. A short history produces the reason, not a weaker
  // number — a slope through six weeks of noise is a slope in the arithmetic
  // sense only.
  if (
    input.perWeek === null ||
    input.basedOnWeeks < MIN_PROMPTS_FOR_DIRECTION
  ) {
    return {
      platform: input.platform,
      perWeek: null,
      rateNow: input.rateNow,
      weeksToTarget: null,
      shareAfterHorizon: null,
      targetShare,
      horizonDays,
      summary:
        input.basedOnWeeks === 0
          ? "Nothing has been measured yet, so there is no pace to extend."
          : `Only ${input.basedOnWeeks} week${input.basedOnWeeks === 1 ? "" : "s"} of history, and ${MIN_PROMPTS_FOR_DIRECTION} are the floor before a weekly change means anything. No arrival date is given.`,
      doesNotClaim,
    };
  }

  // A share with no denominator cannot be extended: the pace is measured from
  // the same series the level comes from, and a level of null means the level
  // is unknown, whatever the slope says.
  if (input.rateNow === null) {
    return {
      platform: input.platform,
      perWeek: input.perWeek,
      rateNow: null,
      weeksToTarget: null,
      shareAfterHorizon: null,
      targetShare,
      horizonDays,
      summary:
        "A weekly change has been measured, but the current share has no denominator behind it, so there is nothing to extend it from.",
      doesNotClaim,
    };
  }

  const perWeek = input.perWeek;
  const rateNow = input.rateNow;
  // Capped at 1, because the unit is the share of prompts asked: "every prompt
  // measured" is a ceiling, and a projection that prints past it is a number
  // about a model of the world rather than about the measured slope.
  const shareAfterHorizon =
    rateNow + perWeek * horizonWeeks >= 1
      ? 1
      : Math.max(0, rateNow + perWeek * horizonWeeks);

  // A flat or falling share has no arrival date, and inventing one by running
  // the arithmetic backwards would be a countdown to something moving away.
  if (perWeek <= 0 || rateNow >= targetShare) {
    const already =
      rateNow >= targetShare ? " It is already past that share." : "";
    return {
      platform: input.platform,
      perWeek,
      rateNow,
      weeksToTarget: null,
      shareAfterHorizon,
      targetShare,
      horizonDays,
      summary:
        `On ${input.platform} the share is ${formatShare(rateNow)} and moving ${formatSignedPoints(perWeek)} per week, so there is no arrival date to give${already}` +
        (shareAfterHorizon === 1 && perWeek > 0
          ? " — at this pace it reaches every prompt measured, which is a ceiling rather than a forecast."
          : "."),
      doesNotClaim,
    };
  }

  const weeksToTarget = (targetShare - rateNow) / perWeek;
  const withinHorizon = weeksToTarget <= horizonWeeks;
  const platform = input.platform;

  return {
    platform,
    perWeek,
    rateNow,
    weeksToTarget,
    shareAfterHorizon,
    targetShare,
    horizonDays,
    summary:
      `On ${platform} the share is ${formatShare(rateNow)}, moving ${formatSignedPoints(perWeek)} per week over ${input.basedOnWeeks} measured weeks. ` +
      (withinHorizon
        ? `At that pace it reaches ${formatShare(targetShare)} of prompts in about ${formatCount(weeksToTarget)} (${Math.round(weeksToTarget * 7)} days).`
        : `At that pace it would reach ${formatShare(targetShare)} of prompts in about ${formatCount(weeksToTarget)} — beyond the ${horizonDays}-day band this speaks over.`) +
      ` Within the band it implies ${formatShare(shareAfterHorizon)}.`,
    doesNotClaim,
  };
}

/** A share as a percentage, rounded to the point a reader can hold. */
function formatShare(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** A weekly change in share points, signed and rounded. */
function formatSignedPoints(value: number): string {
  const points = Math.round(value * 1000) / 10;
  return `${points > 0 ? "+" : ""}${points} points`;
}

/** A count of weeks, to the nearest whole week when it is near one. */
function formatCount(weeks: number): string {
  const rounded = Math.round(weeks);
  return rounded === 1 ? "1 week" : `${rounded} weeks`;
}
