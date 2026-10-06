import { describe, expect, it } from "vitest";
import {
  forceLayout,
  type ForceLink,
  type ForceNode,
} from "./citationForceLayout";

const nodes = (...ids: string[]): ForceNode[] =>
  ids.map((id) => ({ id, weight: 1 }));

const distance = (
  positions: Map<string, { x: number; y: number }>,
  a: string,
  b: string,
) => {
  const p = positions.get(a);
  const q = positions.get(b);
  // Throwing rather than asserting: a missing position is a broken fixture, and a
  // message naming both ids is worth more than `undefined.property`.
  if (!p || !q) throw new Error(`no layout position for ${a} or ${b}`);
  return Math.hypot(p.x - q.x, p.y - q.y);
};

describe("the citation force layout", () => {
  it("lays the same graph out the same way every time", () => {
    // The property that decides this over `d3-force`: it seeds from sorted ids and
    // runs a fixed iteration count, so a picture does not move between renders and
    // a test can assert geometry rather than existence.
    const graph = nodes("a.com", "b.com", "c.com", "d.com");
    const links: ForceLink[] = [
      { a: "a.com", b: "b.com", weight: 3 },
      { a: "c.com", b: "d.com", weight: 1 },
    ];
    expect([...forceLayout(graph, links)]).toEqual([
      ...forceLayout(graph, links),
    ]);
  });

  it("puts domains that share answers closer than domains that share none", () => {
    // The claim the picture makes, asserted as a number. Two pairs, no links
    // between them, so the average distance within a pair must beat the average
    // across pairs.
    const graph = nodes("a.com", "b.com", "c.com", "d.com");
    const links: ForceLink[] = [
      { a: "a.com", b: "b.com", weight: 2 },
      { a: "c.com", b: "d.com", weight: 2 },
    ];
    const positions = forceLayout(graph, links);

    const linked =
      (distance(positions, "a.com", "b.com") +
        distance(positions, "c.com", "d.com")) /
      2;
    const unlinked =
      (distance(positions, "a.com", "c.com") +
        distance(positions, "a.com", "d.com") +
        distance(positions, "b.com", "c.com") +
        distance(positions, "b.com", "d.com")) /
      4;

    expect(linked).toBeLessThan(unlinked);
  });

  it("keeps every node inside the frame it was given", () => {
    // A node clipped at the edge is a node the reader cannot see.
    const graph = nodes(...Array.from({ length: 24 }, (_, i) => `d${i}.com`));
    const links: ForceLink[] = [{ a: "d0.com", b: "d1.com", weight: 4 }];
    const positions = forceLayout(graph, links, {
      width: 200,
      height: 160,
      padding: 20,
    });

    for (const point of positions.values()) {
      expect(point.x).toBeGreaterThanOrEqual(20);
      expect(point.x).toBeLessThanOrEqual(180);
      expect(point.y).toBeGreaterThanOrEqual(20);
      expect(point.y).toBeLessThanOrEqual(140);
    }
  });

  it("centres a loner, and returns nothing for nothing", () => {
    const single = forceLayout(nodes("only.com"), [], {
      width: 100,
      height: 80,
    });
    expect(single.get("only.com")).toEqual({ x: 50, y: 40 });
    expect(forceLayout([], []).size).toBe(0);
  });

  it("ignores a link whose end is not in the graph", () => {
    // The builder already refuses to emit these; the layout must not place a
    // phantom node if one arrives anyway.
    const positions = forceLayout(nodes("a.com", "b.com"), [
      { a: "a.com", b: "ghost.com", weight: 5 },
    ]);
    expect(positions.size).toBe(2);
    expect(positions.has("ghost.com")).toBe(false);
  });
});
