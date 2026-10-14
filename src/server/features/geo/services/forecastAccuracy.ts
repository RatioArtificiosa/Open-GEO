import { maybeBp, toBp } from "./forecastSnapshot";
import type { ForecastKind } from "./forecastSnapshot";

/**
 * Scoring a stored forecast against what was actually measured.
 *
 * This is the half of CL-503 that makes the other half honest. A nightly job that
 * writes forecasts and never reads them back is a journal; the product sentence —
 * *"we predicted 34% and measured 38%, inside the interval we published"* — is only
 * sayable here, and it is the reason the rows are append-only in the first place.
 *
 * ## The three refusals, and why they are not politeness
 *
 * 1. **An anchor is not a projection.** `visibility_forecast` records the reading a
 *    forecast was made from, with a horizon of 0 because it claims nothing about the
 *    future. Scoring it would be scoring a fact, and the number it produced would
 *    look like accuracy while measuring nothing but drift.
 * 2. **The horizon must have elapsed.** A 90-day pace projection scored on day 3 is
 *    scored against three days of a slope that was quoted for ninety, and the
 *    resulting "error" is an artefact of asking early — and it always reads as a
 *    miss, because early measurements of a rising share sit below the projection.
 *    So it returns `too-early` rather than a number.
 * 3. **A missing measurement is not a zero.** `null` returns `unmeasured` with the
 *    reason, exactly as every other module here refuses to read absence as a value.
 */

/** A stored snapshot, as the accuracy read hands it over. */
type StoredSnapshot = {
  kind: ForecastKind;
  subject: string;
  issuedOn: string;
  horizonDays: number;
  shareBp: number | null;
  lowBp: number | null;
  highBp: number | null;
  perWeekBp: number | null;
  basedOn: number;
  confidence: string | null;
};

/** What the accuracy read concluded, in the words a reader acts on. */
type ForecastVerdict =
  /** The measurement landed inside the interval the forecast gave. */
  | "held"
  /** The measurement beat the projection's top of interval. */
  | "beat"
  /** The measurement fell below the projection's bottom of interval. */
  | "missed"
  /** The forecast declined, so there is nothing to score it against. */
  | "no-forecast"
  /** The horizon has not elapsed yet, so scoring now would score a half-step. */
  | "too-early"
  /** The measurement is still missing, which is not the same as zero. */
  | "unmeasured";

type ForecastAccuracy = {
  kind: ForecastKind;
  subject: string;
  issuedOn: string;
  horizonDays: number;
  /** What was predicted, in basis points. Null when the forecast declined. */
  shareBp: number | null;
  /** What was measured, in basis points. Null when it is still unmeasured. */
  actualShareBp: number | null;
  /** Actual − predicted, signed. Positive means the brand did better than predicted. */
  errorBp: number | null;
  /** Whether the measurement fell inside the interval the forecast published. */
  withinInterval: boolean | null;
  verdict: ForecastVerdict;
  basedOn: number;
  /** The sentence a reader sees. Never a bare number. */
  summary: string;
};

/** Days between two `YYYY-MM-DD` strings, as whole days. */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Score one stored forecast against what was measured on `today`.
 *
 * `today` is passed in rather than read: a clock inside a pure function is a test
 * that cannot fail, and the horizon rule is the part most worth testing. See the
 * module header for the three refusals, and the `verdict` block below for why
 * `held` is decided by the interval rather than by the point.
 */
export function forecastAccuracy(input: {
  snapshot: StoredSnapshot;
  /** The measured share today, 0–1, or null when it is still unmeasured. */
  actual: number | null;
  /** `YYYY-MM-DD`. The day the measurement was taken. */
  today: string;
}): ForecastAccuracy {
  const { snapshot, actual } = input;
  const elapsed = daysBetween(snapshot.issuedOn, input.today);
  const daysShort = Number.isNaN(elapsed)
    ? null
    : snapshot.horizonDays - elapsed;

  const base = {
    kind: snapshot.kind,
    subject: snapshot.subject,
    issuedOn: snapshot.issuedOn,
    horizonDays: snapshot.horizonDays,
    shareBp: snapshot.shareBp,
    basedOn: snapshot.basedOn,
  };

  // An anchor is not a projection. `visibility_forecast` records the reading a
  // forecast was made from, with a horizon of 0 because it claims nothing about the
  // future; scoring it against a later measurement would be scoring a fact rather
  // than a forecast, and the number it produced would look like accuracy while
  // measuring nothing but drift.
  if (snapshot.horizonDays <= 0) {
    return {
      ...base,
      actualShareBp: maybeBp(actual),
      errorBp: null,
      withinInterval: null,
      verdict: "no-forecast",
      summary:
        `The ${formatDate(snapshot.issuedOn)} row for ${snapshot.subject} records a reading, not a projection, ` +
        "so there is no horizon to score it against. The projection this table scores is the pace row.",
    };
  }

  // A forecast that declined is scored as a decline, not as a zero: the row exists
  // so a reader can see the job ran and said it could not, and the accuracy read
  // has to preserve that sentence rather than resolve it into a number.
  if (snapshot.shareBp === null) {
    return {
      ...base,
      actualShareBp: maybeBp(actual),
      errorBp: null,
      withinInterval: null,
      verdict: "no-forecast",
      summary:
        `The ${formatDate(snapshot.issuedOn)} forecast for ${snapshot.subject} declined to give a number, ` +
        "so there is nothing to score it against. That is a measurement of the history it had, not a failure.",
    };
  }

  if (daysShort !== null && daysShort > 0) {
    return {
      ...base,
      actualShareBp: maybeBp(actual),
      errorBp: null,
      withinInterval: null,
      verdict: "too-early",
      summary:
        `The ${formatDate(snapshot.issuedOn)} forecast for ${snapshot.subject} speaks over ${snapshot.horizonDays} days, ` +
        `and ${daysShort} of them have not happened yet. Scoring it now would compare a projection with a half-step.`,
    };
  }

  if (actual === null) {
    return {
      ...base,
      actualShareBp: null,
      errorBp: null,
      withinInterval: null,
      verdict: "unmeasured",
      summary:
        `The horizon for ${snapshot.subject} has passed, but no measurement has landed since. ` +
        "Nothing was measured, which is not the same as nothing was cited.",
    };
  }

  const actualBp = toBp(actual);
  const predicted = snapshot.shareBp;
  const errorBp = actualBp - predicted;

  /**
   * The interval, narrowed **by presence rather than by assertion**.
   *
   * The bounds are `number | null`, and `hasInterval` is the conjunction of the two
   * presence checks. Reading them straight out under that conjunction is what
   * narrows them here — a cast would narrow them too and would be a lie whenever
   * the conjunction and the read ever disagreed, which is exactly the kind of
   * disagreement a type assertion cannot detect. `interval` is `null` when either
   * bound is missing, so the reader has one value to ask about rather than two.
   */
  const hasInterval = snapshot.lowBp !== null && snapshot.highBp !== null;
  const interval =
    hasInterval && snapshot.lowBp !== null && snapshot.highBp !== null
      ? { low: snapshot.lowBp, high: snapshot.highBp }
      : null;

  const withinInterval =
    interval === null
      ? null
      : actualBp >= interval.low && actualBp <= interval.high;

  // Interval first, and only then the direction of the miss. A measurement inside
  // the interval is `held` even when it is below the point estimate — that is what
  // an interval is for.
  //
  // A forecast that published **no** interval gets no such shelter: with no bound
  // there is nothing to be inside of, so the deviation's sign is the only thing
  // that can be said. The one basis point of tolerance is not decoration — both
  // columns are rounded to basis points, so a share stored and then re-read can
  // differ by one without anything having happened, and calling that a miss would
  // be calling rounding a forecast failure.
  let verdict: ForecastVerdict = "held";
  if (withinInterval === false) {
    verdict = errorBp > 0 ? "beat" : "missed";
  } else if (withinInterval === null && Math.abs(errorBp) > 1) {
    verdict = errorBp > 0 ? "beat" : "missed";
  }

  const direction =
    errorBp === 0
      ? "exactly as predicted"
      : `${formatBp(Math.abs(errorBp))} ${errorBp > 0 ? "above" : "below"} what was predicted`;

  return {
    ...base,
    actualShareBp: actualBp,
    errorBp,
    withinInterval,
    verdict,
    summary:
      `Predicted ${formatBp(predicted)} on ${formatDate(snapshot.issuedOn)}; measured ${formatBp(actualBp)} ` +
      `after ${snapshot.horizonDays} days — ${direction}` +
      (interval === null
        ? ""
        : `, ${withinInterval ? "inside" : "outside"} the ${formatBp(interval.low)}–${formatBp(interval.high)} interval`) +
      `. The reading rests on ${snapshot.basedOn} measured unit${snapshot.basedOn === 1 ? "" : "s"}.`,
  };
}

function formatBp(value: number): string {
  return `${Math.round(value / 100)}%`;
}

function formatDate(iso: string): string {
  return iso;
}
