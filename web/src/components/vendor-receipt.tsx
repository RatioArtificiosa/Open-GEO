/**
 * The vendor receipt — the claim no competitor can make.
 *
 * ## Why this is on the homepage
 *
 * Nobody in this category publishes what they pay DataForSEO. All four price by
 * prompt and volume, and none discloses the underlying rate — so **a user cannot
 * check whether a platform is marking up, or by how much.** `[verified in
 * cl-818-competitor-facts.md]`
 *
 * We publish it. That is a stronger position than a "transparent pricing" badge,
 * because it is checkable: every figure below comes from
 * `src/shared/ai-keyword-batch-cost.ts` and `src/shared/dataforseo-pricing.ts`, both
 * in the public repo, both pinned by tests.
 *
 * ## The hard part is what the receipt does NOT show
 *
 * Our credit system charges the user what they spend. So publishing the rate also
 * publishes **our margin on volume — which is zero**, because we pass the cost
 * through. A reader who does that arithmetic finds we make nothing on usage and
 * everything on the subscription.
 *
 * **That is the point.** "We make no margin on your data" is a stronger claim than
 * any trust badge, and it is only credible because the number is on the page.
 */

/** One line of a real vendor bill. Figures from the shipped price book. */
type Line = {
  /** What the call was. */
  what: string;
  /** The vendor endpoint, so it can be looked up. */
  endpoint: string;
  /** How the vendor bills it. */
  billing: string;
  /** What it cost, in USD. */
  usd: number;
};

const LINES: Line[] = [
  {
    what: "AI keyword volume, 1,000 keywords",
    endpoint: "ai_optimization/keyword_search_volume/live",
    billing: "1 task × $0.01 + 1,000 items × $0.0001",
    usd: 0.11,
  },
  {
    what: "LLM mentions, 10 rows",
    endpoint: "ai_optimization/llm_mentions/target_metrics/live",
    billing: "1 task × $0.10 + 10 rows × $0.001",
    usd: 0.11,
  },
  {
    what: "One brand, monitored daily, 30 days",
    endpoint: "as above × 30",
    billing: "30 × $0.11",
    usd: 3.3,
  },
];

export function VendorReceipt() {
  return (
    <div className="itc-receipt">
      <div className="itc-receipt-head">
        <span className="itc-receipt-title">What this month cost</span>
        <span className="itc-receipt-date">one brand · daily · 30 days</span>
      </div>

      {/* **Rendered like a receipt, not as a pricing table.** Monospaced, right-
          aligned numbers, hairlines instead of borders. The reader should feel
          they are being shown a document rather than sold a plan — that difference
          is the whole point of publishing it. */}
      <table className="itc-receipt-table">
        <caption className="sr-only">
          Vendor costs for one brand monitored daily over thirty days, itemised
          by endpoint. Every figure comes from the price book in the public
          repository.
        </caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">How DataForSEO bills it</th>
            <th scope="col">Cost</th>
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
              <td className="itc-receipt-cost">${line.usd.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              You pay DataForSEO directly
            </th>
            {/* **Zero, and it is load-bearing.** Our credits pass vendor cost
                through with nothing added, so the number a reader is meant to
                take away is this one. */}
            <td className="itc-receipt-cost itc-receipt-cost--total">
              $0.00 margin
            </td>
          </tr>
        </tfoot>
      </table>

      {/* **The claim, and where to check it.** Not a badge — a sentence and a
          link to the arithmetic. */}
      <p className="itc-receipt-foot">
        Every tool in this category prices by prompt and volume. **None of them
        publish the rate underneath**, so you cannot check whether you are being
        marked up. These numbers come from{" "}
        <a
          href="https://github.com/RatioArtificiosa/Open-GEO/blob/main/src/shared/ai-keyword-batch-cost.ts"
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
