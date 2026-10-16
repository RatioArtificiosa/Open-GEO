import { useQuery } from "@tanstack/react-query";
import { getGeoCitationWinRate } from "@/serverFunctions/geo";
import { GEO_PLATFORM_LABELS, type GEO_PLATFORMS } from "@/types/schemas/geo";
import { GEO_QUERY_STALE_TIME_MS } from "./useGeoPageData";

type GeoPlatform = (typeof GEO_PLATFORMS)[number];

/**
 * Citation win probability (CL-502 surface).
 *
 * The measured base rate with its Wilson interval, bounded by the project's
 * audit readiness — the same summarizer the MCP citation-gap tool reads, so
 * the page and the agent quote one number. The server's summary sentence
 * renders verbatim: refusals (thin sample, no retrievals) arrive as content,
 * and restating them at the call site would be two texts to keep in step.
 * The denominator travels beside every rate, because a rate without it is
 * not interpretable.
 */
export function CitationWinPanel({
  projectId,
  targetId,
  platform,
}: {
  projectId: string;
  targetId: string;
  platform: GeoPlatform;
}) {
  const { data, isPending, isError, error } = useQuery({
    // projectId is part of the key: the server function takes the project
    // from the authorized context, so the response depends on which project
    // the user is looking at.
    queryKey: ["geoCitationWinRate", projectId, targetId, platform],
    queryFn: () => getGeoCitationWinRate({ data: { targetId, platform } }),
    staleTime: GEO_QUERY_STALE_TIME_MS,
  });

  if (isPending) {
    return (
      <section className="rounded-lg border border-base-content/10 p-4">
        <h2 className="text-base font-semibold">Citation win rate</h2>
        <p className="mt-2 text-sm text-base-content/70">Loading win rate</p>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="rounded-lg border border-base-content/10 p-4">
        <h2 className="text-base font-semibold">Citation win rate</h2>
        <p className="mt-2 text-sm text-base-content/70">
          This panel could not be read. That is a fault here, not a statement
          about your citations.
        </p>
        <p className="mt-1 text-xs text-base-content/50">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </section>
    );
  }

  if (!data.retrievalAvailable) {
    return (
      <section className="rounded-lg border border-base-content/10 p-4">
        <h2 className="text-base font-semibold">Citation win rate</h2>
        <p className="mt-2 text-sm text-base-content/70">
          {data.reason ??
            "This platform does not report which pages it retrieved, so no rate can be computed here."}{" "}
          A confident empty rate would claim your pages were never retrieved,
          which is a different statement.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-base-content/10 p-4">
      <h2 className="text-base font-semibold">
        Citation win rate · {GEO_PLATFORM_LABELS[platform] ?? platform}
      </h2>
      <p className="mt-2 text-sm text-base-content/80">{data.summary}</p>
      <p className="mt-1 text-xs text-base-content/60">
        {data.citationsObserved} of {data.retrievalsObserved} retrieved pages
        cited
        {data.readinessModifier === "capped-by-readiness"
          ? " · quoted at the interval's low end while audit fixes are outstanding"
          : data.readinessModifier === "readiness-complete"
            ? " · audit checks completed"
            : ""}
        .
      </p>
      <p className="mt-1 text-xs text-base-content/50">{data.doesNotClaim}</p>
    </section>
  );
}
