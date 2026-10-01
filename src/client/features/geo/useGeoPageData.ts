import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { computeVisibilityScore } from "@/client/features/geo/visibility-score";
import { computeCitationAuthority } from "@/client/features/geo/citation-authority";
import { buildMentionsTrend, type MentionMonth } from "./mentions-trend";
import {
  getGeoCitationGap,
  getGeoCitationProfile,
  getGeoEtvSeries,
  getGeoMentionHistory,
  getGeoNewLost,
  getGeoTopCited,
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

/**
 * How long a GEO read stays fresh.
 *
 * Exported rather than private because `VisibilityForecast` reads the same
 * archive and must use the same window: runs arrive **nightly**, so a shorter one
 * spends round trips to return identical numbers, and a longer one would show a
 * reader a rate that predates the run that produced it.
 */
export const GEO_QUERY_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * The platforms the `llm_mentions` family actually serves.
 *
 * Gemini and Perplexity have their own endpoints (`llm_responses`,
 * `llm_scraper`) with different shapes and different costs, so a mentions series
 * does not exist for them. They are listed in the product's vocabulary but not
 * here, and a request for one is reported rather than sent.
 */
const TRACKED_PLATFORMS = ["chat_gpt", "google_ai_overview"] as const;

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

/**
 * Momentum, 0–100, from the stored series.
 *
 * The one score component that is honestly derivable from the archive: the
 * 13-month direction. Two points are the minimum, because one point is not a
 * trend — the same rule `buildMentionsTrend` uses, and it returns null for the
 * same reason.
 *
 * `null` below the floor rather than a low score. "We do not have two months
 * yet" is a different claim from "your visibility is falling", and only the
 * first is true on day one.
 */
function buildMomentumFrom(months: MentionMonth[]): number | null {
  const trend = buildMentionsTrend(months);
  if (trend.change === null || trend.firstMeasuredMonth === null) return null;
  // The change is an absolute count, so it is scaled against the first measured
  // month rather than an arbitrary ceiling: a brand going 2 → 4 has doubled,
  // and a brand going 20,000 → 20,001 has not.
  const base = trend.points.find(
    (point) => point.month === trend.firstMeasuredMonth,
  )?.mentions;
  if (base === null || base === undefined || base <= 0) return null;
  const relative = trend.change / base;
  // -100% (lost everything) maps to 0 and +100% (doubled) maps to 100.
  return Math.max(0, Math.min(100, Math.round(50 + relative * 50)));
}

function describeMomentum(months: MentionMonth[]): string {
  const trend = buildMentionsTrend(months);
  if (trend.change === null) {
    return "Needs at least two months with a recorded figure. One point is not a trend.";
  }
  return `${trend.firstMeasuredMonth} → ${trend.lastMeasuredMonth}, ${trend.change >= 0 ? "+" : ""}${trend.change} mentions across ${trend.measuredCount} measured months.`;
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

  /**
   * The monthly mentions series, **per platform**.
   *
   * One query per platform rather than one for both, and the results are
   * returned as separate entries. Google AI Overviews and ChatGPT compute demand
   * differently — we measured 12,621,380 against 63,850 for one keyword — so a
   * combined series would be one number that means nothing. The market is not a
   * parameter here: the server reads it from the target, because that is the
   * market every capture was measured in.
   */
  const mentionSeries = useQueries({
    queries: TRACKED_PLATFORMS.map((platform) => ({
      queryKey: ["geoMentionHistory", projectId, domain, platform],
      enabled: ready,
      staleTime: GEO_QUERY_STALE_TIME_MS,
      queryFn: () =>
        getGeoMentionHistory({ data: { domain: domain ?? "", platform } }),
    })),
  });

  /**
   * Which platform the metered panels are showing.
   *
   * Only the two the `llm_mentions` family serves, and never a default that
   * could quietly become a blended answer. Gemini and Perplexity are absent by
   * design — they have their own endpoints, so a selector showing them would be
   * offering a panel that cannot return anything.
   */
  const livePlatform = ready ? (TRACKED_PLATFORMS[0] ?? null) : null;

  /**
   * The two **metered** panels.
   *
   * They are not fetched until the reader asks, because each open spends a
   * vendor call. A page that fetched them on load would spend money every time
   * someone looked at it — which is why they sit behind a button rather than
   * appearing with the rest.
   */
  const [wantLive, setWantLive] = useState(false);

  const newLost = useQuery({
    queryKey: ["geoNewLost", projectId, domain, livePlatform],
    enabled: ready && wantLive && livePlatform !== null,
    staleTime: GEO_QUERY_STALE_TIME_MS,
    queryFn: () =>
      getGeoNewLost({
        data: { domain: domain ?? "", platform: livePlatform ?? "chat_gpt" },
      }),
  });

  const topCited = useQuery({
    queryKey: ["geoTopCited", projectId, domain, livePlatform],
    enabled: ready && wantLive && livePlatform !== null,
    staleTime: GEO_QUERY_STALE_TIME_MS,
    queryFn: () =>
      getGeoTopCited({
        data: { domain: domain ?? "", platform: livePlatform ?? "chat_gpt" },
      }),
  });

  /**
   * One entry per platform, each with its own months.
   *
   * Built here rather than inline in the return value because both the score and
   * the trend read it, and a platform whose query failed still gets an entry with
   * empty months — so it renders an honest "no figure yet" rather than
   * disappearing and leaving the reader to wonder whether it was ever measured.
   */
  const platformSeries = TRACKED_PLATFORMS.map((platform, index) => ({
    platform,
    months: mentionSeries[index]?.data?.months ?? [],
    market: mentionSeries[index]?.data?.market ?? null,
    isLoading: mentionSeries[index]?.isLoading ?? false,
    errorMessage: geoErrorMessage(
      mentionSeries[index]?.error,
      `Could not load the ${platform} mentions history.`,
    ),
  }));

  /**
   * The citation profile, per platform, from the archive.
   *
   * This is what makes the score's citation component real: `geo_citation_domains`
   * already holds per-domain mention counts, and the score turns their *spread*
   * into a number. It is computed client-side from the rows, so no extra request
   * is made when the score renders.
   */
  const citationProfile = useQuery({
    queryKey: ["geoCitationProfile", projectId, domain],
    enabled: ready,
    staleTime: GEO_QUERY_STALE_TIME_MS,
    queryFn: () => getGeoCitationProfile({ data: { domain: domain ?? "" } }),
  });

  /**
   * Citation authority per platform, from the stored rows.
   *
   * Computed here rather than on the server because it is pure arithmetic over
   * data we already fetched — and keeping it client-side means the score renders
   * without waiting on a second round trip.
   */
  const authorityByPlatform = useMemo(
    () =>
      (citationProfile.data ?? []).map((entry) => ({
        platform: entry.platform,
        authority: computeCitationAuthority(
          entry.domains.map((row) => ({
            domain: row.domain,
            mentions: row.mentions,
          })),
        ),
      })),
    [citationProfile.data],
  );

  /**
   * The visibility score, per platform.
   *
   * **Assembled from the archive, not a vendor call** — every input is something
   * the patrol already stored, so the score costs nothing to show. The components
   * that cannot be derived from stored levels (share of voice needs a tracked
   * competitor set; mention coverage needs a category median) arrive as `null` and
   * the score says so rather than guessing.
   */
  const scores = useMemo(
    () =>
      platformSeries.map((entry) => {
        const authority = authorityByPlatform.find(
          (candidate) => candidate.platform === entry.platform,
        )?.authority;
        return computeVisibilityScore({
          platform: entry.platform,
          // Mention coverage has no honest source in the archive today: it needs
          // a category median we do not collect. It arrives null and the score
          // reports the gap.
          mentionCoverage: null,
          shareOfVoice: null,
          // Citation authority IS derivable — `geo_citation_domains` already
          // holds per-domain counts. See `citation-authority.ts` for what it
          // does and, just as importantly, what it does not claim to measure.
          citationAuthority: authority?.value ?? null,
          momentum: buildMomentumFrom(entry.months),
          evidence: {
            momentum: describeMomentum(entry.months),
            ...(authority ? { citationAuthority: authority.summary } : {}),
          },
        });
      }),
    [platformSeries, authorityByPlatform],
  );

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

    /** One entry per platform; see `platformSeries` above. */
    mentionSeries: platformSeries,

    /**
     * The metered panels. `wantLive` is exposed so the page can put them behind a
     * button, and `isLocked` distinguishes "you have not asked yet" from "this
     * needs the paid plan" — a reader who cannot tell those apart concludes the
     * feature is broken.
     */
    live: {
      wantLive,
      request: () => setWantLive(true),
      platform: livePlatform,
      newLost: newLost.data ?? null,
      newLostLoading: newLost.isLoading,
      newLostError: geoErrorMessage(
        newLost.error,
        "Could not load new and lost mentions.",
      ),
      topCited: topCited.data?.pages ?? null,
      topCitedLoading: topCited.isLoading,
      topCitedError: geoErrorMessage(
        topCited.error,
        "Could not load the top cited pages.",
      ),
      isLocked:
        newLost.error !== null &&
        getErrorCode(newLost.error) === "PAYMENT_REQUIRED",
    },

    /** One score per platform, never combined. */
    scores,
  };
}
