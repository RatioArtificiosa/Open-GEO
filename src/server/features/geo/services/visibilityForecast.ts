/**
 * Forecasting AI visibility.
 *
 * ## This is not a traffic forecast with a different label
 *
 * CL-500 forecasts **clicks from a search console**, and its unit is a person
 * arriving at a page. This forecasts **whether a model mentions you when
 * asked**, and its unit is a *prompt answered*. The two move differently and
 * they fail differently:
 *
 * - Traffic is bounded by position and demand. Visibility is bounded by nothing we
 *   measure: a model can mention a brand it has never seen, and there is no
 *   ranking that explains it.
 * - A traffic number has a floor of zero and a well-understood mechanism. A
 *   visibility number is a **proportion of prompts**, and a proportion's
 *   uncertainty is dominated by **how many prompts we asked**, not by the maths.
 *
 * So the honest model here is a **binomial proportion with an exact interval**,
 * and the dominant term in the band is the sample size. That drives every
 * decision below: a project with 12 prompts and one with 400 get very different
 * bands from the same point estimate, and rendering them identically would be
 * the most misleading thing this surface could do.
 *
 * ## The sample size is the headline, not a footnote
 *
 * A 20% mention rate over 10 prompts and a 20% mention rate over 400 are the
 * same sentence and completely different facts. The first is consistent with
 * almost anything; the second is a measurement. So `confidence` is reported
 * alongside the rate, and a caller that renders only the rate has thrown away
 * the most important number in the payload.
 *
 * ## No growth curve
 *
 * There is no defensible way to forecast *upward* from a mention rate: what
 * moves a model is not something we can observe, and an exponential fitted to
 * twelve points is a promise about a competitor's model release schedule.
 *
 * What we *can* forecast is the **trajectory within the observed band** — and
 * even that only when the history is long enough to distinguish noise from drift.
 * Below that floor the answer is "we do not know yet", and it is said that way
 * rather than filled in.
 */

type Confidence = "none" | "low" | "moderate" | "high";

/**
 * The smallest sample that supports a trajectory claim.
 *
 * Eight is not derived from a distribution; it is the point below which a
 * proportion's interval spans more than half its own range, at which a trend
 * drawn through it is describing sampling noise. Derived in `confidenceFor` so
 * the two cannot drift apart.
 */
export const MIN_PROMPTS_FOR_DIRECTION = 8;

/** How many prompts a per-platform share rests on, as a *denominator*. */
export type VisibilityObservation = {
  platform: string;
  /**
   * How many prompts were asked.
   *
   * **Null is a real state and the reason this is not `number` alone.** The
   * archive records how often a brand was mentioned and does not record how many
   * prompts were asked, so a stored month genuinely has no denominator. A type
   * that forbade null would have made that month unexpressible, and the two ways
   * out are both bad: a cast, or a denominator inferred from a neighbouring
   * column. An inferred sample **narrows the band**, which is precisely the
   * number this feature exists to protect.
   */
  promptsAsked: number | null;
  /** How many of them mentioned the brand. Must not exceed `promptsAsked`. */
  mentions: number;
  /** The observation's date, ISO. Oldest first in the series. */
  date: string;
};

type VisibilityForecast = {
  /** Current mention rate per platform, 0-1. Null when nothing was asked. */
  current: Array<{
    platform: string;
    rate: number | null;
    /** The interval, 0-1. Null when there is no basis for one. */
    low: number | null;
    high: number | null;
    /** How many prompts the interval rests on. Zero means we cannot say. */
    basedOn: number;
    confidence: Confidence;
  }>;
  /**
   * The per-week change, as a fraction of the rate per week. **Null whenever
   * the sample is too small to support one** — which is the common case, and the
   * reason this is not the headline.
   */
  direction: {
    perWeek: number | null;
    /** The weeks the slope rests on. */
    basedOnWeeks: number;
    confidence: Confidence;
    /** The sentence. Never a bare number. */
    reading: string;
  };
  /**
   * What this forecast does not say. Present so a caller cannot render the
   * number without the caveat, because the caveat is the part that stops a
   * customer acting on a sample of twelve as though it were a market share.
   */
  doesNotClaim: string;
};

/** Wilson score interval at 95%, which behaves properly at small n. */
function wilson(
  mentions: number,
  asked: number,
): { low: number; high: number } {
  const Z = 1.959963984540054; // 95% two-sided
  const n = asked;
  const p = mentions / n;
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  };
}

/**
 * How much a given sample can support.
 *
 * Driven by the **width** of the interval rather than the point, because a
 * proportion's uncertainty is a function of n, and a 50% rate over 100 prompts
 * is a far weaker statement than a 3% rate over 100.
 */
function confidenceFor(mentions: number, asked: number): Confidence {
  if (asked <= 0) return "none";
  const { low, high } = wilson(mentions, asked);
  const width = high - low;
  if (width <= 0.15) return "high";
  if (width <= 0.35) return "moderate";
  return "low";
}

/** One platform's history, oldest first. */
function byPlatform(
  history: VisibilityObservation[],
): Map<string, VisibilityObservation[]> {
  const grouped = new Map<string, VisibilityObservation[]>();
  for (const row of history) {
    const list = grouped.get(row.platform);
    if (list) list.push(row);
    else grouped.set(row.platform, [row]);
  }
  return grouped;
}

export function forecastVisibility(
  history: VisibilityObservation[],
): VisibilityForecast {
  const grouped = byPlatform(history);

  const current = [...grouped.entries()].map(([platform, rows]) => {
    // The **latest** observation, not the sum. Summing across days would report
    // "how many times were we ever mentioned" on a panel that says "what share
    // of prompts mention us" — two different questions with the same denominator
    // in sight.
    const latest = rows[rows.length - 1];
    // `null` and `0` are different, and both mean "no rate".
    //
    // `null` is the state the archive is actually in today: mentions were
    // recorded, the number of prompts asked was not. A check for `=== 0` alone
    // lets `null` through, and `mentions / null` is `Infinity` — a mention
    // rate of infinite percent, rendered on a dashboard as a confident number.
    // The first version of this function had exactly that bug, and the only
    // reason it was caught is that a reader had to pass a stored series through.
    if (
      latest === undefined ||
      latest.promptsAsked === null ||
      latest.promptsAsked === 0
    ) {
      return {
        platform,
        rate: null,
        low: null,
        high: null,
        basedOn: 0,
        confidence: "none" as const,
      };
    }
    const { low, high } = wilson(latest.mentions, latest.promptsAsked);
    return {
      platform,
      rate: latest.mentions / latest.promptsAsked,
      low,
      high,
      basedOn: latest.promptsAsked,
      confidence: confidenceFor(latest.mentions, latest.promptsAsked),
    };
  });

  const direction = readDirection(grouped);

  return {
    current,
    direction,
    doesNotClaim:
      "This is the share of prompts we asked in which your brand was named. " +
      "It is not a market share, and it is not a ranking. " +
      "We cannot observe what makes a model mention a brand, so nothing here " +
      "predicts whether the rate will rise.",
  };
}

/**
 * A per-week slope, when the history is long enough to have one.
 *
 * Least squares on the rate per week, and **only after a floor check**. The floor
 * matters more than the arithmetic: a line through six points of noise has a
 * slope, a confidence interval, and an R², and none of the three make it real.
 */
function readDirection(
  grouped: Map<string, VisibilityObservation[]>,
): VisibilityForecast["direction"] {
  const weeks = countDistinctWeeks(grouped);
  if (weeks < MIN_PROMPTS_FOR_DIRECTION) {
    return {
      perWeek: null,
      basedOnWeeks: weeks,
      confidence: "none",
      reading:
        weeks === 0
          ? "Nothing has been measured yet, so there is no direction to report."
          : `Only ${weeks} week${weeks === 1 ? "" : "s"} of history. ` +
            `We need ${MIN_PROMPTS_FOR_DIRECTION} before a weekly change means ` +
            `anything more than sampling noise, and we would rather say so than ` +
            `draw a line through it.`,
    };
  }

  const perWeek = slopeAcrossWeeks(grouped);
  if (perWeek === null) {
    return {
      perWeek: null,
      basedOnWeeks: weeks,
      confidence: "low",
      reading:
        "There is history, but no platform produced a usable rate in enough of " +
        "it, so no direction is reported.",
    };
  }

  return {
    perWeek,
    basedOnWeeks: weeks,
    confidence: weeks >= 16 ? "moderate" : "low",
    reading:
      `Across ${weeks} weeks the share moved ${formatSigned(perWeek)} per week. ` +
      `That is the trend we have measured, not a prediction — and a change in ` +
      `how many prompts we ask will move this number without anything about the ` +
      `brand changing at all.`,
  };
}

/**
 * Distinct **weeks** represented across all platforms.
 *
 * Counting *dates* is the obvious implementation and it is wrong, because the
 * patrol runs more than once a week: two runs on the same Tuesday would count
 * as two weeks of history, so a project patrolled daily would reach the
 * "enough history" floor in four days and be told it has eight weeks. **The floor
 * exists to mean weeks, so it is computed in weeks.**
 *
 * Bucketed to the Monday of each week in UTC, which is the same boundary the
 * weekly series elsewhere in the product use, so a week here is a week
 * everywhere.
 */
function countDistinctWeeks(
  grouped: Map<string, VisibilityObservation[]>,
): number {
  const weeks = new Set<string>();
  for (const rows of grouped.values()) {
    for (const row of rows) weeks.add(weekStartOf(row.date));
  }
  return weeks.size;
}

/** The Monday of the week containing `iso`, as an ISO date. */
function weekStartOf(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    // An unreadable date is not a week we can claim. Bucketing broken rows into
    // a shared bucket would let several of them masquerade as several weeks.
    return `unreadable:${iso}`;
  }
  const day = parsed.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  parsed.setUTCDate(parsed.getUTCDate() - offset);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Mean of the per-platform weekly slopes.
 *
 * Pooled per platform rather than across all prompts, because a platform with
 * 400 prompts would otherwise drown one with 20 and the aggregate would move
 * entirely on the larger denominator.
 */
function slopeAcrossWeeks(
  grouped: Map<string, VisibilityObservation[]>,
): number | null {
  const slopes: number[] = [];
  for (const rows of grouped.values()) {
    // A month with no denominator contributes no point. Filtering it here rather
    // than dividing by `null` is what keeps a stored series out of the slope
    // arithmetic entirely, instead of contributing an infinite point that
    // quietly drags the average to infinity.
    const points = rows
      .filter(
        (r): r is typeof r & { promptsAsked: number } =>
          r.promptsAsked !== null && r.promptsAsked > 0,
      )
      .map((r, index) => ({ x: index, y: r.mentions / r.promptsAsked }));
    if (points.length < 2) continue;
    const n = points.length;
    const sumX = points.reduce((acc, p) => acc + p.x, 0);
    const sumY = points.reduce((acc, p) => acc + p.y, 0);
    const sumXY = points.reduce((acc, p) => acc + p.x * p.y, 0);
    const sumXX = points.reduce((acc, p) => acc + p.x * p.x, 0);
    const denominator = n * sumXX - sumX * sumX;
    // A flat series has `denominator === 0` when every x is equal, which is the
    // single-point case, and a division there is the one that would produce
    // `NaN` and ship it to a chart.
    if (denominator === 0) continue;
    slopes.push((n * sumXY - sumX * sumY) / denominator);
  }
  if (slopes.length === 0) return null;
  return slopes.reduce((a, b) => a + b, 0) / slopes.length;
}

function formatSigned(value: number): string {
  const percent = value * 100;
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded} points`;
}
