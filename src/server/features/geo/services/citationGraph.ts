import { hostOf } from "./urlIdentity";
import type { CoCitationLink, CoCitationNode } from "./citationCoCitations";

/**
 * The citation graph, and the "earn the citation" list.
 *
 * The proposal's observation is the whole reason this feature exists: **AI engines
 * cite low-authority, long-tail domains.** It names two it actually saw —
 * `carinterior.alibaba.com` and `everything.explained.today` — and draws the
 * conclusion *"DR alone does not earn AI citations."*
 *
 * Those two domains are not a hypothetical. They are in the **documented vendor
 * response** for `target_metrics` (see the `sources_domain` array in the
 * `llm_responses` docs), where they appear among reddit, Edmunds, KBB and Car and
 * Driver. That is the finding, and it is the reason a "ranked by DR" list is the
 * wrong product: ranking by DR would have put every one of the domains the models
 * actually use at the bottom.
 *
 * ## What we can and cannot say
 *
 * We have backlink data — referring pages, anchors, and for many domains a spam
 * score. We do **not** have Domain Rating, and we do not have traffic estimates.
 * So the overlay is: *how many pages of yours link here, and what does the anchor
 * text look like.* That is a **reachability** measure, and it is the one that
 * predicts whether an outreach email will be read.
 *
 * What we must not do is call it authority. That is the same line CL-813 draws
 * for citation concentration, and it is drawn again here deliberately: a list
 * headed "authority" over a metric that is a link count is a number wearing a
 * label it has not earned.
 *
 * ## The finding that inverts the list
 *
 * A domain cited constantly by AI engines, with no backlinks pointing at it from
 * anywhere, is **the most valuable thing on the page.** It means the models chose
 * it without a link graph we can see — which is exactly the domain worth
 * studying, and exactly the one a DR-ranked tool would have hidden.
 */

type CitationGraphNode = {
  domain: string;
  /** How many archived answers cited this domain. */
  citations: number;
  /** Distinct pages on this domain that were cited. */
  pages: number;
  /**
   * How many of *our* pages link here, per the backlinks index. Null when the
   * domain has no backlink data at all — which is a finding, not a zero.
   */
  backlinksToUs: number | null;
  /** The anchor texts of those backlinks, when we have them. */
  anchors: string[] | null;
};

type EarnableDomain = CitationGraphNode & {
  /**
   * `contested` — cited by AI, and we have no path to it.
   * `reachable` — cited by AI, and we already link to it.
   * `owned` — our own domain.
   *
   * Named by what the reader can *do*, not by how hard the domain is. "Easy" is a
   * score, and a score invites a ranking; these three are the actual situations.
   */
  status: "contested" | "reachable" | "owned";
  /** The one action, or null when there is nothing to do. */
  nextStep: string | null;
};

type CitationGraph = {
  nodes: CitationGraphNode[];
  /** Sorted for action, not by volume: contested first. */
  outreach: EarnableDomain[];
  /**
   * Domains cited by AI that nothing in our link graph reaches. The inverse of
   * what a DR tool would surface, and the reason this product is different.
   */
  unreached: string[];
  /**
   * The finding, in words. Null when the archive holds too little to support one —
   * "AI cites what we cannot reach" needs more than one domain behind it.
   */
  insight: string | null;
  /** What this graph is not. Always present. */
  caveat: string;
  /**
   * The co-citation view: which domains the engines reach for *together*, derived
   * from the answers that cited both (see `citationCoCitations`).
   *
   * **This is the force graph's data, and it is second by design.** §14.4 puts it
   * in that order — *"an elegant ranked list first, force graph second. Most teams
   * won't read a hairball"* — so it is carried beside the list rather than
   * instead of it, and it is absent (empty) when the archive is too thin to
   * support an edge.
   */
  coCitations: {
    nodes: CoCitationNode[];
    links: CoCitationLink[];
  };
};

const CAVEAT =
  "This is reachability, not authority. OpenGeo has no Domain Rating and no traffic estimate for these domains — what it has is how many of your pages link to them. A domain at the top of this list may be unranked by every traditional metric.";

export function buildCitationGraph(input: {
  /** The domain being analysed, so it can be excluded from the outreach list. */
  ownDomain: string;
  /**
   * Per domain: how many archived answers cited it, how many distinct pages, and
   * what the backlinks index knows. `backlinksToUs` null means no data, not zero.
   */
  domains: Array<{
    domain: string;
    citations: number;
    pages: number;
    backlinksToUs?: number | null;
    anchors?: string[] | null;
  }>;
  /** Fewer than this and the archive is too thin to support a finding. */
  minDomainsForInsight?: number;
  /** The edges, already capped and ordered. Absent when nothing was derived. */
  coCitations?: { nodes: CoCitationNode[]; links: CoCitationLink[] };
}): CitationGraph {
  const own = hostOf(input.ownDomain);
  const minDomains = input.minDomainsForInsight ?? 3;

  const nodes: CitationGraphNode[] = input.domains.map((row) => ({
    domain: row.domain,
    citations: row.citations,
    pages: row.pages,
    backlinksToUs: row.backlinksToUs ?? null,
    anchors: row.anchors ?? null,
  }));

  const outreach: EarnableDomain[] = nodes
    .filter((node) => (own !== null ? node.domain !== own : true))
    .map((node) => {
      if (own !== null && node.domain === own) {
        return { ...node, status: "owned" as const, nextStep: null };
      }
      // No backlink data and no backlinks are the same *action* — go and earn
      // it — but they are different *facts*, so only the known-zero case claims
      // to know there is no path.
      const unreachable =
        node.backlinksToUs === null || node.backlinksToUs === 0;
      return {
        ...node,
        status: unreachable ? ("contested" as const) : ("reachable" as const),
        nextStep: nextStepFor(node),
      };
    });

  // Contested first, then by citations descending. A contested domain with 4
  // citations is worth more than a reachable one with 400: the reachable one needs
  // no work, and the whole point of the list is what to do.
  //
  // A plain insertion loop rather than `sortBy` or native `sort`: `no-array-sort`
  // forbids the native one, `toSorted` is not in this repo's `lib` target, and
  // remeda's typed overloads fought the union return type for two attempts before
  // the rule was clearer written out. It is also the clearest statement of the
  // ordering, which is the part a reader has to check.
  const ranked: EarnableDomain[] = [];
  for (const node of outreach) {
    let at = ranked.length;
    for (let i = 0; i < ranked.length; i += 1) {
      const other = ranked[i];
      // Insert before the first entry that sorts *after* `node`.
      //
      // The operand order here is the bug this loop was written with. Calling
      // `ranksBefore(node, other)` asks "does the candidate go above this one?",
      // and inserting *before* on that answer reverses the list — which is exactly
      // the inversion CL-206 hit in the citation parser, and the tests caught it
      // the same way: by asserting a *specific* order rather than a count.
      if (other !== undefined && ranksBefore(node, other)) {
        at = i;
        break;
      }
    }
    ranked.splice(at, 0, node);
  }

  const unreached = ranked
    .filter((node) => node.status === "contested")
    .map((node) => node.domain);

  const graph: CitationGraph = {
    nodes,
    outreach: ranked,
    unreached,
    insight: null,
    caveat: CAVEAT,
    coCitations: input.coCitations ?? { nodes: [], links: [] },
  };
  graph.insight = describe(graph, minDomains);
  return graph;
}

/**
 * Does `first` belong above `second` in the outreach list?
 *
 * Contested beats reachable — a contested domain needs work and a reachable one
 * does not — and within a group the more citations win. Named as a rule rather
 * than inlined as a comparator so the ordering is one readable sentence.
 */
function ranksBefore(first: EarnableDomain, second: EarnableDomain): boolean {
  const firstGroup = first.status === "contested" ? 0 : 1;
  const secondGroup = second.status === "contested" ? 0 : 1;
  if (firstGroup !== secondGroup) return firstGroup < secondGroup;
  return first.citations > second.citations;
}

function nextStepFor(node: CitationGraphNode): string | null {
  if (node.backlinksToUs !== null && node.backlinksToUs > 0) return null;
  const cited = `Cited in ${node.citations} archived answer${node.citations === 1 ? "" : "s"}`;
  // The two cases are told apart by what we *know about the backlinks*, not by
  // whether we happen to hold their anchor text. A measured zero with no anchor
  // data is still "nothing links here, here is the move" — branching on `anchors`
  // instead sent the known-zero case down the "we know nothing" path, which is the
  // one thing the distinction exists to prevent.
  if (node.backlinksToUs === null) {
    return `${cited} and we have no backlink data for it. Study which of your pages the models already cite, then point one at this domain.`;
  }
  return `${cited} with no inbound path from your site. One relevant link from a page that already earns citations is the cheapest move here.`;
}

function describe(graph: CitationGraph, minDomains: number): string | null {
  const measured = graph.nodes.length;
  if (measured < minDomains) {
    // An insight from two domains is an anecdote. Saying so is better than
    // producing a confident sentence about a sample too small to carry it.
    return null;
  }
  if (graph.unreached.length === 0) {
    return "Every domain AI cites for this brand is already reachable from your site. The list is a maintenance task, not an outreach list.";
  }
  const share = Math.round((graph.unreached.length / measured) * 100);
  return `${graph.unreached.length} of ${measured} domains AI cites for this brand (${share}%) have no inbound path from your site. That is the finding a domain-rating tool cannot show you, because it scores the domains rather than measuring your reach to them.`;
}
