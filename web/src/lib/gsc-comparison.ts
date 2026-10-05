import type { Column, ComparisonRow } from "@/components/comparison-table";

/**
 * The Search Console comparison, as data.
 *
 * **Moved out of `comparison-table.tsx` when the component was generalised**, so
 * the table renders whatever a page gives it rather than one hardcoded argument.
 * This is that page's data, unchanged except for `highlight` → `ours`.
 */

export const GSC_COLUMNS: Column[] = [
  { name: "OpenGeo", ours: true },
  { name: "DIY open-source repos" },
  { name: "Data-pipeline tools" },
];

export const GSC_ROWS: ComparisonRow[] = [
  {
    label: "Setup",
    cells: [
      { text: "Simple, guided onboarding", tone: "positive" },
      { text: "~30 min in the Google Cloud console" },
      { text: "Account + connector setup" },
    ],
  },
  {
    label: "Google Cloud project",
    cells: [
      { text: "Not needed", tone: "positive" },
      { text: "Required", tone: "negative" },
      { text: "Usually not needed", tone: "positive" },
    ],
  },
  {
    label: "Cost to run",
    cells: [
      {
        // **Was "Included in the $10/mo plan, zero credits (free to self-host)".**
        // The parenthetical sat inside the **cost** row, so the cheapest option on
        // the page was the one we do not sell. The open-source fact belongs in the
        // self-host row below, where it is a comparison point rather than a cheaper
        // alternative to the plan being described.
        text: "Included in the $10/mo plan, zero credits",
        tone: "positive",
      },
      { text: "Free (your time + your own quota)" },
      { text: "Paid or limited free tier", tone: "negative" },
    ],
  },
  {
    label: "Read-only and safe",
    cells: [
      { text: "webmasters.readonly", tone: "positive", code: true },
      { text: "Depends on the scopes you grant" },
      { text: "Varies" },
    ],
  },
  {
    label: "Built for SEO",
    cells: [
      {
        text: "Also does keyword, rank, and backlink research",
        tone: "positive",
      },
      { text: "Search Console only", tone: "negative" },
      { text: "Reporting and analytics focus" },
    ],
  },
  {
    label: "Self-host option",
    cells: [
      { text: "Yes", tone: "positive" },
      { text: "Yes", tone: "positive" },
      { text: "No", tone: "negative" },
    ],
  },
];
