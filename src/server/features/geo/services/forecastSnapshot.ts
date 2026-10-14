/**
 * Turning a forecast into a dated row.
 *
 * ## Why a forecast has to be written down to be worth anything
 *
 * Every forecast in this product used to be computed inside a request and thrown
 * away with the response. That is not merely wasteful — it is **unfalsifiable**. A
 * forecast recomputed from today's history cannot be wrong, and a forecast that
 * cannot be wrong is decoration: it agrees with the dashboard by construction, so
 * the agreement carries no information.
 *
 * So the row is the product. {@link FORECAST_MODEL_VERSION} stamps which model made
 * it, `issuedOn` stamps the day it was made, and nothing ever updates a row — a
 * second run on the same night collides on the unique key and is ignored, and a run
 * on a later night appends. That gives the one comparison this feature exists to
 * enable: **what we said on day D against what was true on day D + horizon**, which
 * is `forecastAccuracy.ts`'s job and lives there because it is a different concern
 * with a different clock.
 *
 * ## Why basis points, and why the interval is never half-stored
 *
 * Shares are stored as 0–10000 integers. A float is a number that differs in the
 * seventeenth digit between SQLite and Postgres, and accuracy is a subtraction —
 * the one operation where that difference stops being invisible. `lowBp` and
 * `highBp` are null **together** with `shareBp`, because a point
 * estimate with no interval is a claim of certainty this product does not make, and
 * storing a half-interval would let a reader average a bound that was never
 * measured.
 *
 * ## What a null means, in every column
 *
 * The same rule the rest of the schema takes: **null is "we did not measure it",
 * never "it is zero".** A module that declined to forecast — too little history, no
 * denominator, a sample under the floor — still produced a measurement, and that
 * measurement is its refusal. It is stored as a row with nulls and a note, because
 * dropping it would make "we cannot forecast yet" indistinguishable from "the job
 * did not run", and the second reading is the one that gets debugged for a week.
 */

/**
 * Turning a forecast into a dated row, and a dated row into a score.
 *
 * ## Why a forecast has to be written down to be worth anything
 *
 * Every forecast in this product used to be computed inside a request and thrown
 * away with the response. That is not merely wasteful — it is **unfalsifiable**. A
 * forecast recomputed from today's history cannot be wrong, and a forecast that
 * cannot be wrong is decoration: it agrees with the dashboard by construction, so
 * the agreement carries no information.
 *
 * So the row is the product. {@link FORECAST_MODEL_VERSION} stamps which model made
 * it, `issuedOn` stamps the day it was made, and nothing ever updates a row — a
 * second run on the same night collides on the unique key and is ignored, and a run
 * on a later night appends. That gives the one comparison this feature exists to
 * enable: **what we said on day D against what was true on day D + horizon**, which
 * is {@link forecastAccuracy}.
 *
 * ## Why basis points, and why the interval is never half-stored
 *
 * Shares are stored as 0–10000 integers. A float is a number that differs in the
 * seventeenth digit between SQLite and Postgres, and accuracy is a subtraction —
 * the one operation where that difference stops being invisible. `lowBp` and
 * `highBp` are null **together** with `shareBp`, because a point
 * estimate with no interval is a claim of certainty this product does not make, and
 * storing a half-interval would let a reader average a bound that was never
 * measured.
 *
 * ## What a null means, in every column
 *
 * The same rule the rest of the schema takes: **null is "we did not measure it",
 * never "it is zero".** A module that declined to forecast — too little history, no
 * denominator, a sample under the floor — still produced a measurement, and that
 * measurement is its refusal. It is stored as a row with nulls and a note, because
 * dropping it would make "we cannot forecast yet" indistinguishable from "the job
 * did not run", and the second reading is the one that gets debugged for a week.
 */

/**
 * The model version stamped on every row this product writes.
 *
 * One constant, deliberately: a version that lives in the writer is a version a
 * bump actually changes, and every row written under an older one stays readable as
 * history because the version is in the unique key. `v1` is the honest number —
 * `forecastVisibility`, `visibilityPace` and `citationWinProbability` are the three
 * engines this version composes, and none of them has changed its estimator since
 * it shipped.
 */
export const FORECAST_MODEL_VERSION = "forecast-v1";

/** The three kinds this table stores. One string each, matching the `kind` column. */
export const FORECAST_KINDS = {
  /** `forecastVisibility`'s per-platform reading: rate now, interval, weekly change. */
  visibilityForecast: "visibility_forecast",
  /** `projectVisibilityPace`'s projection: share after the horizon at the measured pace. */
  visibilityPace: "visibility_pace",
  /** `citationWinProbability`'s base rate with its interval, bounded by readiness. */
  citationWin: "citation_win",
} as const;

export type ForecastKind = (typeof FORECAST_KINDS)[keyof typeof FORECAST_KINDS];

/**
 * Narrow a stored `kind` string to the vocabulary, or refuse it.
 *
 * The column is plain `text` on both dialects — an enum column would emit a CHECK
 * constraint on Postgres and none on SQLite, which is exactly the asymmetry
 * `schema-parity.test.ts` exists to catch — so the narrowing happens here, at the
 * boundary, where an unknown value can be named. **A cast would have been the
 * shorter code and the wrong code**: a row written by a future version of this
 * product would flow silently into today's reads and produce a panel showing
 * nothing, with no error anywhere.
 */
export function asForecastKind(value: string): ForecastKind {
  for (const kind of Object.values(FORECAST_KINDS)) {
    if (kind === value) return kind;
  }
  throw new Error(
    `Unknown forecast kind "${value}". This build knows ${Object.values(FORECAST_KINDS).join(", ")}; ` +
      "a row written by a newer model is not readable by this one, which is what the model version column is for.",
  );
}

/** A snapshot row, ready for the repository's insert. */
export type ForecastSnapshotRow = {
  projectId: string;
  kind: ForecastKind;
  subject: string;
  modelVersion: string;
  /** `YYYY-MM-DD`. The date, not the timestamp — a forecast is dated to the day. */
  issuedOn: string;
  horizonDays: number;
  shareBp: number | null;
  lowBp: number | null;
  highBp: number | null;
  perWeekBp: number | null;
  nowBp: number | null;
  basedOn: number;
  basedOnWeeks: number | null;
  confidence: string | null;
  note: string | null;
};

/**
 * A fraction to basis points. The caller has already established it is a number.
 *
 * Exported because the accuracy read scores by subtracting two of these, and two
 * copies of the rounding rule is a rounding rule that drifts. `Math.round` is the
 * whole rule: half-up, so 0.00005 becomes 1 and a stored share and its re-read
 * never disagree by an off-by-one.
 */
export function toBp(value: number): number {
  return Math.round(value * 10000);
}

/** The same, for a fraction that may be null. Null in, null out — never zero. */
export function maybeBp(value: number | null): number | null {
  // Null first: `null * 10000` is `0` in JavaScript, which would turn "we did not
  // measure this" into "we measured it at exactly zero" — the specific lie this
  // codebase refuses everywhere else, one column at a time.
  return value === null ? null : toBp(value);
}

/**
 * The shared shape of every builder: the numbers the engines already decided.
 *
 * Taking engines' *outputs* rather than their inputs is what keeps this module
 * pure. A builder that re-derived a rate from raw observations would be a second
 * implementation of `forecastVisibility`, and two implementations of one estimator
 * is how a chart and a table end up disagreeing about the same night.
 */
type SnapshotNumbers = {
  projectId: string;
  issuedOn: string;
  /** The platform, or the target domain for a citation win. */
  subject: string;
  /**
   * The share this row is about, 0–1: the projection after the horizon for the
   * pace and citation kinds, the reading itself for the anchor. Null when the
   * engine declined — which is a measurement, not a gap.
   */
  share: number | null;
  low: number | null;
  high: number | null;
  perWeek: number | null;
  /** The share at the moment of issue, 0–1. Null when the kind has no level. */
  now: number | null;
  basedOn: number;
  basedOnWeeks: number | null;
  confidence: string | null;
  note: string | null;
};

function snapshotOf(
  kind: ForecastKind,
  horizonDays: number,
  input: SnapshotNumbers,
): ForecastSnapshotRow {
  return {
    projectId: input.projectId,
    kind,
    subject: input.subject,
    modelVersion: FORECAST_MODEL_VERSION,
    issuedOn: input.issuedOn,
    horizonDays,
    shareBp: maybeBp(input.share),
    lowBp: maybeBp(input.low),
    highBp: maybeBp(input.high),
    perWeekBp: maybeBp(input.perWeek),
    nowBp: maybeBp(input.now),
    basedOn: input.basedOn,
    basedOnWeeks: input.basedOnWeeks,
    confidence: input.confidence,
    note: input.note,
  };
}

/**
 * The `visibility_forecast` row: the reading as it stands tonight.
 *
 * This is the *anchor*, not the projection — it records the share the forecast was
 * made from and the interval it was quoted with, because an accuracy score computed
 * against a re-read "current" value would silently compare a prediction with a
 * moving target. Its horizon is **0 by design**, and a zero-horizon row is not
 * scorable: see {@link forecastAccuracy}. The projection this table exists to score
 * is `visibility_pace`'s.
 */
export function visibilityForecastSnapshot(
  input: SnapshotNumbers,
): ForecastSnapshotRow {
  return snapshotOf(FORECAST_KINDS.visibilityForecast, 0, input);
}

/**
 * The `visibility_pace` row: what the measured pace implies after the horizon.
 *
 * `horizonDays` is carried rather than defaulted here because the pace sentence
 * names its band, and a row that lost the band would be unreadable against a later
 * row written with a different one.
 */
export function visibilityPaceSnapshot(
  input: SnapshotNumbers & { horizonDays: number },
): ForecastSnapshotRow {
  return snapshotOf(FORECAST_KINDS.visibilityPace, input.horizonDays, input);
}

/**
 * The `citation_win` row: the base rate the archive measured, bounded by readiness.
 *
 * `subject` is the target **domain**, and `basedOn` is the number of retrieved pages
 * — the denominator the rate actually rests on. `perWeek` is null: a win rate has no
 * pace, and a pace this module does not measure is a number it must not invent.
 *
 * `horizonDays` is the **trailing window the base rate was measured over**, and it
 * is what makes the row scorable: after another window of the same length has
 * passed, the next window's measured rate is the thing to compare it against. The
 * window is stated rather than implied, because a rate quoted without its window is
 * a number nobody can check.
 */
export function citationWinSnapshot(
  input: SnapshotNumbers & { horizonDays: number },
): ForecastSnapshotRow {
  return snapshotOf(FORECAST_KINDS.citationWin, input.horizonDays, input);
}
