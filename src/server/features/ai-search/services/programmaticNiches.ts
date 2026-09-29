/**
 * Programmatic SEO for the free tool: `/tools/ai-visibility/{niche}`.
 *
 * A route file would be the easy part. The part that decides whether this feature
 * is an asset or a liability is **which slugs exist at all**, because a
 * programmatic page factory with no whitelist is a doorway-page generator, and
 * Google's spam policies name that pattern explicitly.
 *
 * ## The rule
 *
 * A niche page exists **only for a niche we can say something specific about.**
 * A shared template with a swapped noun is not a page; it is a doorway. So the
 * slug is not free text — it is resolved through a **curated registry**, and an
 * unknown slug is a 404 rather than a rendered shell.
 *
 * That is the whole design. A visitor who lands on `/tools/ai-visibility/dental`
 * gets a page that knows what dental practices are asked by AI, what sources
 * they are cited from, and what to do about it. A visitor who lands on
 * `/tools/ai-visibility/asdfgh` gets nothing, which is correct.
 *
 * ## Why "redirect, don't render" for near-misses
 *
 * A visitor who typed `plumber` on a page about `plumbing` got there by intent,
 * not by a crawler exploring a parameter space. Redirecting them is *helpful*.
 * A crawler walking `/tools/ai-visibility/{niche}` hoping for indexable space is
 * the case the whitelist exists to stop, and it gets a 404 either way — so the
 * redirect is not a hole in the gate, it only applies to slugs that already
 * resolved to a real page.
 */

export type Niche = {
  /** URL segment, lowercase and hyphenated. The canonical form. */
  slug: string;
  /** The name used in the title and the H1. */
  label: string;
  /**
   * One sentence about what AI engines are actually asked in this niche. This is
   * the field that makes a page worth indexing, and it is hand-written per
   * niche for the same reason the slug is whitelisted: a generated one is a
   * template with a noun swapped.
   */
  whatAiIsAsked: string;
  /**
   * The kind of source AI engines cite in this niche, where known. Null rather
   * than invented — a page that guesses its own citations is the exact failure
   * this product exists to avoid, and it would be the most-read page on the site.
   */
  typicalSources: string | null;
};

/**
 * The curated registry.
 *
 * Small on purpose. Every entry is a niche we have something specific to say, and
 * the cost of each is that someone has to keep its `whatAiIsAsked` true. A
 * thousand-entry generated list would be one bug away from being a doorway farm,
 * and the bug would be invisible because the pages would render fine.
 */
const NICHES: readonly Niche[] = [
  {
    slug: "dental",
    label: "Dental practices",
    whatAiIsAsked:
      "AI engines are asked about symptoms, procedures, cost, and 'is this worth it' questions far more than they are asked which practice to book. The visibility question is whether your practice is the named answer or an unlinked mention.",
    typicalSources:
      "Health authority pages, review aggregators, and large dental-plan explainers.",
  },
  {
    slug: "plumbing",
    label: "Plumbing services",
    whatAiIsAsked:
      "Emergency phrasing dominates: 'who do I call at 2am'. That means the AI answer is often a list, and being on it at all matters more than being first.",
    typicalSources:
      "Trade directories, national emergency services, and manufacturer guides.",
  },
  {
    slug: "legal",
    label: "Law firms",
    whatAiIsAsked:
      "Mostly 'can I sue for X' and 'how much does this cost', which are answerable in general terms — so the citation is usually a reference page rather than a firm. A firm that wants the mention has to be the one the model can name for its region.",
    typicalSources:
      "Legal-aid bodies, government guidance pages, and encyclopaedic summaries.",
  },
  {
    slug: "accounting",
    label: "Accounting firms",
    whatAiIsAsked:
      "Deadline and liability questions dominate, and they are jurisdiction-specific. The AI answer tends to be generic unless the model can attach a region, which is why a named local practice is rare in citations.",
    typicalSources:
      "Government tax portals, professional bodies, and major publishers.",
  },
  {
    slug: "real-estate",
    label: "Real estate agencies",
    whatAiIsAsked:
      "Market-level questions — 'is now a good time to buy', 'what are closing costs' — carry most of the volume, and the answers point at market reports rather than agencies. An agency's visibility is often as a named local expert rather than as a source.",
    typicalSources:
      "Market-data providers, property portals, and major news outlets.",
  },
] as const;

const BY_SLUG = new Map(NICHES.map((niche) => [niche.slug, niche]));

/**
 * What a URL segment resolved to.
 *
 * Not exported: the union is consumed only through `resolveNiche`'s return, and
 * a caller narrows on `kind` rather than naming the type. knip enforces that.
 */
type NicheResolution =
  | { kind: "found"; niche: Niche }
  /** A slug that normalises to a real niche. The client should redirect. */
  | { kind: "redirect"; to: string }
  /** Not a niche we have a page for. The client should 404. */
  | { kind: "not-found" };

/**
 * Resolve a URL segment to a niche.
 *
 * `niche` is deliberately `unknown`-ish in practice: it arrives from the URL, so
 * it is treated as untrusted. Nothing is trusted except that the slugs in
 * {@link NICHES} exist.
 */
export function resolveNiche(segment: string | undefined): NicheResolution {
  if (segment === undefined) return { kind: "not-found" };
  const slug = normalise(segment);
  if (slug === "") return { kind: "not-found" };

  const direct = BY_SLUG.get(slug);
  if (direct !== undefined) return { kind: "found", niche: direct };

  // A near-miss that normalises onto a real slug is a typo, not an indexable
  // surface. Redirects to *existing* pages cannot create one, which is why this
  // is safe alongside the whitelist.
  const alternative = suggest(slug);
  if (alternative !== null) return { kind: "redirect", to: alternative };

  return { kind: "not-found" };
}

/**
 * Normalise a segment to its canonical form.
 *
 * `Dental`, `dental/`, `%20dental%20` and `Dental-Practices` are all attempts at
 * the same page, and a page that 404s for its own nickname is a page that loses
 * a share to a typo. The *last* meaningful segment is also accepted, so
 * `dentistry` → `dental` and `accountants` → `accounting` are near-misses rather
 * than dead ends.
 */
function normalise(segment: string): string {
  return (
    decodeURIComponent(segment)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split(/[/?#]/)[0]
      ?.split(".")[0] ?? ""
  );
}

/**
 * A near-miss suggestion, or null.
 *
 * The mapping is explicit rather than fuzzy: a string-distance heuristic over a
 * small set will happily suggest `dental` for `mental`, and a 404 is a better
 * outcome than a redirect that lands a visitor on a page about the wrong
 * industry.
 */
const ALIASES: Record<string, string> = {
  dentist: "dental",
  dentistry: "dental",
  teeth: "dental",
  dentisty: "dental",
  plumber: "plumbing",
  plumbers: "plumbing",
  lawyer: "legal",
  lawyers: "legal",
  attorney: "legal",
  attorneys: "legal",
  accountant: "accounting",
  accountants: "accounting",
  bookkeeping: "accounting",
  realtor: "real-estate",
  realtors: "real-estate",
  estate: "real-estate",
};

function suggest(slug: string): string | null {
  const aliased = ALIASES[slug];
  if (aliased !== undefined && BY_SLUG.has(aliased)) return aliased;
  return null;
}

/** The canonical path for a niche. Single source of truth for links and sitemaps. */
export function nichePath(slug: string): string {
  return `/tools/ai-visibility/${slug}`;
}

/** Every registered niche, for a sitemap. Order is the registry's, not sorted. */
export function listNiches(): readonly Niche[] {
  return NICHES;
}
