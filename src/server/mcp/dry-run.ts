import { z } from "zod";
import { mcpResponse } from "@/server/mcp/formatters";

/**
 * The dry-run contract, in one place.
 *
 * ## Why a shared builder rather than a pattern each tool copies
 *
 * CL-058's requirement is that an agent that knows nothing can ask the price
 * without spending. The first two tools shipped it by hand, and both hand-wrote
 * the sentence the agent reads before it spends: "approximately N credits
 * ($X per keyword)". One of them drifted — the string said `$0.002` for as long
 * as the constant said `$0.002`, and only a comment in that file records that
 * the two had already come apart once.
 *
 * **A price quoted by hand is a price that can drift**, and the drift is
 * invisible because nothing recomputes the sentence. So the estimate is a number
 * the tool computes from the price book, the words are built here, and the
 * dollar sign is part of the format — a bare `$` next to an interpolation is
 * stripped by prettier and the message reads "0.0001 per keyword", a figure with
 * no currency quoted by an agent deciding whether to spend.
 *
 * ## What the caller provides
 *
 * The estimate in credits, the unit sentence, and what the money buys. The
 * unit sentence names the vendor and the unit ("per keyword"), which is the part
 * only the tool knows — a shared builder can divide, and it cannot know that
 * `llm_mentions` bills per *row* and Labs bills per *item*.
 */
export const dryRunInputSchema = {
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the credit cost without spending. Set dry_run: false to run the call.",
    ),
} as const;

/**
 * Every dry-run response carries two fields: `dryRun: true` and
 * `estimatedCredits`, a number of credits. The contract is enforced by
 * `dryRunResponse` itself, above — a second declaration of the shape is a second
 * place for it to drift, and knip is right that an unused export is an
 * unmaintained one.
 */

/**
 * Does this invocation want to spend?
 *
 * **`!== false` rather than `=== true`.** Undefined must mean "preview", not
 * "spend": the first caller that omits the field entirely is an agent that read
 * none of the description, and it is the caller the rule exists for. The one
 * existing `dry_run` in the codebase defaults to true for exactly this reason.
 */
export function wantsToSpend(dryRun: boolean | undefined): boolean {
  return dryRun === false;
}

/**
 * The credit cost an agent is quoted, as a plain number of credits.
 *
 * Credits are USD cents here — `AI_KEYWORD_UNIT_COST_USD * 1000` — because the
 * UI and the price book both speak in credits and the vendor speaks in dollars.
 * The conversion is done once, in the tool, so this builder receives a figure
 * the tool has already checked against its own constant.
 */
export function creditsFor(usd: number): number {
  return usd * 1000;
}

/** Build the standard dry-run response. */
export function dryRunResponse(input: {
  /** What the money buys, as a noun phrase: "AI demand for 3 keyword(s)". */
  subject: string;
  /** The estimate, in credits. Derived by the tool from the price book. */
  estimatedCredits: number;
  /** The unit price with its vendor, e.g. "USD 0.0001 per keyword". */
  unitSentence: string;
  /** The URL the tool would have linked to, for the meta block. */
  meta: Parameters<typeof mcpResponse>[0]["meta"];
  structured: Record<string, unknown>;
}) {
  const { subject, estimatedCredits, unitSentence, meta, structured } = input;
  return mcpResponse({
    text: [
      `Dry run: ${subject} will cost approximately ${estimatedCredits} credits (${unitSentence}). Charged amount is what DataForSEO reports at send time.`,
      "Re-run with dry_run: false to spend credits and run the call.",
    ].join("\n"),
    meta,
    structuredContent: {
      dryRun: true,
      estimatedCredits,
      ...structured,
    },
  });
}
