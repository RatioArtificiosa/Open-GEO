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
  domain,
  platform,
}: {
  domain: string;
  platform: GeoPlatform;
}) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["geoVisibilityForecast", domain, platform],
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
