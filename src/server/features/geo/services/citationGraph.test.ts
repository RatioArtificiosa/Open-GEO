import { describe, expect, it } from "vitest";
import { buildCitationGraph } from "./citationGraph";

/**
 * The citation graph and the "earn the citation" list.
 *
 * The fixtures are the **real** `sources_domain` rows from the documented
 * `target_metrics` response: reddit, Edmunds, KBB, Car and Driver — and
 * `carinterior.alibaba.com`, which is the domain the proposal singles out when it
 * claims *"DR alone does not earn AI citations."* Those are not invented
 * examples, and the ordering rules are built so the list does the opposite of
 * what a domain-rating tool would do with them.
 */

const build = (
  domains: Array<{
    domain: string;
    citations: number;
    pages?: number;
    backlinksToUs?: number | null;
    anchors?: string[] | null;
  }>,
  ownDomain = "acme.com",
) =>
  buildCitationGraph({
    ownDomain,
    domains: domains.map((d) => ({
      pages: d.pages ?? 1,
      backlinksToUs: d.backlinksToUs ?? null,
      anchors: d.anchors ?? null,
      citations: d.citations,
      domain: d.domain,
    })),
  });

describe("buildCitationGraph", () => {
  it("puts the unreachable domain first, not the famous one", () => {
    // The finding, in one assertion. A contested domain with 4 citations outranks
    // a reachable one with 400, because the reachable one needs no work and the
    // list exists to say what to do.
    const graph = build([
      { domain: "www.reddit.com", citations: 3978, backlinksToUs: 12 },
      { domain: "carinterior.alibaba.com", citations: 598, backlinksToUs: 0 },
    ]);
    expect(graph.outreach.map((d) => d.domain)).toEqual([
      "carinterior.alibaba.com",
      "www.reddit.com",
    ]);
  });

  it("names reachability rather than authority", () => {
    // We have a link count. We do not have Domain Rating, and a column headed
    // "authority" over a link count is a number wearing a label it has not earned.
    const graph = build([{ domain: "a.com", citations: 1 }]);
    expect(graph.caveat).toMatch(/reachability, not authority/i);
    expect(graph.caveat).toMatch(/no domain rating/i);
  });

  it("states the finding that inverts a DR-ranked list", () => {
    // Real documented rows, with exactly one of the three unreachable. The
    // unreachable one is also the *least* cited of the three, so a list ordered
    // by volume would put it last — which is the point.
    const graph = build([
      { domain: "www.reddit.com", citations: 3978, backlinksToUs: 12 },
      { domain: "www.kbb.com", citations: 1481, backlinksToUs: 3 },
      { domain: "carinterior.alibaba.com", citations: 598, backlinksToUs: 0 },
    ]);
    expect(graph.insight).toMatch(/1 of 3 domains/i);
    expect(graph.insight).toMatch(/no inbound path/i);
    expect(graph.insight).toMatch(/cannot show you/i);
  });

  it("counts every unreachable domain, not just the first", () => {
    // A count that under-reports is worse than no count: it makes a problem look
    // smaller than it is, which is the direction a reader cannot check.
    const graph = build([
      { domain: "www.reddit.com", citations: 3978, backlinksToUs: 12 },
      { domain: "carinterior.alibaba.com", citations: 598, backlinksToUs: 0 },
      { domain: "www.kbb.com", citations: 1481, backlinksToUs: null },
    ]);
    expect(graph.unreached).toHaveLength(2);
    expect(graph.insight).toMatch(/2 of 3 domains/i);
  });

  it("withholds the finding when the archive is too thin to support it", () => {
    // An insight from two domains is an anecdote. Producing a confident sentence
    // about a sample that small is the failure this null exists to prevent.
    const graph = build([
      { domain: "a.com", citations: 5, backlinksToUs: 0 },
      { domain: "b.com", citations: 3, backlinksToUs: 0 },
    ]);
    expect(graph.insight).toBeNull();
  });

  it("treats no backlink data as a finding, not a zero", () => {
    // Null and 0 are the same *action* — go and earn it — and different *facts*,
    // so the copy says which one it is.
    const unknown = build([
      { domain: "x.com", citations: 5, backlinksToUs: null },
    ]);
    const none = build([{ domain: "x.com", citations: 5, backlinksToUs: 0 }]);
    expect(unknown.outreach[0]?.status).toBe("contested");
    expect(unknown.outreach[0]?.nextStep).toMatch(/study which of your pages/i);
    expect(none.outreach[0]?.nextStep).toMatch(/cheapest move/i);
  });

  it("excludes the customer's own domain from the outreach list", () => {
    // Your own domain is not something to go and earn.
    const graph = build([
      { domain: "acme.com", citations: 500, backlinksToUs: 999 },
      { domain: "other.com", citations: 5, backlinksToUs: 0 },
    ]);
    expect(graph.outreach.map((d) => d.domain)).toEqual(["other.com"]);
  });

  it("offers no next step for a domain we already reach", () => {
    // A list of twenty "get backlinks to this" tasks for domains we already link
    // to is a list of twenty things not to do.
    const graph = build([{ domain: "a.com", citations: 5, backlinksToUs: 3 }]);
    expect(graph.outreach[0]?.status).toBe("reachable");
    expect(graph.outreach[0]?.nextStep).toBeNull();
  });

  it("says the list is maintenance when everything is reachable", () => {
    const graph = build([
      { domain: "a.com", citations: 5, backlinksToUs: 3 },
      { domain: "b.com", citations: 4, backlinksToUs: 2 },
      { domain: "c.com", citations: 3, backlinksToUs: 1 },
    ]);
    expect(graph.unreached).toEqual([]);
    expect(graph.insight).toMatch(/maintenance task, not an outreach list/i);
  });

  it("normalises the own-domain comparison the same way as everything else", () => {
    // A customer typing "www.acme.com" must not find their own domain in the
    // outreach list, which is the one entry on that page that makes no sense.
    const graph = build(
      [{ domain: "acme.com", citations: 500, backlinksToUs: 999 }],
      "https://www.acme.com/",
    );
    expect(graph.outreach).toEqual([]);
  });
});
