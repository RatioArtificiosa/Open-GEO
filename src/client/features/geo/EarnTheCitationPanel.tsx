/**
 * The earn-the-citation list.
 *
 * **The inverse of a domain-rating tool, and that is the whole claim.** AI engines
 * cite low-authority long-tail domains — the proposal names two it saw in the
 * *documented vendor response*, sitting among reddit and Edmunds — and concludes
 * that DR alone does not earn AI citations. Ranking those domains by authority
 * would put every domain the models actually use at the bottom, which is why a
 * "ranked by DR" list is the wrong product.
 *
 * ## What the statuses mean, and why they are not a score
 *
 * `contested` / `reachable` / `owned` are named by **what the reader can do**, never
 * by a score — a score invites a ranking, and the ordering that matters is
 * contested-first because the reachable ones need no work. A list of twenty "get
 * backlinks to this" tasks for domains we already link to is a list of twenty
 * things not to do, so a reachable domain offers **no next step at all**.
 *
 * ## The caveat is not optional
 *
 * We hold **no Domain Rating and no traffic estimate** for these domains. What we
 * hold is how many of your pages link to one, which predicts whether an outreach
 * email gets read — a different and much weaker claim. A list headed "authority"
 * over a backlink count is a number wearing a label it has not earned, so the
 * server's caveat is rendered verbatim rather than summarised, and a missing one
 * renders as a visible warning rather than being silently dropped.
 *
 * ## Four states, because they are four different facts
 *
 * - an error, which the page states;
 * - **no insight** — the archive is too thin, and that is not the same as "nothing
 *   was cited";
 * - an insight and no outreach — everything cited is already reachable;
 * - an insight with a list.
 */
import { useState, type ReactNode } from "react";
import { CitationGraphView } from "./CitationGraphView";

/** One row, as `buildCitationGraph` produces it. */
type EarnableDomain = {
  domain: string;
  citations: number;
  pages: number;
  backlinksToUs: number | null;
  anchors: string[] | null;
  status: "contested" | "reachable" | "owned";
  nextStep: string | null;
};

/**
 * The four fields the panel reads.
 *
 * **Not exported**, and knip is right to object when it was: the panel takes the
 * whole object from `useGeoPageData` and nothing imports the type by name. An
 * exported type nothing imports is a claim about the API surface that is not true —
 * the same argument the schema file makes at the bottom of itself.
 */
type CitationGraphData = {
  outreach: EarnableDomain[];
  unreached: string[];
  insight: string | null;
  caveat: string | null;
  /** The co-citation edges, already capped by the server. Empty when too thin. */
  coCitations: {
    nodes: Array<{ domain: string; answers: number }>;
    links: Array<{ a: string; b: string; answers: number }>;
  };
};

export function EarnTheCitationPanel({
  data,
  errorMessage,
  targetName,
}: {
  data: CitationGraphData;
  errorMessage: string | null;
  targetName: string | null;
}): ReactNode {
  // §14.4's ordering, as state: **the list is the opening view and the graph is
  // the second one**, because "most teams won't read a hairball". Declared above
  // the error return, since a hook after it would be conditional.
  const [view, setView] = useState<"list" | "graph">("list");

  if (errorMessage !== null) {
    return (
      <section
        aria-label="Earn the citation"
        className="rounded-xl border border-base-300 bg-base-100 p-4"
      >
        <h2 className="text-base font-semibold">Earn the citation</h2>
        <p className="mt-3 text-sm text-base-content/70">{errorMessage}</p>
      </section>
    );
  }

  const hasWork = data.outreach.some((row) => row.nextStep !== null);

  return (
    <section
      aria-label="Earn the citation"
      className="rounded-xl border border-base-300 bg-base-100 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Earn the citation</h2>
        {/* The toggle appears only when there is an edge to draw. A control that
            switches to an empty picture is worse than no control. */}
        {data.coCitations.nodes.length > 0 ? (
          <div className="join" role="group" aria-label="Citation view">
            {(["list", "graph"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                className={`btn btn-xs join-item ${view === option ? "btn-active" : "btn-ghost"}`}
                onClick={() => setView(option)}
              >
                {option === "list" ? "List" : "Graph"}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* §14.4's order, rendered: the list is the default and the graph is the
          alternative, never the other way round. */}
      {view === "graph" ? (
        <div className="mt-3">
          <CitationGraphView
            nodes={data.coCitations.nodes}
            links={data.coCitations.links}
          />
        </div>
      ) : (
        <>
          {data.insight === null ? (
            <>
              <p className="mt-3 text-sm text-base-content/70">
                Not enough archived answers yet to say which sources the AI
                engines pick. This needs a few more nightly runs before it means
                anything, so it would rather say so than list two domains and
                call it a finding.
              </p>
              {/*
            The list still renders below, because "we cannot conclude yet" and
            "there is nothing to do" are different statements and a reader who sees
            only the first would think the feature is broken.
          */}
            </>
          ) : (
            <p className="mt-3 text-sm text-base-content/70">{data.insight}</p>
          )}

          {hasWork ? (
            <ul className="mt-3 space-y-2 text-sm">
              {data.outreach
                .filter((row) => row.nextStep !== null)
                .slice(0, 10)
                .map((row) => (
                  <li key={row.domain}>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{row.domain}</span>
                      <span className="text-xs text-base-content/60">
                        cited in {row.citations} of our archived answers
                        {row.backlinksToUs === null
                          ? " · we have no backlink data for it"
                          : ` · ${row.backlinksToUs} of our pages link to it`}
                      </span>
                    </div>
                    {/* The action is the row's own sentence, server-side. A second
                    phrasing written here is a second text to keep in step, and the
                    module already argues why each status implies its action. */}
                    <p className="text-xs text-base-content/70">
                      {row.nextStep}
                    </p>

                    {/*
                     * **The anchor text is declared here and arrives as nothing.**
                     *
                     * `citationGraph`'s docstring says the overlay is "how many pages
                     * of yours link here, and what does the anchor text look like",
                     * and its type carries `anchors` for exactly that reason. But
                     * `geoCitationGraph` passes **`backlinksToUs: null`** and never
                     * sets `anchors` at all, because `listCitationDomains` returns a
                     * mention count and nothing else — there is no backlink data behind
                     * it to read.
                     *
                     * So the branch is deliberately **inert**, and the note says so
                     * rather than leaving a reader to wonder. A non-empty `anchors`
                     * would mean the backlinks layer had been connected, and nothing
                     * renders until it is. Writing the JSX and leaving it dark would
                     * have been a fourth way of pretending a field is live.
                     */}
                    {row.anchors !== null && row.anchors.length > 0 ? (
                      <p className="mt-1 text-xs text-base-content/60">
                        Linked to from{" "}
                        {row.anchors
                          .slice(0, 3)
                          .map((anchor) => `“${anchor}”`)
                          .join(", ")}
                        {row.anchors.length > 3
                          ? `, and ${row.anchors.length - 3} more`
                          : ""}
                        . An outreach email to a domain is likelier to be read
                        when it names the same thing its existing links do.
                      </p>
                    ) : null}
                  </li>
                ))}
              {data.outreach.filter((row) => row.nextStep !== null).length >
              10 ? (
                <li className="text-xs text-base-content/60">
                  …and{" "}
                  {data.outreach.filter((row) => row.nextStep !== null).length -
                    10}{" "}
                  more
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-base-content/60">
              {data.outreach.length === 0
                ? "No citing domains are recorded yet."
                : targetName !== null
                  ? "Every domain the AI engines cite for this brand is one our own pages already link to. There is nothing to go earn."
                  : "Every domain the AI engines cite is one our own pages already link to. There is nothing to go earn."}
            </p>
          )}

          {data.unreached.length > 0 ? (
            <p className="mt-3 text-xs text-base-content/70">
              <span className="font-medium">
                Cited by the AI engines, reached by nothing of ours:
              </span>{" "}
              {data.unreached.slice(0, 8).join(", ")}
              {data.unreached.length > 8
                ? `, and ${data.unreached.length - 8} more.`
                : "."}
            </p>
          ) : null}
        </>
      )}

      {data.caveat ? (
        /*
          **Rendered verbatim, and visible rather than a tooltip.** The panel's whole
          argument is that this is not an authority ranking; a caveat nobody opens
          turns the panel into the DR list the proposal argues against. A missing
          caveat renders as a warning rather than being dropped, because the server
          always sends one and its absence is a defect worth surfacing.
        */
        <p className="mt-3 border-t border-base-300 pt-3 text-xs text-base-content/50">
          {data.caveat}
        </p>
      ) : (
        <p className="mt-3 border-t border-base-300 pt-3 text-xs text-base-content/60">
          The caveat that should appear here is missing, which is a defect
          rather than a simplification: this list is reachability and must not
          be read as authority.
        </p>
      )}
    </section>
  );
}
