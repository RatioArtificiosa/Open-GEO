import { useQuery } from "@tanstack/react-query";
import { getGeoForecastAccuracy } from "@/serverFunctions/geo";
import { GEO_QUERY_STALE_TIME_MS } from "./useGeoPageData";
import { GEO_PLATFORM_LABELS, type GEO_PLATFORMS } from "@/types/schemas/geo";

type GeoPlatform = (typeof GEO_PLATFORMS)[number];

/** One row of the scoreboard, as the reader sees it. */
type ForecastAccuracyRow = {
  subject: string;
  kind: string;
  issuedOn: string;
  horizonDays: number;
  predictedShareBp: number | null;
  actualShareBp: number | null;
  errorBp: number | null;
  withinInterval: boolean | null;
  verdict: string;
  summary: string;
  measuredOn: string | null;
  scorableOn: string | null;
};

/**
 * The forecast scoreboard: what we predicted, and what was measured.
 *
 * ## This is the panel the product exists to make possible
 *
 * Every other number in this product is a measurement of the present. This is the only
 * one that is a **claim that can be checked** — we predicted 34% on a date, we measured
 * 38% on a later one, and the row says which happened. The table, the nightly sweep, the
 * accuracy reader and the server function all shipped in `209c73c`; **nothing rendered
 * them**, so the only number in the product that proves it is honest about its own
 * predictions was reachable only from an endpoint no caller used.
 *
 * No competitor can offer this panel, because a forecast nobody keeps cannot be scored,
 * and a forecast that is recomputed from today's history agrees with today's dashboard
 * by construction. The scoreboard exists to show that ours does not.
 *
 * ## The three refusals are the content, not the error path
 *
 * An empty scoreboard says *"no forecast is old enough to score yet — this panel fills in
 * as the nights pass"*. A `no-forecast` row says the engine declined. An `unmeasured` row
 * says the archive has not been written since. **A panel that renders nothing reads as a
 * broken product; a panel that says why reads as a measurement that has not happened
 * yet** — the same rule `VisibilityForecast` follows, and the reason its comment block
 * reads the way it does.
 *
 * The refusal sentences come from the server, verbatim. A refusal restated at the call
 * site is two texts to keep in step, and this repository has been bitten by that exact
 * thing: `VisibilityForecast`'s own short sentence blamed the vendor when the cause was
 * ours.
 *
 * ## Truthful-by-construction, which is the whole design
 *
 * - **`projectId` is in the query key.** `VisibilityForecast` documents the bug that
 *   happens without it: project A's cached forecast served inside project B for five
 *   minutes, wrong in a way nothing on the page can reveal.
 * - **The measurement date is shown beside every score.** `measuredOn` travels with each
 *   row because the actual is computed from the stored archive, so a score can rest on a
 *   measurement older than the day it is read on — and a stale score that looks current
 *   is the failure that field exists to prevent.
 * - **`held` means inside the published interval, not near the point.** The panel says so
 *   in words, because a forecast quoting 34% ±20 that reports "held" at 15% is a forecast
 *   that never said anything.
 */
export function ForecastAccuracyScoreboard({
  projectId,
  domain,
  platforms,
}: {
  projectId: string;
  domain: string;
  platforms: GeoPlatform[];
}) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["geoForecastAccuracy", projectId, domain, platforms],
    queryFn: () =>
      getGeoForecastAccuracy({
        data: {
          domain,
          platforms,
          // Pending rows included on purpose: a scoreboard whose first row is "not yet"
          // would teach a reader to stop reading it, and the pending rows are what make
          // "this fills in over time" a claim rather than an excuse. They are rendered
          // below the scorable ones, which the reader sorts, not this panel.
          includePending: true,
        },
      }),
    staleTime: GEO_QUERY_STALE_TIME_MS,
  });

  if (isPending) {
    return (
      <section className="rounded-lg border border-base-content/10 p-4">
        <h2 className="text-base font-semibold">Forecast accuracy</h2>
        <p className="mt-2 text-sm text-base-content/70">
          Loading the scoreboard
        </p>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="rounded-lg border border-base-content/10 p-4">
        <h2 className="text-base font-semibold">Forecast accuracy</h2>
        <p className="mt-2 text-sm text-base-content/70">
          This panel could not be read. That is a fault here, not a statement
          about the forecasts.
        </p>
        <p className="mt-1 text-xs text-base-content/50">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </section>
    );
  }

  const { rows, projected, emptyReason } = data;

  return (
    <section className="rounded-lg border border-base-content/10 p-4">
      <h2 className="text-base font-semibold">Forecast accuracy</h2>
      <p className="mt-1 text-xs text-base-content/60">
        What we predicted, and what was measured. Each projection is scored once
        its own horizon has passed — scoring one early always reads as a miss,
        because a rising share sits below its own projection for most of the
        window.
      </p>

      {/*
        The headline projection, above the scoreboard rather than beside it.
        A scoreboard with no projection to explain is a list of old numbers; this is the
        live sentence the rows are scoring.
      */}
      {projected && projected.shareBp !== null ? (
        <p className="mt-3 text-sm text-base-content/70">
          Current projection for {labelFor(projected.subject)}:{" "}
          <span className="font-medium text-base-content">
            {formatBp(projected.shareBp)}
          </span>{" "}
          after {projected.horizonDays} days at the measured pace.
        </p>
      ) : null}

      {rows.length === 0 ? (
        // **The refusal, from the server.** This is the panel's most likely state
        // tonight and for weeks afterwards: the sweep writes one row per night and a
        // 90-day horizon is not 90 days old yet. It is written as content because
        // nothing here is broken — the sentence is a measurement of time.
        <p className="mt-3 text-sm text-base-content/70">
          {emptyReason ??
            "No forecast is old enough to score yet. This panel fills in as the nights pass."}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-base-content/10">
          {rows.map((row) => (
            <ScoreboardRow
              key={`${row.kind}:${row.subject}:${row.issuedOn}`}
              row={row}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One score: the prediction, the measurement, and the verdict.
 *
 * The interval rule is stated in the row rather than implied by the verdict, because a
 * reader who cannot see "inside the interval we published" beside "held" is being asked
 * to trust a word.
 */
function ScoreboardRow({ row }: { row: ForecastAccuracyRow }) {
  const pending = row.verdict === "too-early";

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          {formatDate(row.issuedOn)}
          {row.subject ? ` · ${labelFor(row.subject)}` : ""}
        </p>
        <VerdictBadge verdict={row.verdict} pending={pending} />
      </div>

      <p className="mt-1 text-sm text-base-content/80">{row.summary}</p>

      {/*
        The measurement's own date, and why it is here rather than in a tooltip.
        The actual is computed from the stored archive, so a row scored today can rest on
        a measurement taken last week — and a reader comparing a 90-day forecast against
        a 5-day-old measurement deserves to know that. `measuredOn` is the server's answer
        to "as of when", and hiding it would make a stale score look current.
      */}
      {row.measuredOn ? (
        <p className="mt-1 text-xs text-base-content/50">
          Measured as of {formatDate(row.measuredOn)}.
        </p>
      ) : null}

      {pending && row.scorableOn ? (
        <p className="mt-1 text-xs text-base-content/50">
          Becomes scorable on {formatDate(row.scorableOn)}.
        </p>
      ) : null}

      <table className="sr-only">
        <caption>Numbers behind the verdict</caption>
        <tbody>
          <tr>
            <th scope="row">Predicted</th>
            <td>{formatOptionalBp(row.predictedShareBp)}</td>
          </tr>
          <tr>
            <th scope="row">Measured</th>
            <td>{formatOptionalBp(row.actualShareBp)}</td>
          </tr>
          <tr>
            <th scope="row">Difference</th>
            <td>{formatOptionalBp(row.errorBp)}</td>
          </tr>
        </tbody>
      </table>
    </li>
  );
}

/**
 * The verdict, named rather than coloured.
 *
 * Colour alone would hide the three refusals among the two hits, and the refusals are
 * the majority on a young account. `no-forecast` and `unmeasured` are deliberately
 * quieter than the two real outcomes: a reader scanning the panel should find the
 * verdicts first and the absences second.
 */
function VerdictBadge({
  verdict,
  pending,
}: {
  verdict: string;
  pending: boolean;
}) {
  const base = "text-xs font-medium";

  if (pending) {
    return (
      <span className={`${base} text-base-content/50`}>
        Waiting for its horizon
      </span>
    );
  }

  switch (verdict) {
    case "held":
      return (
        <span className={`${base} text-success`}>
          Held — inside the interval we published
        </span>
      );
    case "beat":
      return <span className={`${base} text-success`}>Beat it</span>;
    case "missed":
      return <span className={`${base} text-warning`}>Missed it</span>;
    case "no-forecast":
      return (
        <span className={`${base} text-base-content/50`}>
          Declined to give a number
        </span>
      );
    case "unmeasured":
      return (
        <span className={`${base} text-base-content/50`}>
          Nothing measured since
        </span>
      );
    default:
      return null;
  }
}

/** `3400` → `34%`. The server already speaks in basis points. */
function formatBp(value: number): string {
  return `${Math.round(value / 100)}%`;
}

function formatOptionalBp(value: number | null): string {
  return value === null ? "not measured" : formatBp(value);
}

/**
 * A platform label, falling back to the raw subject.
 *
 * The fallback is not defensive noise: the scoreboard's subjects come from the stored
 * rows, and a platform recorded before a label existed would otherwise render as a
 * blank. Naming the raw value is honest; inventing a label is not.
 *
 * **Read through `Object.entries` rather than indexed with a cast.** The subject is a
 * `string` from the server, and `GEO_PLATFORM_LABELS[subject as GeoPlatform]` would have
 * been an assertion that the string is one of the platform keys — which the type-aware
 * lint refuses, correctly: a subject that is *not* a known key would then resolve to
 * `undefined` while claiming to be a valid label. Iterating the entries and comparing
 * values narrows each key inside the loop, so the fallback is the honest branch rather
 * than a hole in the type.
 */
function labelFor(subject: string): string {
  if (!subject) return "";
  for (const [key, label] of Object.entries(GEO_PLATFORM_LABELS)) {
    if (key === subject) return label;
  }
  return subject;
}

/** `2026-07-16` → `16 July 2026`, or the raw value if it does not parse. */
function formatDate(iso: string): string {
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
