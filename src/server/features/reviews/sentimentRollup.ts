/**
 * Multi-platform review sentiment rollup (CL-504).
 *
 * Aggregate only: per-platform counts, averages on a 0–5 scale, and the
 * 1–5 distribution. Reviewer names, profile URLs, and review texts never
 * enter this module — the vendor supplies PII with every row and the
 * product has no question that needs it (the CL-720 aggregate-only rule,
 * applied to people rather than domains). Averages normalize by each row's
 * own max, so a Max5 and a Percents source never average raw.
 */

export type ReviewRating = {
  platform: string;
  /** 1–5 value, or null when the row carries no usable rating. */
  value: number | null;
  /** The scale the value is on; defaults to 5 when the source omits it. */
  max?: number | null;
};

type PlatformRollup = {
  platform: string;
  reviews: number;
  /** Mean on a 0–5 scale over rated rows, null when none rated. */
  averageOn5: number | null;
  /** Votes per star 1–5 over rated rows. */
  distribution: [number, number, number, number, number];
};

export type SentimentRollup = {
  platforms: PlatformRollup[];
  /** Total rows seen, rated or not — the denominator beside every average. */
  totalReviews: number;
  /** Rows with no usable rating: refused from the average, counted aloud. */
  unrated: number;
};

function normalizeTo5(
  value: number,
  max: number | null | undefined,
): number | null {
  const scale = typeof max === "number" && max > 0 ? max : 5;
  if (!Number.isFinite(value) || value < 0 || value > scale) return null;
  return (value / scale) * 5;
}

export function rollupReviewSentiment(
  ratings: ReviewRating[],
): SentimentRollup {
  const byPlatform = new Map<
    string,
    {
      count: number;
      sum: number;
      rated: number;
      dist: [number, number, number, number, number];
    }
  >();
  let unrated = 0;
  for (const row of ratings) {
    let entry = byPlatform.get(row.platform);
    if (!entry) {
      entry = { count: 0, sum: 0, rated: 0, dist: [0, 0, 0, 0, 0] };
      byPlatform.set(row.platform, entry);
    }
    entry.count += 1;
    const normalized =
      row.value === null ? null : normalizeTo5(row.value, row.max);
    if (normalized === null) {
      unrated += 1;
      continue;
    }
    entry.sum += normalized;
    entry.rated += 1;
    const star = Math.min(5, Math.max(1, Math.round(normalized)));
    const slot = star - 1;
    const dist = entry.dist;
    if (slot >= 0 && slot < dist.length) {
      const current = dist[slot] ?? 0;
      dist[slot] = current + 1;
    }
  }
  return {
    platforms: [...byPlatform.entries()].map(([platform, entry]) => ({
      platform,
      reviews: entry.count,
      averageOn5: entry.rated === 0 ? null : entry.sum / entry.rated,
      distribution: entry.dist,
    })),
    totalReviews: ratings.length,
    unrated,
  };
}
