import type { LlmTargetMetrics } from "@/server/lib/dataforseoLlmSchemas";
import type { LlmPlatform } from "@/server/lib/dataforseo";

/**
 * The AI Visibility Checker: one vendor call → a shareable card.
 *
 * This is the lead-generation tool. The proposal's constraint is that the
 * headline number is visible **with no signup**, which is exactly what forces the
 * design: a free, unauthenticated surface is the worst possible place for a
 * number that cannot be defended, because a visitor has no way to check it and
 * we have no relationship to lose.
 *
 * ## There is no `target_metrics_lite`
 *
 * The proposal specifies "one `target_metrics_lite` call". Checked against the
 * live documentation: **no such endpoint exists.** The `llm_mentions` family
 * offers `target_metrics`, `historical`, `timeseries_new_lost`,
 * `top_mentioned_domains`, `top_mentioned_pages`, and `cross_aggregated_metrics`
 * — there is no `lite` variant of `target_metrics`.
 *
 * So this uses `target_metrics`, which is a single call and costs about $0.10.
 * The "lite" in the spec is better read as *one call, no archive, no auth* —
 * which is what this does. **Written down rather than silently dropped**, because
 * a reader who finds the spec later and cannot reconcile it with the code will
 * assume one of them is wrong.
 *
 * ## What one call can and cannot say
 *
 * `target_metrics` gives the brand's totals, its per-platform split, and the
 * domains that cite it. It gives **no history and no competitor set**, so a free
 * card cannot carry a score, a trend, or a share of voice. Anything that needs
 * those is a *sign-up* feature, and the card says so — because the alternative is
 * a headline number that implies a comparison we cannot make.
 *
 * The card's headline is therefore the one thing the call genuinely supports:
 * **how often AI engines mention this brand**, per platform, with the platform
 * named. Not a score, not a letter grade.
 */

type VisibilityCardPlatform = {
  platform: LlmPlatform;
  mentions: number | null;
  /** Never summed across platforms. See the module note. */
  aiSearchVolume: number | null;
};

/**
 * The card's output.
 *
 * Not exported: nothing outside this module consumes it yet, and knip enforces
 * that rather than letting an unused export drift.
 */
type VisibilityCard = {
  domain: string;
  /** Per platform, both present whether or not the call returned data. */
  platforms: VisibilityCardPlatform[];
  /**
   * Mentions summed across platforms. Legitimate — a mention is a mention — and
   * the one cross-platform figure this card offers.
   */
  totalMentions: number | null;
  /** Top citing domains, by mentions. Empty rather than null: "none" is a fact. */
  topCitedDomains: Array<{ domain: string; mentions: number | null }>;
  /** The single sentence the OG image shows. */
  headline: string;
  /**
   * Always present. A free tool that hides its own limits is a marketing tool, and
   * the visitor is the one who cannot see the missing features.
   */
  limits: string;
  /** The one thing to do next, or null when we genuinely have nothing to advise. */
  nextStep: string | null;
};

const LIMITS =
  "This card covers what one live query returns: how often AI engines mention this brand, and which sites they cite. It has no history, no competitor comparison, and no score — those need tracked data over time.";

export function buildVisibilityCard(input: {
  domain: string;
  metrics: LlmTargetMetrics | null;
  /** The platforms the call asked for, whether or not any came back. */
  requested: LlmPlatform[];
}): VisibilityCard {
  const byPlatform = new Map<LlmPlatform, VisibilityCardPlatform>();
  for (const platform of input.requested) {
    byPlatform.set(platform, {
      platform,
      mentions: null,
      aiSearchVolume: null,
    });
  }

  const aggregated = input.metrics?.aggregated_metrics ?? null;
  for (const bucket of aggregated?.platform ?? []) {
    if (bucket.key === null || bucket.key === undefined) continue;
    // The provider types this dimension's `key` as a string, but a location-style
    // integer has appeared on sibling endpoints, so anything that is not one of
    // the two platforms is skipped rather than cast. A mistyped cast here would
    // create a platform column that silently shows no data.
    if (bucket.key !== "chat_gpt" && bucket.key !== "google") continue;
    byPlatform.set(bucket.key, {
      platform: bucket.key,
      mentions: bucket.mentions ?? null,
      aiSearchVolume: bucket.ai_search_volume ?? null,
    });
  }

  const platforms = input.requested.map(
    (platform) =>
      byPlatform.get(platform) ?? {
        platform,
        mentions: null,
        aiSearchVolume: null,
      },
  );

  const totalMentions = sumKnown(platforms.map((p) => p.mentions));
  const topCitedDomains = (aggregated?.sources_domain ?? [])
    .slice(0, 5)
    .map((bucket) => ({
      // `key` is typed `string | number` because the vendor is inconsistent
      // about it across sibling dimensions (see the schema comment). A domain is
      // a domain, so a numeric key is stringified rather than rendered as a
      // number — and a missing one drops out below, since a blank source carrying
      // a mention count is worse than no row at all.
      domain:
        bucket.key === null || bucket.key === undefined
          ? ""
          : String(bucket.key),
      mentions: bucket.mentions ?? null,
    }))
    .filter((row) => row.domain !== "");

  const card: VisibilityCard = {
    domain: input.domain,
    platforms,
    totalMentions,
    topCitedDomains,
    headline: "",
    limits: LIMITS,
    nextStep: null,
  };
  card.headline = buildHeadline(card);
  card.nextStep = nextStep(card);
  return card;
}

/**
 * The headline, per platform.
 *
 * Never a combined figure. One call, two platforms, two different populations —
 * and a free visitor has no way to check a total, so a total is the one number
 * most likely to be wrong and least likely to be caught.
 */
function buildHeadline(card: VisibilityCard): string {
  const measured = card.platforms.filter(
    (p): p is VisibilityCardPlatform & { mentions: number } =>
      p.mentions !== null,
  );
  if (measured.length === 0) {
    return `We found no AI mentions of ${card.domain} in this query. That is a real answer, and it is only about this query — not a verdict on the brand.`;
  }
  const parts = measured.map(
    (p) => `${p.platform}: ${p.mentions.toLocaleString("en-US")} mentions`,
  );
  // One platform, one sentence. Two, two sentences — because "and" between two
  // populations is how a reader starts treating them as one number.
  return `AI engines mention ${card.domain} ${parts.join(", and ")}.`;
}

/**
 * The one next step, if there is one we can support.
 *
 * Only one, and only when it follows from the data in hand. A free card that
 * lists five recommendations is selling, not diagnosing.
 */
function nextStep(card: VisibilityCard): string | null {
  const total = card.totalMentions;
  if (total === null) return null;
  if (total === 0) {
    return "Nobody cites you in this query. The cheapest thing to check first is whether AI engines can read your site at all — start with llms.txt and your crawler access.";
  }
  if (card.topCitedDomains.length === 0) {
    return "You are mentioned but no citing domain was returned, so we cannot tell you which sources to earn. That needs the citation archive, which is a tracked feature.";
  }
  return `Your visibility rests on ${card.topCitedDomains.length} citing source${card.topCitedDomains.length === 1 ? "" : "s"}, led by ${card.topCitedDomains[0]?.domain}. Breadth matters: one dominant source is a single point of failure.`;
}

function sumKnown(values: Array<number | null>): number | null {
  let total = 0;
  let counted = false;
  for (const value of values) {
    if (typeof value === "number") {
      total += value;
      counted = true;
    }
  }
  return counted ? total : null;
}
