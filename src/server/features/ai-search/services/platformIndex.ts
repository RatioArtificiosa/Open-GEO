import type { LlmPlatform } from "@/server/lib/dataforseo";

/**
 * The cross-platform normalized index.
 *
 * The problem it solves: a customer with 5 mentions on ChatGPT and 12,000 on
 * Google cannot be told "you have 12,005 mentions" — the two are not the same
 * event counted twice, they are two different populations measured in two
 * different units. That is the 198× problem, and it has taken three refusals so
 * far (no summed demand card, no combined score, no summed SOV demand row).
 *
 * The way out is not a better total. It is **two honest comparisons**, each
 * against its own baseline:
 *
 * > Google visibility is 18% above baseline. ChatGPT visibility is 32% above
 * > baseline.
 *
 * Read together those say something a total never could: *this brand is present
 * on Google, and on ChatGPT it is doing comparatively better than a typical
 * brand.* The percentages are not comparable to each other and must never be
 * added — the word "index" is the load-bearing part, and the summary says so.
 *
 * ## The baseline is the whole design
 *
 * The index is a ratio, so it is exactly as trustworthy as its denominator. We
 * do **not** have a category median: nothing in the archive says what a typical
 * brand scores on a typical prompt set. So the baseline is supplied by the
 * caller, and the function reports `basis` so the reader can see *which* one was
 * used rather than trusting a bare percentage.
 *
 * That is the honest version of a normalized index: it is transparent about its
 * own denominator instead of hard-coding a constant that looks universal. A
 * default of 100 would be a number we invented, and it would be indistinguishable
 * from one the customer chose.
 */

/**
 * The platform names we accept, checked rather than cast.
 *
 * Duplicated from the provider's union on purpose: `LlmPlatform` is a *type*,
 * and there is no way to test a runtime string against one without an
 * assertion. One cast is cheaper than a second list that can drift — so this
 * list is asserted equal to the union by a test, which is the version of "they
 * cannot drift" that actually holds.
 */
export const PLATFORMS: readonly string[] = ["chat_gpt", "google"];

function isLlmPlatform(name: string): name is LlmPlatform {
  return PLATFORMS.includes(name);
}

export type PlatformBaseline = {
  platform: LlmPlatform;
  /**
   * The reference value for this platform — what the metric was for the
   * comparison set. Strictly positive: a zero or negative baseline would make the
   * ratio either infinite or a sign flip, and neither means anything.
   */
  value: number;
  /**
   * Where the baseline came from, in words a reader can check. Required, not
   * optional: an index whose denominator is unlabeled is exactly the confident
   * number standing for something we did not measure.
   */
  basis: string;
};

type IndexEntry = {
  platform: LlmPlatform;
  metric: number | null;
  baseline: number | null;
  /** Percentage above (or below) baseline. Null when either side is unknown. */
  deltaPct: number | null;
  /** Plain-language reading. Names the basis, so it cannot drift from it. */
  reading: string;
};

type PlatformIndex = {
  entries: IndexEntry[];
  /**
   * Always false. A combined index is the thing this product refuses to ship,
   * so the flag exists for the UI to assert on rather than for a value to hold.
   */
  isCombinable: false;
  summary: string;
};

/**
 * Build the per-platform index.
 *
 * `metrics` maps a platform to the observed value. A platform with no metric
 * still gets an entry, with a null reading — the reader needs to see we looked.
 */
export function computePlatformIndex(input: {
  metrics: Partial<Record<LlmPlatform, number | null>>;
  baselines: PlatformBaseline[];
  /** What the metric is, for the summary. e.g. "mentions per prompt set". */
  metricLabel: string;
}): PlatformIndex {
  const baselineByPlatform = new Map(
    input.baselines.map((entry) => [entry.platform, entry]),
  );
  // Keys arrive as plain strings, so each one is checked against the platform
  // union rather than cast to it. A cast here would let a typo become a
  // platform column that silently computes nothing; a filter drops it, and the
  // `unrecognised` count in the summary says how many were ignored.
  const requested = new Set<string>([
    ...Object.keys(input.metrics),
    ...baselineByPlatform.keys(),
  ]);
  const platforms: LlmPlatform[] = [];
  let unrecognised = 0;
  for (const name of requested) {
    if (isLlmPlatform(name)) {
      platforms.push(name);
    } else {
      unrecognised += 1;
    }
  }

  const entries: IndexEntry[] = platforms.map((platform) => {
    const metric = input.metrics[platform] ?? null;
    const baseline = baselineByPlatform.get(platform) ?? null;
    const usable =
      metric !== null && metric >= 0 && baseline !== null && baseline.value > 0;

    if (!usable) {
      return {
        platform,
        metric,
        baseline: baseline?.value ?? null,
        deltaPct: null,
        reading: explainGaps(platform, metric, baseline),
      };
    }

    const deltaPct = ((metric - baseline.value) / baseline.value) * 100;
    const rounded = Math.round(deltaPct * 10) / 10;
    const direction = rounded > 0 ? "above" : rounded < 0 ? "below" : "at";
    return {
      platform,
      metric,
      baseline: baseline.value,
      deltaPct: rounded,
      reading: `${input.metricLabel} is ${Math.abs(rounded)}% ${direction} the ${baseline.basis}.`,
    };
  });

  const index: PlatformIndex = {
    entries,
    isCombinable: false,
    summary: "",
  };
  index.summary = describe(index, input.metricLabel);
  // Naming the dropped keys keeps the filter honest: a platform silently
  // ignored looks identical to one that was never requested, and only the count
  // distinguishes "you did not ask about that" from "we did not understand it".
  if (unrecognised > 0) {
    index.summary += ` ${unrecognised} unrecognised platform ${
      unrecognised === 1 ? "name was" : "names were"
    } ignored.`;
  }
  return index;
}

function explainGaps(
  platform: LlmPlatform,
  metric: number | null,
  baseline: PlatformBaseline | null,
): string {
  if (metric === null) {
    return `No ${platform} figure was returned, so there is nothing to compare against a baseline.`;
  }
  if (baseline === null) {
    return `A ${platform} figure was measured (${metric}) but no baseline was supplied for it, so no index is computed. A baseline is not a constant we can supply: nothing in the archive says what a typical brand scores.`;
  }
  return `The ${platform} baseline must be greater than zero, so no index is computed.`;
}

function describe(index: PlatformIndex, metricLabel: string): string {
  const measured = index.entries.filter((entry) => entry.deltaPct !== null);
  if (measured.length === 0) {
    return `No ${metricLabel} could be compared to a baseline, so no index is shown. This is not a zero.`;
  }
  const readings = measured
    .map((entry) => `${entry.platform} ${entry.reading}`)
    .join("; ");
  return `${readings}. These are separate indices against separate baselines and are never added together — "index" means the comparison is per platform, not that the values combine.`;
}
