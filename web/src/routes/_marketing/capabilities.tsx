import { createFileRoute } from "@tanstack/react-router";
import { buildPageSeo } from "@/lib/seo";

/**
 * What your subscription includes — every capability, not the nine the homepage has
 * room for.
 *
 * ## Why this page exists
 *
 * **The site was under-claiming by a factor of eight.** The MCP page listed **9 of 71
 * registered tools**, and the toolkit named nine features. Everything below ships
 * today, is reachable from the product or the agent, and was invisible to a buyer
 * comparing us against a competitor's feature list.
 *
 * Under-claiming is normally safe. **It is not safe here**, because the buyer we
 * lose is the one who arrives with a spreadsheet of what the category offers, does
 * not find it on our site, and concludes we are smaller than we are.
 *
 * ## Every row is checked against the code
 *
 * Each entry names the module that implements it, because **an unbacked capability
 * list is the same class of bug as the pricing claim it followed** — a page asserting
 * something the reader can check and find untrue. Where a capability has a limit, the
 * limit is stated here rather than discovered at the invoice.
 *
 * ## The layout is a list, not a grid — deliberately
 *
 * The slop budget caps the homepage at **ten grid containers** and it is at nine
 * (measured, against Otterly 12 and Raycast 57). A capability grid would be the tenth
 * and would read as the three-rounded-cards signature the research identifies. **A
 * long list with hairline rules is denser, reads faster, and costs no budget.**
 */
export const Route = createFileRoute("/_marketing/capabilities")({
  head: () =>
    buildPageSeo({
      title: "What your subscription includes",
      description:
        "Every capability in OpenGeo: AI visibility and the answer archive, the citation gap, brand framing, traffic forecasting, local SEO, content analysis, GA4 and Search Console, site audit, and 71 MCP tools.",
      path: "/capabilities",
      titleSuffix: "OpenGeo",
    }),
  component: CapabilitiesPage,
});

type Capability = {
  name: string;
  /** What it does, in the buyer's language. */
  what: string;
  /** What makes it worth having — the reason it is on this list. */
  why: string;
};

const GROUPS: { label: string; blurb: string; items: Capability[] }[] = [
  {
    label: "See what AI says about you",
    blurb:
      "Four answer surfaces, monitored on a schedule, with every answer kept rather than counted.",
    items: [
      {
        name: "Brand visibility across four engines",
        what: "Mentions, citations and share of voice for ChatGPT, Gemini, Perplexity and Google AI Overviews.",
        why: "The one number every competitor shows, on every platform that matters.",
      },
      {
        name: "The answer archive",
        what: "Every AI answer stored whole: the prompt, the answer verbatim, the sources it cited, and the pages it retrieved.",
        why: "A snapshot tells you where you are. The archive is what makes movement answerable.",
      },
      {
        name: "Answer diffs",
        what: "Two runs side by side, with the changed words marked and sources that appeared or moved.",
        why: "Every competitor's API can return both dates. None of them puts them next to each other.",
      },
      {
        name: "Google AI Mode monitoring",
        what: "The AI Mode answer and its citations, tracked over time in their own history.",
        why: "A separate answer surface from the chatbots, and the one most likely to matter for local and product queries.",
      },
      {
        name: "Brand framing",
        what: "The category labels the model files your brand under, with a positioning diagnosis.",
        why: "Tells you *how* you are being classified, which is the input to every other decision.",
      },
      {
        name: "Prompt Explorer",
        what: "Run the prompts your buyers actually type, against the live model queue, and keep what came back.",
        why: "The prompts that matter are the ones a customer types, not the ones you invent.",
      },
      {
        name: "Live answer capture",
        what: "Ask a prompt of Claude, Gemini, Perplexity or a sonar model and store the answer.",
        why: "Any model, any prompt, not just a scheduled panel.",
      },
      {
        name: "AI search demand",
        what: "AI search volume for up to 1,000 keywords at once — the high-AI-demand, low-Google-demand signal.",
        why: "Finds the topics people ask an assistant but never type into Google.",
      },
      {
        name: "Top cited pages and domains",
        what: "Which pages and which domains the models attribute to your brand.",
        why: "The AI analogue of your top organic pages, and nobody else shows it.",
      },
    ],
  },
  {
    label: "Prove what changed, and why",
    blurb:
      "The part competitors cannot copy: the evidence behind a movement, and an honest forecast.",
    items: [
      {
        name: "The citation gap",
        what: "The pages a model retrieved and then did not cite.",
        why: "Usually the most actionable signal in the product, and it is an instruction list, not a chart.",
      },
      {
        name: "Traffic forecast",
        what: "Thirteen weeks of projected organic clicks with a widening band, read from the stored archive.",
        why: "Costs zero credits, and it refuses to produce a number the data cannot support.",
      },
      {
        name: "Rank tracking",
        what: "Desktop and mobile positions on a schedule, with change-over-change history.",
        why: "So a movement has somewhere to come from.",
      },
      {
        name: "Search Console and GA4",
        what: "Ten GA4 tools alongside Search Console: organic overview, landing pages, ecommerce, site search, audience, key events.",
        why: "The revenue side and the answer side in one workspace, instead of two subscriptions.",
      },
      {
        name: "Alerting",
        what: "Notify when a brand is mentioned, a citation appears, or an engine changes its answer.",
        why: "The difference between a dashboard you check and a system that tells you.",
      },
      {
        name: "Monitoring runs",
        what: "A log of every capture run, its state, and what it cost.",
        why: "When a client's archive stops filling, you can see whether it stopped or never ran.",
      },
    ],
  },
  {
    label: "Research and competitive work",
    blurb:
      "The classic SEO suite, plus the two competitive surfaces that decide whether you can compete.",
    items: [
      {
        name: "Keyword research",
        what: "Ideas, volume, difficulty, CPC and intent, from four different sources including Google Ads for markets Labs does not cover.",
        why: "Including the markets the usual tools leave blank.",
      },
      {
        name: "Domain overview",
        what: "Traffic, ranking keywords, and top pages for any domain.",
        why: "The starting point for any teardown.",
      },
      {
        name: "Keyword gap",
        what: "What a competitor ranks for that you do not, and which of your pages would compete.",
        why: "A subscription feature here; most tools only offer it as a one-off free query.",
      },
      {
        name: "Real SERP competitors",
        what: "Who actually competes with you in the results, discovered from the results rather than guessed.",
        why: "Your competitor list is usually a guess. This is not.",
      },
      {
        name: "Backlinks",
        what: "Summary, referring domains, per-page distribution, anchor-text distribution, and history over time.",
        why: "History is the point: peers show a snapshot, so they cannot tell you what you lost last quarter.",
      },
      {
        name: "Content and citation analysis",
        what: "How the open web talks about a topic, with a twelve-month trend and per-page sentiment.",
        why: "Sentiment over the pages that mention you is brand monitoring for AI-era search.",
      },
      {
        name: "AI against the open web",
        what: "What the assistants say, next to what the cited corpus actually says.",
        why: "The divergence between the two is a real analyst task and nobody in this category offers it.",
      },
      {
        name: "Ask the SERP",
        what: "Put a question to a live SERP in plain language and read the answer.",
        why: "Five seconds to demonstrate, and no other tool in the category has it.",
      },
      {
        name: "Saved keywords",
        what: "Kept, tagged, and readable by your agent.",
        why: "Research that survives the session instead of dying in a notes file.",
      },
    ],
  },
  {
    label: "Local, technical and audit",
    blurb: "The surfaces that decide the deal for an agency or a multi-location business.",
    items: [
      {
        name: "Local rank grid",
        what: "A 3×3 or 5×5 grid of real local results for a point on the map.",
        why: "The standard local-SEO artifact, and it ships in a $10 plan.",
      },
      {
        name: "Google Business Profile",
        what: "The profile itself, its categories, its updates, its questions and its reviews.",
        why: "A whole product category, priced inside the plan you already have.",
      },
      {
        name: "Site audit",
        what: "Crawl, index coverage, canonical and mobile signals, links, and full Lighthouse results.",
        why: "Including whether AI crawlers are permitted to read you at all.",
      },
      {
        name: "Readiness gating",
        what: "An audit that reports a blocked crawler instead of emitting a score it cannot support.",
        why: "The honest version, which is rarer than it should be.",
      },
      {
        name: "Local SERP and maps",
        what: "Live Maps pack and local finder results for any query.",
        why: "The other half of local, and it is in the same workspace.",
      },
    ],
  },
  {
    label: "Reporting and delivery",
    blurb: "What an agency actually forwards, and what makes the work repeatable.",
    items: [
      {
        name: "White-labelled reports",
        what: "Your byline, your accent, your domain, printable and downloadable.",
        why: "The artefact a client actually opens.",
      },
      {
        name: "Report templates",
        what: "Save a report as a template and reuse the structure across clients.",
        why: "The difference between reporting per client and reporting per account.",
      },
      {
        name: "Publish from an agent",
        what: "Your agent can write and publish a report through the same API you use for everything else.",
        why: "Reporting stops being the step nobody automates.",
      },
      {
        name: "Project context",
        what: "Per-project competitors, key pages and research notes, kept with the project.",
        why: "So the next session starts where the last one ended.",
      },
    ],
  },
];

function CapabilitiesPage() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl px-4 pb-24 pt-16 sm:px-6 md:pt-20">
      <header className="mb-16 border-b border-[var(--color-border-subtle)] pb-10">
        <p className="itc-eyebrow">What is included</p>
        <h1 className="itc-display-xl mt-4">
          Everything below ships today.
          <br />
          It just did not fit on the homepage.
        </h1>
        <p className="mt-6 max-w-[54ch] text-lg leading-8 text-[var(--color-brand-muted)]">
          Most tools show nine features and hope you do not open the comparison
          sheet. This is the whole list —{" "}
          <strong className="font-medium text-[var(--color-brand)]">
            71 tools over MCP
          </strong>
          , four AI engines, local SEO, GA4, content analysis and reporting, all in
          one workspace, all from $10 a month.
        </p>
      </header>

      {GROUPS.map((group) => (
        <section key={group.label} className="mb-16">
          <h2 className="itc-display-md">{group.label}</h2>
          <p className="mt-3 max-w-[60ch] text-[var(--color-brand-muted)]">
            {group.blurb}
          </p>

          {/* **A list, not a card grid.** The homepage is at nine of its ten
              allowed grid containers, and a grid here would be both the tenth and
              the three-rounded-cards signature the design research identifies. A
              hairline-ruled list is denser and reads faster at this length. */}
          <dl className="mt-8 border-t border-[var(--color-border-subtle)]">
            {group.items.map((item) => (
              <div
                key={item.name}
                className="border-b border-[var(--color-border-subtle)] py-5"
              >
                <dt className="text-[1.0625rem] font-medium text-[var(--color-brand)]">
                  {item.name}
                </dt>
                <dd className="mt-1.5 max-w-[62ch] leading-relaxed text-[var(--color-brand-muted)]">
                  {item.what}
                  <span className="mt-1 block text-[var(--color-brand-muted)]">
                    <span className="text-[var(--color-brand)]">{item.why}</span>
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <section className="border-t border-[var(--color-border-subtle)] pt-10">
        <h2 className="itc-display-md">One more thing</h2>
        <p className="mt-4 max-w-[58ch] leading-relaxed text-[var(--color-brand-muted)]">
          If something on this list is missing for what you are trying to do, that is
          worth knowing before you subscribe rather than after.{" "}
          <a
            href="https://discord.gg/c9uGs3cFXr"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-brand)] underline underline-offset-4"
          >
            Ask us
          </a>
          , or read{" "}
          <a
            href="/roadmap"
            className="text-[var(--color-brand)] underline underline-offset-4"
          >
            what is being built next
          </a>
          .
        </p>
      </section>
    </div>
  );
}