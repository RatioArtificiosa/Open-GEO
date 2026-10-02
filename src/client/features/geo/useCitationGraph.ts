import { useQuery } from "@tanstack/react-query";
import { getGeoCitationGraph } from "@/serverFunctions/geo";

/**
 * The earn-the-citation list, as one hook.
 *
 * **Split out because `useGeoPageData` crossed the complexity limit at 44** when
 * this query was added to it, and a page-data hook that has to be opened to
 * understand what it fetches is the shape the limit exists to prevent. The limit
 * is not an obstacle to work around with a disable comment; it is the file telling
 * the truth about its size.
 *
 * The two rules the page already follows apply here unchanged: `projectId` lives
 * only in the query key and never in the request body — the server reads it from
 * the authorized context — and an error becomes a sentence rather than a stack
 * trace.
 */
export function useCitationGraph(input: {
  projectId: string;
  domain: string | null;
  enabled: boolean;
  staleTimeMs: number;
}): {
  citationGraph: {
    outreach: Array<{
      domain: string;
      citations: number;
      pages: number;
      backlinksToUs: number | null;
      anchors: string[] | null;
      status: "contested" | "reachable" | "owned";
      nextStep: string | null;
    }>;
    unreached: string[];
    insight: string | null;
    caveat: string | null;
  };
  citationGraphError: string | null;
} {
  const query = useQuery({
    queryKey: ["geoCitationGraph", input.projectId, input.domain],
    enabled: input.enabled,
    staleTime: input.staleTimeMs,
    queryFn: () =>
      getGeoCitationGraph({ data: { domain: input.domain ?? "" } }),
  });

  return {
    citationGraph: {
      outreach: query.data?.outreach ?? [],
      unreached: query.data?.unreached ?? [],
      insight: query.data?.insight ?? null,
      caveat: query.data?.caveat ?? null,
    },
    citationGraphError: query.error
      ? "Could not load the earn-the-citation list."
      : null,
  };
}
