/**
 * "How AI Frames Your Brand" — the positioning diagnosis.
 *
 * `brand_entities_title` and `brand_entities_category` come back as a list of
 * labelled buckets with mention counts, and the diagnosis the product wants from
 * them is the one in the proposal: *"AI thinks you're a Formula One team, not a
 * car manufacturer."* That is a **positioning** finding, not a ranking — the
 * customer learns they are being filed under the wrong heading, which no ranking
 * table would tell them.
 *
 * ## Two refusals, both load-bearing
 *
 * **1. This is ChatGPT-only, and the panel must say so.** The schema comment
 * says it plainly: these three dimensions — `search_results_domain`,
 * `brand_entities_title`, `brand_entities_category` — are ChatGPT only and come
 * back empty on Google. A panel that rendered "how AI sees you" without naming
 * the platform would be generalising from one model, and a customer reading
 * "AI" would reasonably believe all of them. `platform` is a required input, not
 * an optional caption.
 *
 * **2. Never total `ai_search_volume` across buckets.** Each bucket carries its
 * own `ai_search_volume`, and these are the People-Also-Ask-derived figures — the
 * same ones that are 198× apart from Google's real search volume. But unlike the
 * two-platform case, *every* bucket here is the same platform, so **summing
 * buckets is legitimate in a way summing platforms is not**: they are the same
 * event counted across disjoint categories. What is not legitimate is comparing
 * a bucket's AI volume to a Google figure elsewhere, or presenting a bucket
 * total as if it were demand. So the bucket total exists, and it is labelled
 * with what it is.
 *
 * ## The headline is the user's own bucket, not the winner
 *
 * The interesting output is "AI files you as X", which requires knowing the
 * target's own bucket — so the target is identified by **domain**, matched
 * against the bucket keys. When no bucket matches, the honest answer is "AI did
 * not file you under any of these labels", which is a *stronger* finding than
 * any of them, and the panel has to be able to say it.
 */

/** One labelled bucket, exactly as the provider returns it. */
export type BrandEntityBucket = {
  key: string | number;
  mentions: number | null;
  /** People-Also-Ask-derived. Comparable only with other buckets of one run. */
  aiSearchVolume: number | null;
};

/**
 * The panel's output.
 *
 * Not exported: nothing outside this module consumes it yet. The bucket type
 * below is, because a caller shaping provider rows needs to name it — and knip
 * enforces that distinction, which is the point.
 */
type BrandFraming = {
  /** Always the platform these dimensions exist on. */
  platform: "chat_gpt";
  /**
   * The target's own bucket, or null when nothing matched. Null is the finding:
   * "AI never filed this brand under any label" is more actionable than any
   * label it could have picked.
   */
  ownBucket: BrandEntityBucket | null;
  /**
   * Which of the target's buckets is largest, for the dimension as a whole. Null
   * when nothing matched or nothing was counted.
   */
  dominantBucket: BrandEntityBucket | null;
  /** All buckets, by mentions descending. Ties keep the provider's order. */
  titleBuckets: BrandEntityBucket[];
  categoryBuckets: BrandEntityBucket[];
  /**
   * Mentions summed across buckets. Legitimate — same platform, disjoint
   * categories — and deliberately the *only* total offered.
   */
  totalMentions: number | null;
  /** The one-sentence diagnosis, or null when there is nothing to diagnose. */
  diagnosis: string | null;
  /**
   * Always states that this is one model. A reader who sees "AI thinks you're a
   * Formula One team" with no platform will believe it about AI generally.
   */
  caveat: string;
};

const PLATFORM_CAVEAT =
  "This is ChatGPT's view only. DataForSEO returns brand entities for ChatGPT and not for Google, so this is not a statement about how every AI engine frames you.";

/**
 * Build the panel.
 *
 * `domain` is matched against bucket keys. Both sides are compared on a
 * hostname-ish basis rather than with `===`, because a provider bucket key may
 * be a bare name ("Acme") where the domain is "acme.com" and a strict comparison
 * would report "not filed" for a brand that plainly was.
 */
export function buildBrandFraming(input: {
  domain: string;
  title: BrandEntityBucket[] | null | undefined;
  category: BrandEntityBucket[] | null | undefined;
}): BrandFraming {
  const titleBuckets = order(input.title);
  const categoryBuckets = order(input.category);
  const needle = normalise(input.domain);

  const ownTitle = titleBuckets.find((b) => matches(b.key, needle)) ?? null;
  const ownCategory =
    categoryBuckets.find((b) => matches(b.key, needle)) ?? null;
  const ownBucket = ownTitle ?? ownCategory;

  // A brand is "filed" if it appears under a label at all. Both dimensions are
  // searched, because a provider may file a brand by title in one run and by
  // category in another.
  const totalMentions = sumMentions([...titleBuckets, ...categoryBuckets]);

  const framing: BrandFraming = {
    platform: "chat_gpt",
    ownBucket,
    // The label the model *leans on hardest* across both dimensions, so the two
    // lists are merged and ranked together first — taking the first title bucket
    // would report a 40-mention title as dominant while a 900-mention category
    // sat in the other list, which is the opposite of the diagnosis.
    dominantBucket: dominantOf(order([...titleBuckets, ...categoryBuckets])),
    titleBuckets,
    categoryBuckets,
    totalMentions,
    diagnosis: null,
    caveat: PLATFORM_CAVEAT,
  };
  framing.diagnosis = diagnose(framing, input.domain, needle);
  return framing;
}

/**
 * Is this bucket key the brand we are asking about?
 *
 * The provider is inconsistent about what it puts in `key`: sometimes a domain
 * ("acme.com"), sometimes a bare label ("Acme"), and often a label with a
 * descriptor ("Acme Cars"). The first two are handled by comparing against the
 * domain's leading label. The third is handled by checking whether the domain's
 * leading label appears as a **whole word** in the key.
 *
 * Whole-word, not substring: "acme" is a word in "Acme Cars", but "co" is a
 * substring of "acme.com" and matching on that would file every `.com` brand
 * under whatever label contains those two letters. A false positive here is a
 * misdiagnosis of positioning — the panel's entire output — so the match stays
 * tight and the loose case is left to the "never filed under a label" reading,
 * which is itself an honest finding rather than an error.
 */
function matches(key: string | number, needle: string): boolean {
  const candidate = normalise(String(key));
  if (candidate === "") return false;
  if (candidate === needle) return true;
  const bare = needle.replace(/^www\./, "").split(".")[0] ?? needle;
  if (bare === "") return false;
  if (candidate === bare) return true;
  return new RegExp(`\\b${escapeRegExp(bare)}\\b`).test(candidate);
}

/** `String.replace` with a literal argument, so a `.` in a domain stays a `.`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalise(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(/[/?#]/)[0] ?? ""
  );
}

/**
 * By mentions, descending, with unknown counts last.
 *
 * A bucket whose count we could not read is not a bucket with zero mentions, and
 * sorting it as one would bury a real label under a data gap. The order is
 * stable for ties, so the provider's own ordering survives where it matters.
 */
function order(
  buckets: BrandEntityBucket[] | null | undefined,
): BrandEntityBucket[] {
  if (!buckets) return [];
  const ranked: BrandEntityBucket[] = [];
  for (const bucket of buckets) {
    let at = ranked.length;
    for (let i = 0; i < ranked.length; i += 1) {
      const other = ranked[i];
      if (other !== undefined && rankOf(other) > rankOf(bucket)) {
        at = i;
        break;
      }
    }
    ranked.splice(at, 0, bucket);
  }
  return ranked;
}

function rankOf(bucket: BrandEntityBucket): number {
  return -(bucket.mentions ?? -1);
}

function sumMentions(buckets: BrandEntityBucket[]): number | null {
  let total = 0;
  let counted = false;
  for (const bucket of buckets) {
    if (typeof bucket.mentions === "number") {
      total += bucket.mentions;
      counted = true;
    }
  }
  return counted ? total : null;
}

function dominantOf(buckets: BrandEntityBucket[]): BrandEntityBucket | null {
  for (const bucket of buckets) {
    if (typeof bucket.mentions === "number") return bucket;
  }
  return null;
}

function diagnose(
  framing: BrandFraming,
  domain: string,
  needle: string,
): string | null {
  const counted = framing.titleBuckets.concat(framing.categoryBuckets);
  if (counted.length === 0) {
    return `ChatGPT returned no brand-entity buckets for ${domain}, so there is no positioning to read. This is not evidence that ChatGPT has no view of you — it is an absence of data.`;
  }

  if (framing.ownBucket === null) {
    const labels = counted
      .slice(0, 5)
      .map((b) => String(b.key))
      .join(", ");
    return `ChatGPT framed ${domain} indirectly: it never appears as a bucket of its own, but the mentions that carried it were filed under ${labels}. An entity with no label of its own is one the models cannot place, which is worth more attention than a wrong label.`;
  }

  const ownLabel = String(framing.ownBucket.key);
  const dominant = framing.dominantBucket;
  if (
    dominant !== null &&
    String(dominant.key).toLowerCase() !== ownLabel.toLowerCase()
  ) {
    return `ChatGPT files ${domain} as "${ownLabel}", while the label it leans on hardest is "${String(dominant.key)}". That gap is the positioning problem: the model associates ${needle} with something else.`;
  }
  return `ChatGPT files ${domain} as "${ownLabel}", and that is also the label it leans on hardest. The positioning is consistent.`;
}
