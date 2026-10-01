import { AlertTriangle, RefreshCw, SearchCheck } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { GeoVisibilityPanel } from "./GeoVisibilityPanel";
import { GeoTargetForm } from "./GeoTargetForm";
import { MentionsTrendPanel } from "./MentionsTrendPanel";
import { VisibilityForecast } from "./VisibilityForecast";
import { NewLostPanel, TopCitedPanel, MetricFootnote } from "./LivePanels";
import { ScoreRing } from "./ScoreRing";
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
          {/*
            The link to the evidence is placed **next to the claim it qualifies**,
            not in a footer or a nav. Every number below is derived from stored
            vendor calls, and this is where someone who wants to check one goes.
            A link in a footer is a link nobody follows, and an evidence surface
            nobody opens is not evidence.
          */}
          <p className="mt-1 text-sm">
            <Link
              to="/p/$projectId/geo/evidence"
              params={{ projectId }}
              className="link"
            >
              Where these numbers come from
            </Link>
          </p>
        </header>

        <section className="rounded-xl border border-base-300 bg-base-100 p-4">
          <GeoTargetForm projectId={projectId} onChanged={data.refetch} />
        </section>

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
              <h2 className="inline-flex items-center gap-1.5 text-base font-semibold">
                Retrieved but never cited
                {/* The advice for this panel is the opposite of the advice for a
                    low count, so the footnote says which one it is. */}
                <MetricFootnote id="retrieved_but_uncited" />
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

            <section aria-label="Mentions over time" className="space-y-3">
              <div>
                <h2 className="text-base font-semibold">Mentions over time</h2>
                <p className="text-sm text-base-content/70">
                  One series per platform, never combined — the two compute
                  demand differently, so a single total would be a number that
                  means nothing. A month with no figure is drawn as a gap, not
                  as a zero.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {data.mentionSeries.map((entry) => (
                  <MentionsTrendPanel
                    key={entry.platform}
                    platform={entry.platform}
                    months={entry.months}
                  />
                ))}
              </div>

              {/*
                The forecast sits with the series it explains, and only once a
                brand exists — a rate about no brand is not a rate. It is one
                panel per platform rather than one blended figure, for the same
                reason the series above is: the platforms compute visibility
                differently, so a single number would mean nothing.
              */}
              {(() => {
                // Captured into a local so the null-narrowing survives into the
                // callback. Reading `data.domain` inside the closure would widen
                // back to `string | null`, and the cast needed to silence that is
                // exactly the kind of assertion that hides a real null later.
                const domain = data.domain;
                if (!domain) return null;
                return data.mentionSeries.map((entry) => (
                  <VisibilityForecast
                    key={entry.platform}
                    projectId={projectId}
                    domain={domain}
                    platform={entry.platform}
                  />
                ));
              })()}
            </section>

            <section
              aria-label="Visibility score"
              className="grid grid-cols-1 gap-3 xl:grid-cols-2"
            >
              {/* One ring per platform, never a combined one. */}
              {data.scores.map((score) => (
                <ScoreRing key={score.platform} score={score} />
              ))}
            </section>

            <section aria-label="Live vendor queries" className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">
                    New, lost, and what they cite
                  </h2>
                  <p className="text-sm text-base-content/70">
                    Everything above reads your archive. These two query the
                    vendor live, because neither can be reconstructed from
                    stored levels: 10 &rarr; 12 does not say which prompt
                    appeared, and the citation ranking is the vendor&rsquo;s
                    view of the whole corpus rather than ours.
                  </p>
                </div>
                {!data.live.wantLive ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={data.live.request}
                  >
                    Run live query
                  </button>
                ) : null}
              </div>
              {data.live.wantLive ? (
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  <NewLostPanel
                    platformLabel="ChatGPT"
                    series={data.live.newLost}
                    isLoading={data.live.newLostLoading}
                    errorMessage={data.live.newLostError}
                    isLocked={data.live.isLocked}
                  />
                  <TopCitedPanel
                    platformLabel="ChatGPT"
                    pages={data.live.topCited}
                    isLoading={data.live.topCitedLoading}
                    errorMessage={data.live.topCitedError}
                    isLocked={data.live.isLocked}
                  />
                </div>
              ) : null}
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
