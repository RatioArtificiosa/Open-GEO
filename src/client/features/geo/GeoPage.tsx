import { AlertTriangle, RefreshCw, SearchCheck } from "lucide-react";
import { GeoVisibilityPanel } from "./GeoVisibilityPanel";
import { useGeoPageData } from "./useGeoPageData";

/**
 * The GEO page: what AI systems actually say about this brand, kept over time.
 *
 * The layout follows the app's own rule that every report leads with the number
 * and ends with what to do. What makes it different from the SEO pages is what
 * it refuses to do: no single "AI visibility score", because the platforms
 * compute demand differently and a combined figure would look authoritative
 * while meaning nothing.
 */

export function GeoPage({ projectId }: { projectId: string }) {
  const data = useGeoPageData(projectId);

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">AI visibility</h1>
          <p className="text-sm text-base-content/70">
            What ChatGPT, Gemini, Perplexity and Google AI actually say about
            this brand — archived over time, one platform at a time.
            {data.freshness ? <> Last patrol {data.freshness}.</> : null}
          </p>
        </header>

        {data.isLoading ? <GeoLoadingState /> : null}
        {!data.isLoading && data.errorMessage ? (
          <GeoErrorState
            errorMessage={data.errorMessage}
            onRetry={data.refetch}
          />
        ) : null}

        {!data.isLoading && !data.errorMessage && !data.hasTarget ? (
          <GeoNoTargetState />
        ) : null}

        {data.hasTarget ? (
          <>
            <section aria-label="Visibility by platform">
              <h2 className="text-base font-semibold">
                Mentioned in AI answers
              </h2>
              <p className="text-sm text-base-content/70">
                Each platform is reported on its own. Google AI Overviews and
                ChatGPT compute demand differently, so these figures are never
                added together.
              </p>
              {data.perPlatform.length === 0 ? (
                <p className="text-sm text-base-content/60">
                  No archived answers yet. The first patrol runs overnight; the
                  archive fills from there.
                </p>
              ) : (
                <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {data.perPlatform.map((entry) => (
                    <li
                      key={entry.platform}
                      className="card border border-base-300 bg-base-100"
                    >
                      <div className="card-body gap-1 p-4">
                        <span className="text-base-content/60 text-xs">
                          {entry.platform}
                        </span>
                        <span
                          className="text-2xl font-semibold"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {entry.mentions.toLocaleString()}
                        </span>
                        <span className="text-base-content/60 text-xs">
                          archived answer{entry.mentions === 1 ? "" : "s"}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              aria-label="Citation gap"
              className="rounded-xl border border-base-300 bg-base-100 p-4"
            >
              <h2 className="text-base font-semibold">
                Retrieved but never cited
              </h2>
              {data.gap.available ? (
                <>
                  <p className="text-sm text-base-content/70">
                    These pages were read by the model and then passed over.
                    That is a directness problem, not a volume problem:
                    restructure the answer to lead with a direct response.
                  </p>
                  {data.gap.pages.length === 0 ? (
                    <p className="text-sm text-base-content/60">
                      Nothing in the gap. Every page the model retrieved, it
                      cited.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm">
                      {data.gap.pages.slice(0, 20).map((page) => (
                        <li key={page.url} className="truncate">
                          {page.url}
                        </li>
                      ))}
                      {data.gap.pages.length > 20 ? (
                        <li className="text-base-content/60">
                          …and {data.gap.pages.length - 20} more
                        </li>
                      ) : null}
                    </ul>
                  )}
                </>
              ) : (
                <p className="text-sm text-base-content/70">
                  {data.gap.reason ??
                    "This platform does not report which pages it retrieved, so the gap cannot be computed here."}{" "}
                  A confident empty list would claim your pages were never
                  retrieved, which is a different statement.
                </p>
              )}
            </section>

            <section className="rounded-xl border border-base-300 bg-base-100 p-4">
              <GeoVisibilityPanel series={{ points: data.etvPoints }} />
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function GeoLoadingState() {
  return (
    <div className="space-y-3" aria-busy>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="card border border-base-300 bg-base-100">
            <div className="card-body gap-3 p-4">
              <div className="skeleton h-3 w-24" />
              <div className="skeleton h-8 w-28" />
            </div>
          </div>
        ))}
      </div>
      <div className="skeleton h-32 w-full" />
    </div>
  );
}

function GeoErrorState({
  errorMessage,
  onRetry,
}: {
  errorMessage: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-error/30 bg-error/5 p-6">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-lg bg-error/10 p-2.5 text-error">
          <AlertTriangle className="size-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            Could not load AI visibility
          </h2>
          <p className="text-sm text-base-content/70">
            {errorMessage ?? "Please try again in a moment."}
          </p>
        </div>
      </div>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        <RefreshCw className="size-4" />
        Retry
      </button>
    </section>
  );
}

function GeoNoTargetState() {
  return (
    <section className="space-y-3 rounded-xl border border-base-300 bg-base-100 p-6">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-lg bg-base-200 p-2.5 text-base-content/70">
          <SearchCheck className="size-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">No brand is being monitored</h2>
          <p className="text-sm text-base-content/70">
            Add the brand you want to watch — its domain and market — and the
            nightly patrol starts archiving what AI says about it. Nothing is
            measured until then.
          </p>
        </div>
      </div>
    </section>
  );
}
