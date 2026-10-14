import { forecastAccuracy } from "@/server/features/geo/services/forecastAccuracy";
import { ForecastSnapshotsRepository } from "@/server/features/geo/repositories/ForecastSnapshotsRepository";
import { forecastVisibility } from "@/server/features/geo/services/visibilityForecast";
import { FORECAST_KINDS } from "@/server/features/geo/services/forecastSnapshot";
import { readForecastInput } from "@/server/features/geo/services/visibilityForecastReads";

/**
 * The forecast scoreboard: what we predicted, and what was measured.
 *
 * ## Why this is a separate module from the sweep
 *
 * The sweep writes; this reads. They share a table and a clock and nothing else,
 * and keeping them apart is the point: **a writer that also read its own rows back
 * on the same request would score a forecast it had just written against the same
 * archive that produced it**, which is the comparison that always agrees. The read
 * is deliberately a separate call the panel makes, on a separate day, against a
 * different measurement.
 *
 * ## Why the actual is measured, not re-forecast
 *
 * "Actual" means the **measured share today** — `forecastVisibility`'s current rate,
 * the same number the panel shows as the level. Not the latest stored forecast: a
 * forecast scored against a forecast is a tautology, and the whole reason the rows
 * are append-only is that one of them can be compared with a *measurement* that
 * happened later.
 *
 * ## Why the horizon under test is the one the snapshot took
 *
 * A row that took a 90-day horizon is scored at 90 days. Scoring it at 30 because
 * the reader opened the panel on day 30 would be scoring a projection it never made,
 * and the result would be a permanent "miss" that says nothing — the specific
 * failure `too-early` exists to refuse.
 */

/**
 * How many nights of history the scoreboard reads per platform.
 *
 * Bounded, and generously: a projection re-states itself nightly, so without a bound
 * this query would read a quarter's worth of identical rows to score the same claim.
 * 200 is about half a year of nights — long enough that the newest *eligible* row is
 * always in the window even for the longest horizon this product uses — and short
 * enough that the read is one index range.
 */
const HISTORY_LIMIT = 200;

/** One row of the scoreboard, as the panel renders it. */
type ForecastAccuracyRow = {
  subject: string;
  kind: string;
  /** When the forecast under test was made. */
  issuedOn: string;
  horizonDays: number;
  predictedShareBp: number | null;
  actualShareBp: number | null;
  errorBp: number | null;
  withinInterval: boolean | null;
  verdict: string;
  summary: string;
  /** When this row's forecast is next scorable, or null when it already is. */
  scorableOn: string | null;
};

/**
 * The scoreboard for one brand's projections on every platform it runs on.
 *
 * One row per platform, newest first is the *caller's* concern: this returns them
 * in a defined order — by horizon remaining, so the ones already scorable lead and
 * the ones still waiting follow — because a panel that interleaved them would show
 * a reader a mixture of verdicts and "too early" with nothing saying which is which.
 */
export async function readForecastAccuracy(input: {
  projectId: string;
  domain: string;
  /** `YYYY-MM-DD`, the day the measurement is taken. Passed in, never read here. */
  today: string;
  /**
   * The platforms to score, and it may be **empty or absent**.
   *
   * Optional and defaulted, because the read path is called from a surface that
   * validates its input after the handler runs — the GEO server-function test calls
   * every entry point with an empty body to prove `projectId` is never taken from
   * it, and a reader that threw on a missing field would fail that test by
   * crashing rather than by leaking an id. An absent list is an empty scoreboard
   * with a reason, which is also the honest answer: nothing was asked for.
   */
  platforms?: string[];
  /** Only score a row once its own horizon has elapsed, which is the default. */
  includePending?: boolean;
}): Promise<{
  rows: ForecastAccuracyRow[];
  /** The pace row the panel's headline projection comes from, when there is one. */
  projected: {
    subject: string;
    shareBp: number | null;
    horizonDays: number;
  } | null;
  /** Why there is no scoreboard, when there is none. */
  emptyReason: string | null;
}> {
  const rows: ForecastAccuracyRow[] = [];
  let projected: {
    subject: string;
    shareBp: number | null;
    horizonDays: number;
  } | null = null;

  const platforms = input.platforms ?? [];

  if (platforms.length === 0) {
    return {
      rows,
      projected,
      emptyReason:
        "This brand has no measured runs on any platform yet, so there is nothing to " +
        "forecast and nothing to score.",
    };
  }
  // The measured share today, per platform, read once for the whole scoreboard.
  //
  // One read rather than one per snapshot: the *actual* is a property of the
  // archive, not of the forecast being scored, and reading it per row would let two
  // rows on the same panel disagree about what "now" means if the archive changed
  // between them — which is the exact bug class the scoreboard exists to prevent.
  const measured = new Map<string, number | null>();
  for (const platform of platforms) {
    try {
      const series = await readForecastInput({
        projectId: input.projectId,
        domain: input.domain,
        platform,
      });
      const forecast = forecastVisibility(series.observations);
      const reading = forecast.current.find((row) => row.platform === platform);
      measured.set(platform, reading?.rate ?? null);
    } catch {
      // A platform whose series cannot be read is **unmeasured**, not a zero. The
      // map keeps the key with a null so the scoreboard says "could not measure"
      // rather than dropping the platform and silently shrinking the panel.
      measured.set(platform, null);
    }
  }

  for (const platform of platforms) {
    const actual = measured.get(platform) ?? null;

    /**
     * The history, not the newest row, and the selection happens here.
     *
     * `asOfFor` returns the newest row on or before the day being scored, which is
     * the right question for *"what were we saying then"* and the wrong one here:
     * a 90-day projection written last night is newer than the 90-day-old one whose
     * horizon has closed, and scoring the newer one would refuse every platform
     * that was captured recently. So the rows come back whole and the one under
     * test is chosen by **horizon eligibility**, newest first.
     */
    const history = await ForecastSnapshotsRepository.historyFor({
      projectId: input.projectId,
      kind: FORECAST_KINDS.visibilityPace,
      subject: platform,
      limit: HISTORY_LIMIT,
    });

    const scorable = history.filter((row) => hasElapsed(row, input.today));
    const pending = history.filter((row) => !hasElapsed(row, input.today));

    // Newest horizon-eligible row. Older eligible rows are deliberately not scored:
    // a platform restates the same projection every night, and scoring all of them
    // would report one opinion twenty times as twenty forecasts.
    const snapshot = scorable.at(-1) ?? null;

    if (snapshot !== null) {
      const scored = forecastAccuracy({ snapshot, actual, today: input.today });
      rows.push({
        subject: snapshot.subject,
        kind: snapshot.kind,
        issuedOn: snapshot.issuedOn,
        horizonDays: snapshot.horizonDays,
        predictedShareBp: snapshot.shareBp,
        actualShareBp: scored.actualShareBp,
        errorBp: scored.errorBp,
        withinInterval: scored.withinInterval,
        verdict: scored.verdict,
        summary: scored.summary,
        scorableOn: null,
      });
    }

    // The pending rows are withheld unless asked for, because a scoreboard whose
    // first row is "not yet" teaches a reader to stop reading.
    if (input.includePending === true) {
      for (const row of pending) {
        const scored = forecastAccuracy({
          snapshot: row,
          actual,
          today: input.today,
        });
        rows.push({
          subject: row.subject,
          kind: row.kind,
          issuedOn: row.issuedOn,
          horizonDays: row.horizonDays,
          predictedShareBp: row.shareBp,
          actualShareBp: scored.actualShareBp,
          errorBp: scored.errorBp,
          withinInterval: scored.withinInterval,
          verdict: scored.verdict,
          summary: scored.summary,
          // "Not yet" is a **date**, not a shrug: the day this row becomes scorable
          // is arithmetic on its own issue date and horizon.
          scorableOn: addDays(row.issuedOn, row.horizonDays),
        });
      }
    }
  }

  // The headline projection is the newest one written, whether or not it is due:
  // a panel that shows today's projection is not claiming to have scored it. Read
  // from the platform with the most history, because that is the one the reader is
  // looking at, and the sweep writes one row per platform per night so the newest
  // row is the standing projection.
  const headlinePlatform = platforms[0];
  if (headlinePlatform !== undefined) {
    const current = await ForecastSnapshotsRepository.latestFor({
      projectId: input.projectId,
      kind: FORECAST_KINDS.visibilityPace,
      subject: headlinePlatform,
    });
    if (current !== null) {
      projected = {
        subject: current.subject,
        shareBp: current.shareBp,
        horizonDays: current.horizonDays,
      };
    }
  }

  // The reason is given when the *scoreboard* is empty, whether or not a headline
  // projection exists. Suppressing it because a projection is available would leave
  // a reader looking at "at this pace you reach 34%" with no way to tell whether it
  // had been checked — and "not yet scored" is exactly the sentence they need.
  if (rows.length === 0) {
    return { rows, projected, emptyReason: EMPTY_REASON };
  }

  // Newest horizon first is wrong here: the rows that are *already scorable* are
  // the informative ones, and the ones still waiting are context. Ordered by
  // whether they have elapsed, then by the date they were made.
  rows.sort((a, b) => {
    const aPending = a.verdict === "too-early" ? 1 : 0;
    const bPending = b.verdict === "too-early" ? 1 : 0;
    if (aPending !== bPending) return aPending - bPending;
    return b.issuedOn.localeCompare(a.issuedOn);
  });

  return { rows, projected, emptyReason: null };
}

const EMPTY_REASON =
  "No forecast is old enough to score yet. This panel fills in as the nights pass: " +
  "each projection is scored once its own horizon has elapsed, because scoring one " +
  "early always reads as a miss.";

/**
 * `YYYY-MM-DD` plus whole days.
 *
 * Date arithmetic on strings, through `Date`, because the column is text and the
 * two have to agree. `Math.round` on the day difference: a DST shift is one hour,
 * and an unrounded difference would land a scorable date an hour off and then a day
 * early.
 */
function addDays(iso: string, days: number): string {
  const start = Date.parse(`${iso}T00:00:00Z`);
  return new Date(start + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Has a row's own horizon elapsed by `today`?
 *
 * Compared as **dates the module owns**, not as a database range: the horizon is
 * part of the row's claim, so the row that says "90 days" is the row that decides
 * when it can be scored. A `lte(issuedOn, today)` filter alone cannot express this
 * and would score a two-day-old 90-day projection as missing.
 */
function hasElapsed(
  row: { issuedOn: string; horizonDays: number },
  today: string,
): boolean {
  const start = Date.parse(`${row.issuedOn}T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return end - start >= row.horizonDays * 86_400_000;
}
