import { describe, expect, it } from "vitest";
import { buildCoCitations } from "./citationCoCitations";

const cite = (answerId: string, domain: string) => ({ answerId, domain });

describe("buildCoCitations", () => {
  it("edges two domains only when one answer cited both", () => {
    const { nodes, links } = buildCoCitations([
      cite("a1", "reddit.com"),
      cite("a1", "kbb.com"),
      cite("a2", "reddit.com"),
    ]);

    expect(nodes).toEqual([
      { domain: "reddit.com", answers: 2 },
      { domain: "kbb.com", answers: 1 },
    ]);
    // One shared answer, so one edge — and only that edge.
    expect(links).toEqual([{ a: "kbb.com", b: "reddit.com", answers: 1 }]);
  });

  it("weights an edge by distinct answers, not by rows", () => {
    const { links } = buildCoCitations([
      // The same host cited twice from one answer counts once: the composite key
      // upstream de-duplicates by URL, and this de-duplicates by host.
      cite("a1", "reddit.com"),
      cite("a1", "www.reddit.com"),
      cite("a1", "kbb.com"),
      cite("a2", "reddit.com"),
      cite("a2", "kbb.com"),
    ]);
    expect(links).toEqual([{ a: "kbb.com", b: "reddit.com", answers: 2 }]);
  });

  it("orders the pair lexically, so a pair has one representation", () => {
    const forward = buildCoCitations([
      cite("a1", "alpha.com"),
      cite("a1", "beta.com"),
    ]);
    const backward = buildCoCitations([
      cite("a1", "beta.com"),
      cite("a1", "alpha.com"),
    ]);
    expect(forward.links).toEqual(backward.links);
    expect(forward.links[0]).toMatchObject({ a: "alpha.com", b: "beta.com" });
  });

  it("keeps an isolated domain as a node, because it is still cited", () => {
    // The interesting domain in this product is the one AI cites with no path
    // from our site — and it may share no answer with anything else.
    const { nodes, links } = buildCoCitations([
      cite("a1", "lonely.example"),
      cite("a2", "reddit.com"),
      cite("a2", "kbb.com"),
    ]);
    expect(nodes.map((node) => node.domain)).toContain("lonely.example");
    expect(links).toHaveLength(1);
  });

  it("caps the node count on answer volume, with a stable tie-break", () => {
    const rows = [
      cite("a1", "high.com"),
      cite("a2", "high.com"),
      cite("a3", "high.com"),
      cite("a1", "mid.com"),
      cite("a2", "mid.com"),
      cite("a1", "low-a.com"),
      cite("a1", "low-b.com"),
    ];
    const { nodes } = buildCoCitations(rows, { maxDomains: 3 });
    expect(nodes.map((node) => node.domain)).toEqual([
      "high.com",
      // `mid.com` has two answers; the two single-answer domains tie, and the
      // name breaks it so the order cannot flicker between runs.
      "mid.com",
      "low-a.com",
    ]);
  });

  it("never links to a domain the cap removed", () => {
    const rows = [
      cite("a1", "kept.com"),
      cite("a2", "kept.com"),
      // A third answer, so `kept.com` outranks `cut.com` on volume rather than
      // on the alphabetical tie-break.
      cite("a3", "kept.com"),
      cite("a1", "cut.com"),
      cite("a2", "cut.com"),
    ];
    const { nodes, links } = buildCoCitations(rows, { maxDomains: 1 });
    expect(nodes.map((node) => node.domain)).toEqual(["kept.com"]);
    // The pair exists in the data and one of its ends was cut, so it is not
    // drawn: an edge to a node that is not on the screen is a lie about shape.
    expect(links).toEqual([]);
  });

  it("caps the link count, strongest first", () => {
    const rows = [
      ...["a", "b", "c"].map((d) => cite("a1", `${d}.com`)),
      ...["a", "b"].map((d) => cite("a2", `${d}.com`)),
      cite("a3", "a.com"),
      cite("a3", "c.com"),
    ];
    const { links } = buildCoCitations(rows, { maxLinks: 1 });
    expect(links).toEqual([{ a: "a.com", b: "b.com", answers: 2 }]);
  });

  it("cites nothing from a null or malformed domain", () => {
    const { nodes, links } = buildCoCitations([
      { answerId: "a1", domain: null },
      { answerId: "a1", domain: "  " },
      cite("a1", "reddit.com"),
    ]);
    expect(nodes).toEqual([{ domain: "reddit.com", answers: 1 }]);
    expect(links).toEqual([]);
  });
});
