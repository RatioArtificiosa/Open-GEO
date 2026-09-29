import { useQuery } from "@tanstack/react-query";
import {
  getGeoCitationGap,
  getGeoEtvSeries,
  getGeoVisibility,
  listGeoRuns,
  listGeoTargets,
} from "@/serverFunctions/geo";
import {
  getErrorCode,
  getStandardErrorMessage,
} from "@/client/lib/error-messages";

/**
 * Data for the GEO page.
 *
 * Two rules shape this file, both inherited from the rest of the app:
 *
 * 1. **`projectId` is only in the query key, never in the request body.** The GEO
 *    server functions take it from the authorized context, so a page cannot read
 *    another project's archive by putting a different id in the body.
 * 2. **Errors become sentences, not stack traces**, and each endpoint gets a
 *    fallback that says what would fix it. "Something went wrong" is useless to
 *    the person reading it.
 */

const GEO_QUERY_STALE_TIME_MS = 5 * 60 * 1000;

function geoErrorMessage(error: unknown, fallback: string): string | null {
  if (!error) return null;
  if (getErrorCode(error) === "VALIDATION_ERROR") {
    return "Some filters were not accepted. Try a simpler date range or platform.";
  }
  return getStandardErrorMessage(error, fallback);
}

/** A coarse "how fresh is this", because a stale archive is not the same as none. */
function ageLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const hours = Math.round((Date.now() - then) / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function useGeoPageData(projectId: string) {
  const targets = useQuery({
    queryKey: ["geoTargets", projectId],
    staleTime: GEO_QUERY_STALE_TIME_MS,
    // No `projectId` in the body: the GEO schemas deliberately omit it, because
    // the server function takes it from the authorized context. Sending it would
    // be sending a value nothing reads.
    queryFn: () => listGeoTargets({ data: {} }),
  });

  const targetList = targets.data;
  const domain = targetList?.[0]?.domain ?? null;

  // Per-target queries stay disabled until a domain exists. Fetching with null
  // would either error or quietly read some other project's first target, and
  // both are worse than an honest empty state.
  const ready = Boolean(domain);

  const runs = useQuery({
    queryKey: ["geoRuns", projectId],
    staleTime: GEO_QUERY_STALE_TIME_MS,
    queryFn: () => listGeoRuns({ data: {} }),
  });

  const visibility = useQuery({
    queryKey: ["geoVisibility", projectId, domain],
    enabled: ready,
    staleTime: GEO_QUERY_STALE_TIME_MS,
    queryFn: () => getGeoVisibility({ data: { targetId: domain ?? "" } }),
  });

  const citationGap = useQuery({
    queryKey: ["geoCitationGap", projectId, domain],
    enabled: ready,
    staleTime: GEO_QUERY_STALE_TIME_MS,
    queryFn: () =>
      getGeoCitationGap({
        data: { targetId: domain ?? "", platform: "chat_gpt" },
      }),
  });

  const etvSeries = useQuery({
    queryKey: ["geoEtvSeries", projectId, domain],
    enabled: ready,
    staleTime: GEO_QUERY_STALE_TIME_MS,
    queryFn: () => getGeoEtvSeries({ data: { domain: domain ?? "" } }),
  });

  // `listRuns` is newest-first, so the head is the most recent patrol.
  const lastRunAt = runs.data?.[0]?.startedAt ?? null;
  const freshness = ageLabel(lastRunAt);

  return {
    domain,
    hasTarget: ready,
    isLoading: targets.isLoading,
    errorMessage: geoErrorMessage(
      targets.error,
      "Could not load your monitored brands.",
    ),
    /** Re-fetch everything. Used by the error state's Retry. */
    refetch: () => {
      void targets.refetch();
      void runs.refetch();
    },

    lastRunAt,
    freshness,
    runsError: geoErrorMessage(runs.error, "Could not load monitoring runs."),

    /**
     * Per-platform visibility. Deliberately kept as the server returned it — a
     * bucket per platform — because collapsing these into one number is the
     * mistake this whole feature exists to avoid.
     */
    perPlatform: visibility.data?.perPlatform ?? [],
    since: visibility.data?.since ?? null,
    targetName: visibility.data?.target?.name ?? null,
    visibilityError: geoErrorMessage(
      visibility.error,
      "Could not load AI visibility.",
    ),

    /**
     * The citation gap with its reason preserved. When a platform reports no
     * retrievals the list is empty AND `available` is false; the UI must say why
     * rather than showing an empty list that reads as "nothing was retrieved".
     */
    gap: {
      available: citationGap.data?.retrievalAvailable ?? false,
      reason: citationGap.data?.reason ?? null,
      pages:
        citationGap.data?.gaps?.map((gap) => ({
          url: gap.url,
          rank: gap.rank,
        })) ?? [],
    },
    gapError: geoErrorMessage(
      citationGap.error,
      "Could not load the citation gap.",
    ),

    /**
     * Points for the boundary chart. Each carries its own formula version, which
     * is why the chart can refuse to draw a mixed series as a clean line.
     */
    etvPoints: etvSeries.data?.points ?? [],
    etvFormulaVersions: etvSeries.data?.formulaVersions ?? [],
  };
}
