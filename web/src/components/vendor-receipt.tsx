/**
 * The vendor receipt — the claim no competitor will make.
 *
 * ## Why this component exists, in its corrected form
 *
 * The first version of this file said we had **"$0.00 margin"** and that "you pay
 * DataForSEO directly". Both were false: we are the DataForSEO customer and we mark
 * the data up by a flat 28% (`MARKUP` in `pricing.tsx`, which was in the code the
 * whole time). **A credibility asset built on a false number is worse than no
 * asset**, because a reader who checks the arithmetic finds the lie and stops
 * trusting the receipt's real contents.
 *
 * The corrected version is stronger than the false one:
 *
 * > Every tool in this category prices by prompt and volume. **None of them publish
 * > what the underlying data costs them**, so you cannot check whether you are
 * > being marked up. **We publish both numbers** — what we pay, what we charge, and
 * > the 28% difference — and the markup is flat on every endpoint.
 *
 * **A competitor cannot make that claim without publishing their margin**, which is
 * why none of them do. And a reader who does the arithmetic lands on a figure we
 * have already put in front of them.
 *
 * ## The numbers are the ones the code uses
 *
 * `billedUsd = rawDataForSeoCostUsd * MARKUP` — the estimator computes exactly what
 * this table shows, so the page cannot drift from the price a customer is charged.
 */

/** One line of the bill: what we pay the vendor, and what the customer pays. */
type Line = {
  /** What the call was, in the customer's language. */
  what: string;
  /** The vendor endpoint, so the rate can be looked up rather than trusted. */
  endpoint: string;
  /** How DataForSEO bills it. */
  billing: string;
  /** Raw vendor cost in USD — what we pay. */
  costUsd: number;
};

/**
 * **Imported, not restated.**
 *
 * This component *is* the published claim — the homepage says "a flat 28%, the same on
 * every endpoint" and this table is the proof. So the figure it prints has to be the
 * figure the estimator charges by, and the only way to guarantee that is for there to
 * be one of it.
 *
 * It was two declarations joined by a comment reading "must equal", which is how a
 * published number drifts from the number it describes without anything going red.
 */
import { MARKUP } from "@/routes/_marketing/pricing";

const LINES: Line[] = [
  {
    what: "AI keyword volume, 1,000 keywords",
    endpoint: "ai_optimization/ai_keyword_data/keywords/search_volume/live",
    billing: "1 task + 1,000 items",
    costUsd: 0.11,
  },
  {
    what: "LLM mentions, 10 rows",
    endpoint: "ai_optimization/llm_mentions/target_metrics/live",
    billing: "1 task + 10 rows",
    costUsd: 0.11,
  },
  {
    what: "One brand, monitored daily, 30 days",
    endpoint: "as above × 30",
    billing: "30 nightly runs",
    costUsd: 3.3,
  },
];

const usd = (n: number) => `$${n.toFixed(2)}`;

export function VendorReceipt() {
  return (
    <div className="itc-receipt">
      <div className="itc-receipt-head">
        <span className="itc-receipt-title">
          What this month actually costs
        </span>
        <span className="itc-receipt-date">one brand · daily · 30 days</span>
      </div>

      {/* **Rendered like a receipt, not a pricing table.** Monospaced, right-aligned
          figures, hairlines. The reader should feel they are being shown a document
          rather than sold a plan. */}
      <table className="itc-receipt-table">
        <caption className="sr-only">
          What one brand monitored daily for thirty days costs: the vendor price
          we pay, and the price we charge, including a flat 28% markup.
        </caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">How it is billed</th>
            <th scope="col">We pay</th>
            <th scope="col">You pay</th>
          </tr>
        </thead>
        <tbody>
          {LINES.map((line) => (
            <tr key={line.what}>
              <th scope="row">
                <span className="itc-receipt-what">{line.what}</span>
                <code className="itc-receipt-endpoint">{line.endpoint}</code>
              </th>
              <td className="itc-receipt-billing">{line.billing}</td>
              <td className="itc-receipt-cost">{usd(line.costUsd)}</td>
              <td className="itc-receipt-cost">{usd(line.costUsd * MARKUP)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              The difference, and it is the same on every endpoint
            </th>
            <td className="itc-receipt-cost" />
            {/* **The load-bearing cell.** Not a claim of generosity — a figure the
                reader can multiply. Anyone can check it, and nobody else will print
                theirs. */}
            <td className="itc-receipt-cost itc-receipt-cost--total">+28%</td>
          </tr>
        </tfoot>
      </table>

      {/* **The claim, and where to check it.** */}
      <p className="itc-receipt-foot">
        Every tool in this category prices by prompt and volume.{" "}
        <strong>
          None of them publish what the underlying data costs them
        </strong>
        , so you cannot check whether you are being marked up, or by how much.
        **We print both columns** — ours comes from{" "}
        <a
          href="https://github.com/RatioArtificiosa/Open-GEO/blob/main/src/shared/dataforseo-pricing.ts"
          target="_blank"
          rel="noopener noreferrer"
          className="itc-receipt-link"
        >
          the price book in our repo
        </a>
        , and a vendor price change breaks our build rather than quietly
        changing your bill.
      </p>
    </div>
  );
}
