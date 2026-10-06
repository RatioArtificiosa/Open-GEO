import { useMemo } from "react";
import { sortBy } from "remeda";
import { forceLayout } from "./citationForceLayout";

/**
 * The co-citation graph — §14.4's *"force graph second"*.
 *
 * ## Why it is second, and why it is here at all
 *
 * §14.4 is blunt about the order: *"An elegant ranked list first, force graph
 * second. Most teams won't read a hairball."* So this renders **behind a toggle**
 * on a panel that opens on the list, and it is deliberately small — the server
 * caps it to a couple of dozen domains before it ever arrives (see
 * `citationCoCitations`). A graph earns its place because it answers a question a
 * list cannot: **which sources the engines reach for together.** Two domains one
 * answer cited side by side are a neighbourhood; a list can only rank them.
 *
 * ## The reading, stated so it is not over-read
 *
 * A line is a joint citation, and its weight is how many archived answers cited
 * both. **It is not a link between the domains and it is not affinity** — it is
 * co-occurrence in our own archive, which is a fact about what the models did,
 * not a fact about the web. Nothing is inferred and nothing is scored, the same
 * line the ranked list draws.
 *
 * ## One colour, and the geometry is memoised
 *
 * Nodes and edges are **muted ink**: §2.3 caps the accent at ~3% of a viewport and
 * a graph is a lot of ink, so the page's one accent stays where it is. Size and
 * opacity carry the encoding instead.
 *
 * The layout is computed in a single `useMemo` that maps the server's shape to the
 * layout's **inside** the memo. Mapping in the component body would build fresh
 * arrays on every render, the memo would see new dependencies each time, and the
 * graph would lay itself out again on every keystroke elsewhere on the page.
 */

const WIDTH = 360;
const HEIGHT = 260;

/** Labels past this many nodes turn the picture back into the hairball. */
const MAX_LABELS = 7;

export function CitationGraphView({
  nodes,
  links,
}: {
  nodes: Array<{ domain: string; answers: number }>;
  links: Array<{ a: string; b: string; answers: number }>;
}) {
  const drawn = useMemo(() => {
    const forceNodes = nodes.map((node) => ({
      id: node.domain,
      weight: node.answers,
    }));
    const forceLinks = links.map((link) => ({
      a: link.a,
      b: link.b,
      weight: link.answers,
    }));
    return {
      positions: forceLayout(forceNodes, forceLinks),
      // The heaviest domains get a label; the rest are shapes with a title, since
      // a label on every node is unreadable at this size.
      labelled: new Set(
        sortBy(forceNodes, [(node) => node.weight, "desc"])
          .slice(0, MAX_LABELS)
          .map((node) => node.id),
      ),
      heaviest: Math.max(...forceNodes.map((node) => node.weight), 1),
      heaviestLink: Math.max(...forceLinks.map((link) => link.weight), 1),
    };
  }, [nodes, links]);

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-base-content/60">
        No domains to plot yet. The graph needs answers that cited more than one
        source.
      </p>
    );
  }

  const { positions, labelled, heaviest, heaviestLink } = drawn;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full text-base-content/45"
        role="img"
        aria-label={`${nodes.length} cited domains and ${links.length} shared-citation links. The list is the same data in words.`}
      >
        {links.map((link) => {
          const from = positions.get(link.a);
          const to = positions.get(link.b);
          if (!from || !to) return null;
          return (
            <line
              key={`${link.a}|${link.b}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="currentColor"
              strokeWidth={0.5 + (link.answers / heaviestLink) * 1.5}
              // A weak pairing recedes rather than disappears: a faint line is a
              // real observation, and dropping it would redraw the graph's shape.
              opacity={0.15 + (link.answers / heaviestLink) * 0.5}
            />
          );
        })}

        {nodes.map((node) => {
          const point = positions.get(node.domain);
          if (!point) return null;
          const radius = 3 + (node.answers / heaviest) * 7;
          return (
            <g key={node.domain}>
              <title>{`${node.domain} — cited in ${node.answers} archived answer${node.answers === 1 ? "" : "s"}`}</title>
              <circle
                cx={point.x}
                cy={point.y}
                r={radius}
                fill="currentColor"
                opacity={0.55}
              />
              {labelled.has(node.domain) ? (
                <text
                  x={point.x}
                  y={point.y - radius - 3}
                  textAnchor="middle"
                  className="fill-base-content/70"
                  fontSize="8"
                >
                  {node.domain.length > 22
                    ? `${node.domain.slice(0, 21)}…`
                    : node.domain}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-xs text-base-content/55">
        A line joins two domains one archived answer cited together, and its
        weight is how many answers did. That is co-citation in our archive — not
        a link between the domains, and not a score.
      </figcaption>
    </figure>
  );
}
