import { MIN_PROMPTS_FOR_DIRECTION } from "./visibilityForecast";

/**
 * Citation Win Probability — given what the archive measured, how likely is this
 * target to win a citation it does not have yet.
 *
 * ## Why this is a base rate and not a model
 *
 * The two shipped ingredients answer different questions. **CL-206's citation
 * gap** answers *which* pages were retrieved but not cited — a list. **CL-601's
 * readiness score** answers whether the target is technically quotable at all —
 * a verdict. Neither is a probability, and the gap between them is exactly where
 * a fabricated number would live.
 *
 * So the probability is a **measured base rate with its uncertainty**: of the
 * retrievals the archive holds, how many became citations. That is the only
 * learned quantity here, and it is reported with a Wilson interval because the
 * sample is usually small — the same reason `visibilityForecast` uses one, for
 * the same proportion-of-what-we-asked shape.
 *
 * ## What readiness does, and what it is not allowed to do
 *
 * **Readiness bounds the estimate, never inflates it.** A target whose audit has
 * outstanding fixes is quoted the *low* end of its own interval, with the reason
 * named: an unquotable page winning a citation is the case we have least evidence
 * for. A target whose checks completed is quoted the point estimate. Readiness
 * never moves a quoted number upward on its own — a modifier that flatters is
 * the modifier this product refuses, and a technical-cleanup checkbox raising a
 * probability is the exact shape of that.
 *
 * ## The three refusals
 *
 * 1. **A small sample declines.** Under the floor, a rate rests on a handful of
 *    rows and its interval spans most of its range; the answer says so rather
 *    than printing a percentage.
 * 2. **A retrieval-free answer is not a 0% answer.** "We retrieved nothing and
 *    cited nothing" is a measurement of the answer, not of the citation rate —
 *    the distinction `0`-is-not-`null` makes everywhere else in this product.
 * 3. **The gap list is the input, not the output.** A caller asking "which
 *    pages" should use the gap; this module turns the same rows into a rate, and
 *    a rate without the list is a number a reader cannot act on.
 */

/** A retrieval observation: a page the model looked at for one answer. */
export type RetrievalObservation = {
  /** True when the retrieved page was also cited. */
  cited: boolean;
};

/** How the target's readiness shaped the quoted number. */
export type ReadinessModifier =
  /** Checks incomplete: the low end of the interval is quoted. */
  | "capped-by-readiness"
  /** Checks complete: the point estimate stands. */
  | "readiness-complete"
  /** Readiness was not reported at all, so it did not shape the number. */
  | "readiness-unknown";

export type CitationWinProbability = {
  /** Cited ÷ retrieved over the window, or null when the sample is under the floor. */
  baseRate: number | null;
  /** The Wilson interval at 95%, null with the rate. */
  low: number | null;
  high: number | null;
  /** The number a caller may quote, or null when we decline. */
  probability: number | null;
  /** How many retrievals the rate rests on — the denominator, always named. */
  retrievalsObserved: number;
  /** How many of them were cited. */
  citationsObserved: number;
  readinessModifier: ReadinessModifier;
  /** The sentence a reader sees. */
  summary: string;
  /** What this number does not claim. */
  doesNotClaim: string;
};

/**
 * The floor on observations.
 *
 * The same floor `visibilityForecast` uses for a direction, imported rather
 * than restated: both are rates whose interval is dominated by the sample, and
 * a floor the two modules disagree about is a floor a reader cannot trust.
 */
const MIN_OBSERVATIONS = MIN_PROMPTS_FOR_DIRECTION;

/**
 * Read the win probability from the archive's rows.
 *
 * `retrievalsComplete` is the readiness ingredient: true when the target's
 * audit completed its checks, false when fixes are outstanding, and null when
 * no audit exists. Falsy and null are different states and are treated as
 * different states, because "we could not check" and "we checked and found
 * problems" are different sentences.
 */
export function citationWinProbability(input: {
  retrievals: RetrievalObservation[];
  /** The readiness ingredient: complete, outstanding, or unknown. */
  retrievalsComplete: boolean | null;
}): CitationWinProbability {
  const observed = input.retrievals.length;
  const cited = input.retrievals.filter((row) => row.cited).length;

  const doesNotClaim =
    "This is the share of retrieved pages this target won, measured over the " +
    "window you asked about. It is not the share of prompts where a citation was " +
    "available, and it is not a probability about a page we have not retrieved " +
    "yet — the rows behind it are the list to act on.";

  // **No retrievals is not a zero rate.** An answer with nothing retrieved is a
  // measurement of that answer, not of the citation rate, and a 0% here would
  // read as "never cited" when the truth is "never looked at".
  if (observed === 0) {
    return {
      baseRate: null,
      low: null,
      high: null,
      probability: null,
      retrievalsObserved: 0,
      citationsObserved: 0,
      readinessModifier: modifierOf(input.retrievalsComplete),
      summary:
        "No pages were retrieved in this window, so there is no rate to report. " +
        "Nothing was looked at, which is not the same as nothing was cited.",
      doesNotClaim,
    };
  }

  // A small sample declines: the interval below would span most of its range,
  // and a percentage quoted from it is arithmetic on noise.
  if (observed < MIN_OBSERVATIONS) {
    return {
      baseRate: null,
      low: null,
      high: null,
      probability: null,
      retrievalsObserved: observed,
      citationsObserved: cited,
      readinessModifier: modifierOf(input.retrievalsComplete),
      summary:
        `Only ${observed} retrieved page${observed === 1 ? "" : "s"} in this window, and ${MIN_OBSERVATIONS} ` +
        `are the floor for a rate that means anything. Of them, ${cited} were cited — that is the list to act on, not a percentage.`,
      doesNotClaim,
    };
  }

  const { low, high } = wilson(cited, observed);
  const rate = cited / observed;
  const modifier = modifierOf(input.retrievalsComplete);

  // **Readiness bounds, never inflates.** Outstanding fixes quote the low end;
  // completed checks quote the point estimate; an unknown audit changes nothing,
  // because inventing a penalty for a check we never ran is inventing evidence.
  const probability = modifier === "capped-by-readiness" ? low : rate;

  const readinessClause =
    modifier === "capped-by-readiness"
      ? " The audit still has outstanding fixes, so the low end of the interval is quoted rather than the point estimate — an unquotable page winning a citation is the case with the least evidence behind it."
      : modifier === "readiness-complete"
        ? " The audit's checks completed, so the point estimate stands."
        : "";

  return {
    baseRate: rate,
    low,
    high,
    probability,
    retrievalsObserved: observed,
    citationsObserved: cited,
    readinessModifier: modifier,
    summary:
      `Of ${observed} retrieved pages, ${cited} were cited — ${formatPercent(rate)} ` +
      `(Wilson 95%: ${formatPercent(low)}–${formatPercent(high)}).${readinessClause} ` +
      `A probability quoted from fewer than ${MIN_OBSERVATIONS} pages would be arithmetic on noise, which is the reason for the floor.`,
    doesNotClaim,
  };
}

function modifierOf(retrievalsComplete: boolean | null): ReadinessModifier {
  if (retrievalsComplete === null) return "readiness-unknown";
  return retrievalsComplete ? "readiness-complete" : "capped-by-readiness";
}

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

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
