import { createFileRoute, Link } from "@tanstack/react-router";
import { ComparisonTable } from "@/components/comparison-table";
import {
  COMPARE_CLAIMS,
  COMPARE_COLUMNS,
  COMPARE_ROWS,
} from "@/lib/compare-data";
import { buildPageSeo } from "@/lib/seo";

/**
 * The page container. `_marketing.tsx` wraps every non-home marketing page in a
 * `max-w-5xl` canvas **and** a footer, so this page opts out of that wrapper and
 * renders full-width sections of its own — the comparison table needs the width,
 * and the homepage is the only other page that gets it.
 */
const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="fd-light min-h-screen bg-[var(--color-surface)] text-[var(--color-brand)]">
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">{children}</div>
  </main>
);

/**
 * `/compare` — CL-818.
 *
 * ## What this page is for
 *
 * `competitors.md` finding 4, from the research: a technical buyer's real sequence
 * is **comparison → verification → demo**, and almost nobody writes for it. Peec
 * opens "AI search analytics for marketing teams"; Otterly opens a pun. Neither
 * tells you where it is worse than the alternative, because a page that admits
 * that is a page nobody wrote.
 *
 * ## The rule this page keeps
 *
 * **Every row is one a reader can check, and three of them we lose.**
 *
 * Engine count is the shortest list in the table. Every competitor stores the
 * verbatim answer, and the row says so for all four. And the run-diff row is
 * phrased "not documented" rather than "does not have", because we read their
 * pricing pages, docs and changelogs — which is not the same as logging in and
 * proving absence, and a page that overstates that is the exact failure this
 * product argues against.
 *
 * `docs/design-research/cl-818-competitor-facts.md` records every figure with its
 * source and the date it was read. Prices move; that file is what makes a stale
 * claim correctable rather than merely embarrassing.
 */
export const Route = createFileRoute("/_marketing/compare")({
  head: () =>
    buildPageSeo({
      title: "OpenGeo compared",
      description:
        "An honest comparison of OpenGeo against Peec AI, Otterly AI, Scrunch and Profound — including the rows where they are better. Verified against each vendor's own pricing and docs, 2026-10-03.",
      path: "/compare",
      titleSuffix: "OpenGeo",
    }),
  component: Compare,
});

function Compare() {
  return (
    <>
      <section className="itc-hero itc-hero--claim">
        <Shell>
          <p className="itc-eyebrow">Comparison</p>
          <h1 className="itc-display-xl itc-hero-title">
            Four tools, side by side.
            <br />
            Including the rows we lose.
          </h1>
          <p className="itc-subhead itc-muted itc-hero-subtitle">
            Every figure below was read from that vendor&rsquo;s own pricing
            page or API documentation. Where a price is not published, the cell
            says so rather than guessing. Three of these rows are{" "}
            <strong>not ours</strong> &mdash; they are in the table because you
            would find them yourself.
          </p>
          <p className="itc-hero-note">
            Read 2026-10-03. Prices move;{" "}
            <Link to="/methodology" className="itc-hero-evidence">
              our numbers carry their provenance
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </p>
        </Shell>
      </section>

      <section className="itc-claims">
        <Shell>
          <ComparisonTable
            columns={COMPARE_COLUMNS}
            rows={COMPARE_ROWS}
            caption="OpenGeo compared with Peec AI, Otterly AI, Scrunch and Profound, across price, licensing, engine coverage, answer storage, cost transparency and change attribution."
          />

          {/* **The mobile note.** Below 768px the table reflows into labelled
              rows rather than scrolling, because a scrolled comparison on a phone
              shows the reader only our column — the one thing this page must not
              do. This is where to say so, because a reader comparing on a phone
              is exactly the reader who would otherwise miss the others. */}
          <p className="itc-run-foot md:hidden">
            On a phone this table reflows into one block per row, with each
            vendor named. It is deliberately not a horizontal scroll: a scrolled
            comparison shows you only one column.
          </p>
        </Shell>
      </section>

      <section className="itc-oss">
        <Shell>
          <h2 className="itc-display-md itc-claims-title">
            What we would put our name to.
          </h2>
          {/* The claims are a stack, not a grid: they are unequal, and each one
              carries the evidence it rests on. */}
          <ol className="itc-claim-list">
            {COMPARE_CLAIMS.map((c, i) => (
              <li className="itc-claim" key={c.claim}>
                <span className="itc-claim-n" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="itc-claim-body">
                  <h3 className="itc-claim-title">{c.claim}</h3>
                  <p className="itc-claim-mechanism">{c.detail}</p>
                  <p className="itc-claim-code">
                    <code>{c.evidence}</code>
                  </p>
                </div>
              </li>
            ))}
          </ol>

          {/* **The alternative recommendation.** A comparison page that only wins
              is one a technical reader knows only wins, and it is the reason the
              engine-count row above says what it says. */}
          <div className="itc-oss-copy">
            <h3 className="itc-claim-title">
              Where one of them is the right choice
            </h3>
            <p className="itc-claim-mechanism">
              If you need more than four engines on day one and have the budget
              for it, Peec AI tracks seven on its entry tier and thirteen at the
              top, and that is a real advantage. If you want a pre-publish
              citation readiness score, Otterly ships one. If your procurement
              requires an enterprise API today, Scrunch and Profound both
              qualify and we are not there yet.
            </p>
            <p className="itc-claim-mechanism">
              If you want the cheapest paid plan, a run-over-run diff, and the
              option to take it off our servers entirely &mdash; that is the
              case this page is making.
            </p>
          </div>
        </Shell>
      </section>

      <section className="itc-final">
        <Shell>
          <h2 className="itc-display-md itc-final-title">
            Check any of it yourself.
          </h2>
          <p className="itc-final-sub">
            The methodology page carries the endpoint, the date and the
            arithmetic behind our numbers. Every one of them is reproducible.
          </p>
          <div className="itc-final-actions">
            <a
              href="https://app.opengeo.so/sign-up"
              className="itc-btn-primary itc-btn-lg"
            >
              Start free
              <span aria-hidden="true">&rarr;</span>
            </a>
            <Link to="/methodology" className="itc-hero-evidence">
              Read the method first
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>
        </Shell>
      </section>
    </>
  );
}
