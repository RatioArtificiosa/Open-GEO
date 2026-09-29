/**
 * Citation authority, from data we already store.
 *
 * This is the one score component that **is** honestly derivable today.
 * `geo_citation_domains` already holds, per platform, how often each domain
 * appears in the answers that cite the brand — so the question is not "can we
 * measure it" but "what, exactly, are we claiming when we turn those counts into
 * a 0–100 number?"
 *
 * The answer here is deliberately modest, and the modesty is the point.
 *
 * **We do not have domain quality.** No PageRank, no spam score, no traffic
 * estimate, no way to tell a national newspaper from a content farm. A metric
 * named "authority" that quietly implied editorial quality would be the exact
 * failure this product exists to avoid: a confident number standing in for
 * something we did not measure.
 *
 * So the component is **citation concentration** — how broadly the citations are
 * spread, measured with the Shannon entropy of the distribution. That is a fact
 * about the archive, it needs no external data, and it has a real reading:
 *
 * - Citations concentrated in one domain means the brand's visibility rests on a
 *   single source, which is fragile.
 * - Citations spread across many domains mean independent sources have picked it
 *   up, which is robust.
 *
 * Both extremes are reported rather than smoothed: a single dominant domain and a
 * perfectly flat distribution are different findings, and a score that mapped
 * both to 50 would have thrown away the information a customer needs.
 */

/**
 * What the function returns.
 *
 * Declared here rather than inferred at the call site so the client and the tests
 * share one definition — and so a field can be added without every consumer
 * re-deriving it. `CitationShare` is gone: the function never returns per-domain
 * rows, it only uses them to compute the distribution, and a type nothing returns
 * is a type that will drift from reality.
 */
type CitationAuthority = {
  /** 0–100, or null when there is nothing to score. */
  value: number | null;
  /** How many distinct domains cite the brand. */
  distinctDomains: number;
  /** The single largest share, 0–1. Near 1 means the citations rest on one source. */
  topShare: number | null;
  /** Shannon entropy of the distribution, normalised to 0–1 by `log2(n)`. */
  spread: number | null;
  summary: string;
};

/**
 * Shannon entropy, in bits.
 *
 * 0 for a distribution concentrated in one bucket, `log2(n)` for one spread
 * evenly across `n`. `log` is used rather than `log2` because the normalisation
 * later divides by `log(n)` from the same function, and the base cancels — this
 * keeps the two from drifting apart.
 */
function entropy(shares: number[]): number {
  let total = 0;
  for (const share of shares) {
    if (share > 0) total -= share * Math.log(share);
  }
  return total;
}

export function computeCitationAuthority(
  rows: Array<{ domain: string; mentions: number | null }>,
): CitationAuthority {
  const known = rows.filter(
    (row): row is { domain: string; mentions: number } =>
      typeof row.mentions === "number" && row.mentions >= 0,
  );
  const total = known.reduce((sum, row) => sum + row.mentions, 0);

  // No data and a recorded total of zero are different facts. A brand nobody
  // cites yet has no authority score; it does not have a score of zero.
  if (total <= 0) {
    return {
      value: null,
      distinctDomains: known.length,
      topShare: null,
      spread: null,
      summary:
        known.length === 0
          ? "Nothing cites this brand yet, so there is no citation profile to score."
          : "Every domain that cites this brand recorded zero mentions.",
    };
  }

  // `total > 0` is established above, so every share is a real number. The
  // `CitationShare.share` field is nullable only so the *exported* type can
  // describe rows whose count we do not know; here we are looking at rows we
  // filtered to known counts, so the narrowing is a filter rather than a cast.
  const shareValues: number[] = known.map((row) => row.mentions / total);
  const topShare = Math.max(...shareValues);
  const spread =
    known.length > 1
      ? Math.min(1, entropy(shareValues) / Math.log(known.length))
      : null;

  // With one citing domain the distribution is maximally concentrated, so the
  // score is 0 — not null. That is a *measured* fact (one source, no breadth),
  // and saying so is more useful than withholding a number.
  const value = spread === null ? 0 : Math.round(spread * 100);

  return {
    value,
    distinctDomains: known.length,
    topShare,
    spread,
    summary: describe({ known, value, topShare, spread }),
  };
}

function describe(input: {
  known: Array<{ domain: string; mentions: number }>;
  value: number | null;
  topShare: number | null;
  spread: number | null;
}): string {
  const n = input.known.length;
  if (n === 1) {
    return `Only one domain (${input.known[0]?.domain}) cites this brand. Visibility resting on a single source is fragile.`;
  }
  if (input.topShare !== null && input.topShare >= 0.5) {
    const pct = Math.round(input.topShare * 100);
    return `${n} domains cite this brand, but one supplies ${pct}% of the mentions. A single dominant source is a concentration risk.`;
  }
  if (n <= 2) {
    return `Only ${n} domains cite this brand, so there is little to be independent about yet.`;
  }
  return `${n} domains cite this brand and no single one dominates (largest share ${Math.round((input.topShare ?? 0) * 100)}%). This is breadth of citation, not a quality judgement: OpenGeo does not score domain authority.`;
}
