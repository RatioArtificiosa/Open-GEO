import type { Column, ComparisonRow } from "@/components/comparison-table";

/**
 * The comparison data for `/compare`.
 *
 * ## Every claim here is traceable
 *
 * Each figure came from a vendor's own pricing or docs page, read 2026-10-03 and
 * recorded with its source in `docs/design-research/cl-818-competitor-facts.md`.
 * **Nothing on this page is estimated.** Where a vendor hides a number, the cell
 * says so rather than guessing — a comparison page that fills gaps is the one page
 * that gets audited to death in a forum thread.
 *
 * ## Three claims we deliberately do NOT make
 *
 * 1. **"We're the only ones who store the verbatim answer."** All four competitors
 *    already do — Peec per chat, Otterly as `content`, Scrunch as an immutable
 *    `response_text`, Profound as `response`. We store it too; it is simply not
 *    remarkable. Anyone can verify this in ninety seconds.
 * 2. **"We're the cheapest in the category."** Profound has a genuinely free tier.
 *    The true claim is narrower: **the cheapest paid plan**, and the only one you
 *    can self-host.
 * 3. **"We track more engines."** We track four. The field reaches nine to
 *    thirteen. **That row is ours to lose, and the page says so.**
 *
 * ## The rows where they genuinely win
 *
 * Engine count, prompt ceiling at the entry tier, and answer-diff being
 * buildable-but-not-shipped. A comparison page that only wins is a page a
 * technical reader knows only wins.
 */

export const COMPARE_COLUMNS: Column[] = [
  {
    name: "OpenGeo",
    ours: true,
    blurb: "Open source, self-hostable, cheapest paid plan",
  },
  { name: "Peec AI", blurb: "Marketing teams" },
  { name: "Otterly AI", blurb: "Content-led teams" },
  { name: "Scrunch", blurb: "Enterprise-first" },
  { name: "Profound", blurb: "Agency and enterprise" },
];

export const COMPARE_ROWS: ComparisonRow[] = [
  {
    label: "Entry price",
    cells: [
      {
        text: "$10/mo, $10 vendor credit included",
        tone: "positive",
        href: "/pricing",
      },
      { text: "$95/mo" },
      { text: "$29/mo ($25 annual)" },
      { text: "$250/mo" },
      { text: "Free trial, no paid self-serve tier" },
    ],
  },
  {
    label: "Open source",
    cells: [
      {
        text: "Yes — MIT, and a derivative of OpenSEO",
        tone: "positive",
        href: "/open-source-seo",
      },
      { text: "No" },
      { text: "No" },
      { text: "No" },
      { text: "No" },
    ],
  },
  {
    label: "Self-hostable",
    cells: [
      {
        text: "Yes, documented",
        tone: "positive",
        href: "/docs/self-hosting/docker",
      },
      { text: "No" },
      { text: "No" },
      { text: "No" },
      { text: "No" },
    ],
  },
  {
    label: "AI engines tracked",
    cells: [
      // **We lose this row and say so.** Four is the shortest list here, and it is
      // the kind of thing a reader counts in five seconds.
      { text: "4", tone: "neutral" },
      { text: "7, up to 13" },
      { text: "4, more as paid add-ons" },
      { text: "4, 9 on Enterprise" },
      { text: "3 on trial, 9 on Enterprise" },
    ],
  },
  {
    label: "Verbatim answer text stored",
    cells: [
      { text: "Yes" },
      // **Stated for every competitor, because all of them do it.** Leaving this
      // row out would be the omission; claiming it as a difference would be a lie.
      { text: "Yes — per chat, CSV export" },
      { text: "Yes — API `content`" },
      { text: "Yes — API `response_text`" },
      { text: "Yes — API `response`" },
    ],
  },
  {
    label: "Per-run vendor cost published",
    cells: [
      {
        text: "Yes — every figure opens onto its receipt",
        tone: "positive",
        href: "/methodology",
      },
      { text: "No" },
      { text: "No" },
      { text: "No" },
      { text: "No" },
    ],
  },
  {
    label: "Run-over-run answer diff",
    cells: [
      {
        text: "Yes — two runs compared, and the change named",
        tone: "positive",
      },
      // **The honest phrasing.** None of them *documents* a diff; that is not the
      // same as none of them *has* one, and saying "does not have" would be a
      // claim we cannot check.
      { text: "Not documented — per-chat history exists" },
      { text: "Not documented — date-windowed answers" },
      { text: "Not documented — immutable text, buildable" },
      { text: "Not documented — date-ranged answers" },
    ],
  },
  {
    label: "Readiness score",
    cells: [
      // **The row where our absence is the feature.** A site with its crawler
      // blocked averages to a healthy middle, so we ship ranked fixes instead.
      { text: "No score by design — ranked fixes instead", tone: "neutral" },
      { text: "Yes" },
      { text: "Content Audit score" },
      { text: "Site audit score" },
      { text: "Agent readiness checks" },
    ],
  },
  {
    label: "Multi-brand / agency",
    cells: [
      { text: "Unlimited projects", tone: "neutral" },
      { text: "Yes, with agency tiers" },
      { text: "Yes, unlimited workspaces" },
      { text: "Yes, on Enterprise" },
      { text: "Yes — from $399/client workspace" },
    ],
  },
  {
    label: "API and MCP",
    cells: [
      { text: "MCP and REST", tone: "neutral" },
      { text: "REST and MCP" },
      { text: "REST and MCP" },
      { text: "REST, MCP on Enterprise" },
      { text: "REST on Enterprise; MCP unlisted" },
    ],
  },
  {
    label: "Full SEO toolkit",
    cells: [
      // **The one row we win outright, and the reason an agency does not need a
      // second tool.** Every competitor here is AI-visibility only.
      {
        text: "Yes — keywords, ranks, backlinks, audit, GSC alongside",
        tone: "positive",
      },
      { text: "No — AI visibility only" },
      { text: "No — AI visibility only" },
      { text: "Site audits only" },
      { text: "No — AI visibility only" },
    ],
  },
];

/**
 * The claims the page leads with, each with the evidence it rests on.
 *
 * **Every entry names something we can be caught on.** A "why us" list of
 * adjectives would be the same page as a "why us" list of facts, and only one of
 * them survives a reader checking.
 */
export const COMPARE_CLAIMS = [
  {
    claim: "The cheapest paid plan in the category",
    detail:
      "$10/mo against $29, $95 and $250. Profound offers a free trial, so this is the cheapest *paid* plan, not the cheapest entry — stated on the page rather than left for a reader to catch.",
    evidence: "vendor pricing pages, 2026-10-03",
  },
  {
    claim: "The only one you can self-host",
    detail:
      "MIT, Docker Compose or Cloudflare Workers, and your own DataForSEO key so your data never touches our account. None of the other four is open source.",
    evidence: "our repo and the self-hosting docs",
  },
  {
    claim: "Every number opens onto its receipt",
    detail:
      "The prompt, the answer, the sources and the vendor cost behind each figure. **No competitor publishes what they pay per run**, so the cost of a run is something you have to take on trust everywhere else.",
    evidence: "/methodology, with the endpoint and the date",
  },
  {
    claim: "Compare two runs, and it names what changed",
    detail:
      "A snapshot tells you where you are. The diff tells you why you moved — which is the question a mention count cannot answer. **None of the four publicly document this**; we checked their pricing pages, docs and changelogs, which is not the same as proving they lack it.",
    evidence: "docs and changelogs of all four, 2026-10-03",
  },
] as const;
