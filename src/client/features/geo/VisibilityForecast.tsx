import { useQuery } from "@tanstack/react-query";
import { getGeoVisibilityForecast } from "@/serverFunctions/geo";
import { GEO_QUERY_STALE_TIME_MS } from "./useGeoPageData";
import { GEO_PLATFORM_LABELS, type GEO_PLATFORMS } from "@/types/schemas/geo";

type GeoPlatform = (typeof GEO_PLATFORMS)[number];

/**
 * The visibility forecast, with the sample size as the headline.
 *
 * ## Why "based on N prompts" comes before the percentage
 *
 * A mention rate is `mentions / asked`, and **the denominator is what makes it
 * readable.** Four mentions out of eight prompts and four out of four hundred are
 * the same sentence and completely different facts — the first is a run too
 * small to have meant anything. Leading with the percentage hides precisely that,
 * and the interval CL-501 computes exists so the difference is visible.
 *
 * So the sample renders first, the rate second, the interval third.
 *
 * ## The refusal is the common case, and it is styled as content
 *
 * Most runs today come from the Live path, which **cannot know its own
 * denominator** — the vendor picks the prompts and never discloses how many. So
 * the most likely state of this panel is "we cannot tell you yet", and it is
 * written as a sentence a reader can act on. A panel that renders nothing reads
 * as a broken product; one that says why reads as a measurement that has not
 * happened yet.
 *
 * ## It goes through a server function, not a service import
 *
 * The first version called `forecastForStoredSeries` directly from the client
 * component. That would have worked and been wrong twice over: the reader takes
 * a `projectId`, so a direct call trusts the id from the browser, and it bypasses
 * `requireProjectContext`. Every other GEO panel here goes through
 * `serverFunctions/geo`, where the project comes from the authorized context and
 * is never read from the request body.
 */
export function VisibilityForecast({
  projectId,
  domain,
  platform,
}: {
  projectId: string;
  domain: string;
  platform: GeoPlatform;
}) {
  const { data, isPending, isError, error } = useQuery({
    // **`projectId` is part of the key, and it has to be.** The server function
    // takes the project from the authorized context rather than the request, so
    // the response depends on which project the user is looking at — while the key
    // this replaces was `[name, domain, platform]`. One brand can be monitored
    // under several projects, so opening project A and then project B with the
    // same domain served **project A's cached forecast inside project B** for up to
    // five minutes.
    //
    // Every other GEO query in `useGeoPageData.ts` already includes `projectId` for
    // the same reason; this one panel was written without it. The number is wrong
    // in a way nothing on the page can reveal, because the panel renders, the
    // numbers are plausible, and there is no error anywhere.
    queryKey: ["geoVisibilityForecast", projectId, domain, platform],
    queryFn: () => getGeoVisibilityForecast({ data: { domain, platform } }),
    // The same five minutes every other GEO read uses, and for the same reason:
    // a forecast is derived from runs that arrive **nightly**, so refetching it
    // on every mount cannot produce fresher data — it can only spend two more
    // round trips per platform to return the identical numbers. Without this the
    // panel is the one query on the page that refetches on every navigation.
    staleTime: GEO_QUERY_STALE_TIME_MS,
  });

  if (isPending) {
    return (
      <section className="rounded-lg border border-base-content/10 p-4">
        <h2 className="text-base font-semibold">Visibility forecast</h2>
        <p className="mt-2 text-sm text-base-content/70">Loading forecast</p>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="rounded-lg border border-base-content/10 p-4">
        <h2 className="text-base font-semibold">Visibility forecast</h2>
        <p className="mt-2 text-sm text-base-content/70">
          This panel could not be read. That is a fault here, not a statement
          about your visibility.
        </p>
        <p className="mt-1 text-xs text-base-content/50">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </section>
    );
  }

  const { series, forecast } = data;
  const current = forecast.current[0];
  const skipped =
    series.skipped.unknownDenominator +
    series.skipped.noText +
    series.skipped.noAnswers;

  return (
    <section className="rounded-lg border border-base-content/10 p-4">
      <h2 className="text-base font-semibold">Visibility forecast</h2>

      {current && current.basedOn > 0 && current.rate !== null ? (
        <div className="mt-3 space-y-1">
          <p className="text-sm text-base-content/70">
            Based on{" "}
            <span className="font-medium text-base-content">
              {current.basedOn} prompts
            </span>{" "}
            asked about {series.domain} on {GEO_PLATFORM_LABELS[platform]}.
          </p>
          <p className="text-2xl font-semibold">
            {Math.round(current.rate * 100)}%
          </p>
          {current.low !== null && current.high !== null ? (
            <p className="text-xs text-base-content/60">
              Between {Math.round(current.low * 100)}% and{" "}
              {Math.round(current.high * 100)}%. That spread is the measurement,
              not decoration.
            </p>
          ) : null}
          {current.confidence !== "high" ? (
            <p className="text-xs text-base-content/60">
              Confidence: {current.confidence}.{" "}
              {current.confidence === "none"
                ? "Too few prompts for a rate to mean anything yet."
                : "More runs will narrow this."}
            </p>
          ) : null}
        </div>
      ) : (
        // The refusal is the reader's sentence, not this panel's. It used to be
        // written here as well, which meant two texts to keep in step — and the
        // short one here, "no run yet has recorded how many prompts it asked",
        // blamed the vendor and implied there was nothing to do. The server's
        // version names the queued path as ours to fix, because that is the
        // actionable half.
        <p className="mt-3 text-sm text-base-content/70">
          A mention rate is only meaningful with its sample size, so this panel
          will not show a percentage it cannot stand behind. The reason is
          below.
        </p>
      )}

      {series.note ? (
        <p className="mt-3 text-xs text-base-content/60">{series.note}</p>
      ) : null}

      {/**
       * The direction, and the reason there may not be one.
       *
       * **This block did not exist, and `direction` was computed server-side and
       * never rendered** — the same defect class the reachability gate hunts, one
       * layer in: both ends were present, so nothing was "unreachable", and the field
       * was simply dropped on the way to the screen.
       *
       * The consequence was specific and bad for exactly the customers this product
       * is for. A **queued** project produces one answer a week, so it cannot reach
       * the 8-week floor for months — and the panel rendered a current rate with no
       * direction and no explanation. A reader could reasonably conclude the trend
       * was flat, or that we had stopped watching. The server's `reading` already
       * said "we need 8 before a weekly change means anything more than sampling
       * noise, and we would rather say so than draw a line through it" — and nobody
       * was reading it.
       *
       * So the sentence is the reader's, verbatim, rather than a second one written
       * here. A refusal restated at the call site is two texts to keep in step, and
       * this repo has already been bitten by that: the panel's own short version
       * above blamed the vendor when the cause was ours.
       */}
      <div className="mt-3">
        <p className="text-xs font-medium text-base-content/70">Direction</p>
        {forecast.direction.perWeek === null ? (
          <p className="text-xs text-base-content/60">
            {forecast.direction.reading}
          </p>
        ) : (
          <>
            <p className="text-lg font-semibold">
              {forecast.direction.perWeek >= 0 ? "+" : ""}
              {Math.round(forecast.direction.perWeek * 100)} points per week
            </p>
            <p className="text-xs text-base-content/60">
              {forecast.direction.reading}
            </p>
          </>
        )}
      </div>

      <p className="mt-3 text-xs text-base-content/50">
        {forecast.doesNotClaim}
      </p>

      {skipped > 0 ? (
        <details className="mt-3 text-xs text-base-content/60">
          <summary className="cursor-pointer">
            Runs not included ({skipped})
          </summary>
          <ul className="mt-2 list-disc pl-5">
            {series.skipped.unknownDenominator > 0 ? (
              <li>
                {series.skipped.unknownDenominator} did not record how many
                prompts they asked. The live path cannot: the vendor picks the
                prompts and does not say how many.
              </li>
            ) : null}
            {series.skipped.noText > 0 ? (
              <li>
                {series.skipped.noText} had answers that have not come back yet.
                A run we have not read is not a run that found nothing.
              </li>
            ) : null}
            {series.skipped.noAnswers > 0 ? (
              <li>
                {series.skipped.noAnswers} archived no answer for{" "}
                {GEO_PLATFORM_LABELS[platform]}.
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
