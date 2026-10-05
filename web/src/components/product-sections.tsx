import { Link } from "@tanstack/react-router";
import { Container } from "@/components/landing-page";
import { AnswerArchive } from "@/components/answer-archive";
import { VendorReceipt } from "@/components/vendor-receipt";

/**
 * The homepage's product sections — per
 * `docs/design-research/marketing-strategy.md` §7.
 *
 * ## What changed and why
 *
 * The previous spine argued that the product exists. **It never showed it.** The
 * hero carried a number, the wedge carried a premise, the claims carried four
 * assertions — and the actual product did not appear until a video still showing
 * someone else's product.
 *
 * This is the correction: **the archive demo and the vendor receipt are the page.**
 * Everything else is the argument that leads to them.
 *
 * ## The copy rule, applied throughout
 *
 * Every claim here is one the reader can check on this page or the next. That is
 * the strategy, not a style: a technical buyer does not convert to persuasion, they
 * convert to evidence, and unverifiable evidence is indistinguishable from the
 * marketing this category is full of.
 *
 * ## What was deliberately NOT written
 *
 * - No marketing superlatives — the catalogue in `scripts/banned-words.ts` is
 *   enforced by CL-807 and by the slop budget, and a page that names the banned
 *   words in order to ban them trips its own rule. On this buyer they cost
 *   credibility rather than gaining it.
 * - No urgency — no countdown, no "only N left", no activity counter. The FTC names
 *   each as a dark pattern, and persuasion-knowledge research shows scarcity is
 *   *weakest* on a buyer who verifies rather than believes.
 * - **The one claim we dropped.** "Every AI answer is stored whole" is true of us and
 *   **all four competitors already do it.** It is no longer offered as a
 *   difference. What replaced it is the diff — buildable, demonstrable, and shipped
 *   by nobody else.
 */

/** Find out, then prove why. The product, running, beside the argument. */
export function ProductProof() {
  return (
    <section className="itc-claims" id="archive">
      <Container>
        <h2 className="itc-display-md itc-claims-title">
          Find out what AI says about you.
          <br />
          Then prove why it changed.
        </h2>

        <div className="itc-proof-grid">
          <div className="itc-proof-copy">
            <p>
              Every tool in this category shows you today&rsquo;s number.
              Numbers move, and a number that moves without explanation is a
              number you cannot act on — or bill for.
            </p>
            <p>
              OpenGeo keeps every run. Pick two dates and it shows what the
              answer <strong>said</strong> on each, which sources appeared, and
              which ones moved position.
            </p>
            <p className="itc-proof-note">
              <strong>Nobody else ships this comparison.</strong> Their APIs can
              return both dates; they do not put them side by side, because a
              snapshot looks like a product and a diff looks like homework.
            </p>
            <Link
              to="/features/ai-brand-visibility"
              className="itc-claim-proof"
            >
              How the archive works
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>

          {/* **The product, running.** Interactive on purpose: an interaction is
              evidence, a screenshot is a claim. */}
          <AnswerArchive />
        </div>
      </Container>
    </section>
  );
}

/**
 * The bill — the differentiator no competitor can copy.
 *
 * **Corrected from a false version.** This component previously said we billed the
 * vendor cost "and nothing on top", so "the margin is zero". We do not: we are the
 * DataForSEO customer and we mark data up by a flat 28%. **A credibility asset built
 * on a false number is worse than no asset**, because a reader who does the
 * arithmetic finds the lie and stops trusting the rest.
 *
 * The honest version is a better claim — publishing the markup is the one thing a
 * competitor cannot do without publishing their own margin.
 */
export function TheBill() {
  return (
    <section className="itc-oss" id="bill">
      <Container>
        <div className="itc-bill-grid">
          <div className="itc-bill-copy">
            <h2 className="itc-display-md">
              Both numbers,
              <br />
              on the same row.
            </h2>
            <p>
              Every tool in this category prices by prompt and volume.{" "}
              <strong>
                None of them publish what the underlying data costs them
              </strong>
              , so you cannot check whether you are being marked up, or by how
              much.
            </p>
            <p>
              We are the DataForSEO customer, and we mark it up — a flat 28%,
              the same on every endpoint, printed next to what we pay.{" "}
              <strong>Multiply the two columns.</strong> That is the business
              model, and it is the same one every tool in this category runs.
            </p>
            <Link to="/methodology" className="itc-wedge-link">
              See the full method, and the endpoint behind every figure
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>

          <VendorReceipt />
        </div>
      </Container>
    </section>
  );
}

/**
 * The rest of the tool, for the reader who has just been convinced the archive is
 * real and now wants to know what else is there.
 *
 * **A left rail of capability groups, not a grid of cards** — the pattern read off
 * navbar.gallery and unsection, where a rail filters a body of examples. Here it
 * filters a body of capabilities, and each group is named for the **job** rather than
 * the module, because a reader looking for "prove what changed" does not know we
 * call it Answer Diffs.
 */
const GROUPS = [
  {
    label: "See what AI said",
    items: [
      {
        name: "AI Brand Visibility",
        to: "/features/ai-brand-visibility",
        note: "mentions, citations and share of voice across ChatGPT, Gemini, Perplexity and Google AI Overviews",
      },
      {
        name: "Prompt Explorer",
        to: "/features/ai-search-prompts",
        note: "run the prompts your buyers actually type, and keep what came back",
      },
      {
        name: "Brand Lookup",
        to: "/features/ai-brand-visibility",
        note: "where a brand sits against its category, per platform",
      },
    ],
  },
  {
    label: "Prove what changed",
    items: [
      {
        name: "Rank Tracking",
        to: "/features/rank-tracking",
        note: "desktop and mobile, so a movement has somewhere to come from",
      },
      {
        name: "Site Audit",
        to: "/features/site-audit",
        note: "including whether AI crawlers are allowed to read you at all",
      },
      {
        name: "Answer Diffs",
        to: "/features/ai-search-prompts",
        note: "two runs side by side, with the changed words marked",
      },
    ],
  },
  {
    label: "Do the work",
    items: [
      {
        name: "Keyword Research",
        to: "/features/keyword-research",
        note: "classic demand and difficulty, beside the AI numbers",
      },
      {
        name: "Backlinks",
        // **Was `/features/backlinks`, which is a 301 redirect to this page.**
        // Correct practice — one canonical URL per capability — but a primary
        // navigation link should go to the canonical page directly, not ask for a
        // second round trip to get there.
        to: "/features/backlink-checker",
        note: "referring domains and links, in the same workspace",
      },
      {
        name: "Saved Keywords",
        to: "/features/saved-keywords",
        note: "kept, tagged, and readable by your agent",
      },
    ],
  },
] as const;

export function TheToolkit() {
  return (
    <section className="itc-toolkit" id="features">
      <Container>
        <h2 className="itc-display-md itc-claims-title">
          The SEO you already do, in the same place.
        </h2>
        <p className="itc-toolkit-lede">
          Most AI-visibility tools cover the new surface and leave you a second
          subscription for the rest. OpenGeo is one workspace — and for an
          agency, one report a client can open.
        </p>
        {/* **Nine is what fits here. Thirty-odd is what you get.** The toolkit rail
            sits on a page with a grid budget of ten containers, and a capability
            grid would be both the tenth and the three-rounded-cards signature the
            design research identifies. So the homepage argues and this page
            enumerates — which is also the honest shape, because a list of thirty
            things on a homepage is a list nobody reads. */}
        <p className="itc-toolkit-more">
          <Link to="/capabilities" className="itc-toolkit-more-link">
            That is the short list. Local SEO, GA4, content analysis, traffic
            forecasting, report templates and 71 MCP tools are included too
            <span aria-hidden="true">&rarr;</span>
          </Link>
        </p>


        <div className="itc-toolkit-grid">
          {GROUPS.map((group) => (
            <div key={group.label} className="itc-toolkit-group">
              <h3 className="itc-toolkit-label">{group.label}</h3>
              <ul className="itc-toolkit-list">
                {group.items.map((item) => (
                  <li key={item.name}>
                    <Link to={item.to} className="itc-toolkit-item">
                      <span className="itc-toolkit-name">{item.name}</span>
                      <span className="itc-toolkit-note">{item.note}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
