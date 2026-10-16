/**
 * The metering + credit-gate core behind `createDataforseoClient` (A4/A11:
 * extracted from `client.ts` so the endpoint table stays under the max-lines
 * budget and each layer reads alone — the gate first, then the table).
 *
 * `meter` wraps one fetcher; `meterEnvelope` keeps the billing receipt;
 * `meterDataforseoCall` runs the gate; `trackDataforseoCost` writes the
 * single charge computation to the ledger. Nothing here knows an endpoint.
 */
import {
  applyCostMarkup,
  resolveCostMarkup,
} from "@/server/billing/costMarkup";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  assertUsageCreditsAvailable,
  getOrCreateOrganizationCustomer,
  trackUsageCreditSpend,
} from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
  DataforseoChargedTaskError,
} from "@/server/lib/dataforseo/envelope";
import { AUTUMN_SEO_DATA_CREDITS_PER_USD } from "@/shared/billing";
import {
  type CreditFeature,
  mapDataforseoPathToCreditFeature,
} from "@/shared/billing-credit-features";

/**
 * Wraps a section fetcher with billing metering. Each entry on the client is
 * `meter(customer, fetchX, defaultFeature?)`, which returns a function with
 * the fetcher's own input type and resolves to its unwrapped `.data`.
 *
 * `defaultFeature` is the fallback credit feature; a caller can override it per
 * call by passing `creditFeature` in the input (e.g. an MCP tool attributing
 * spend to its own feature). The extra field is ignored by the fetchers, which
 * read named fields rather than spreading the input.
 */
/**
 * Wrap one vendor fetcher in the metering + credit gate.
 *
 * `estimateUsd` is what the call is *expected* to cost, drawn from
 * `@/shared/dataforseo-pricing`. It is passed to `assertUsageCreditsAvailable`
 * so the gate can refuse a call the wallet cannot cover, rather than only a call
 * against an empty wallet. One remaining credit used to admit a $0.12 WHOIS read.
 *
 * **A function of the input, not a number**, because the expensive endpoints
 * bill per task: `rankCheckTaskPost` posts up to 100 tasks and
 * `domainMetricsByCategories` bills per returned row. A fixed estimate would
 * understate them by exactly the factor that makes them dangerous.
 *
 * Endpoints that omit it keep the old "any non-empty wallet" behaviour. That is
 * deliberate: the price book's own header calls most of its rows the
 * least-verified part of the file, and a floor built on an unverified price
 * would refuse legitimate work. The estimate only has to be right to be useful —
 * a wrong one that is too low is the old behaviour, and a wrong one that is too
 * high is a refusal, which is loud rather than silent.
 *
 * Per-unit audit (A4, 2026-10-16): estimators below cover every price-book
 * entry with a per-unit term whose count the request controls (limits,
 * keyword arrays, date ranges, internal lists). Deliberately unestimated:
 * `domainRankOverview` + `backlinksSummary` (vendor-bounded aggregates with
 * no caller-controlled count — an estimate here would be fiction dressed as
 * precision, or a ceiling that refuses legitimate work), the LLM Mentions
 * family (row counts depend on vendor-side matching with no request-side
 * predictor; follow-up: a row-count model), and flat per-request families
 * (trends, serp-live, lighthouse, on-page — nothing to scale).
 */
export function meter<I, T>(
  customer: BillingCustomerContext,
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  defaultFeature?: CreditFeature,
  estimateUsd?: (input: I) => number,
): (input: I & { creditFeature?: CreditFeature }) => Promise<T> {
  return (input) =>
    meterDataforseoCall(
      customer,
      () => fetcher(input),
      input.creditFeature ?? defaultFeature,
      estimateUsd?.(input),
    ).then((response) => response.data);
}

/**
 * The envelope-returning sibling of `meter`.
 *
 * ## Who needs it and why
 *
 * A scheduled capture reconciles its spend. `scheduledEtvCapture.ts` reads
 * `response.billing.costUsd` into `report.actualCostUsd`, and that number is the
 * one an operator checks against the DataForSEO invoice. `meter` unwrps the
 * billing away, so a capture built on it would charge the customer correctly and
 * record a cost of `undefined` — and nothing would fail, because the budget runs
 * on the price-book estimate rather than the vendor's figure.
 *
 * **That is what made the shape dangerous**: a metered capture that reports zero
 * actual spend is indistinguishable from a correctly metered one, from the tests
 * and from the log. The receipt has to travel with the charge, which is the same
 * principle as the design system's evidence drawer, applied to money.
 *
 * Identical gating, identical credit feature, identical estimate — only the
 * return type differs, so the two cannot disagree about whether a call is
 * permitted.
 */
export function meterEnvelope<I, T>(
  customer: BillingCustomerContext,
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  defaultFeature?: CreditFeature,
  estimateUsd?: (input: I) => number,
): (
  input: I & { creditFeature?: CreditFeature },
) => Promise<DataforseoApiResponse<T>> {
  return (input) =>
    meterDataforseoCall(
      customer,
      () => fetcher(input),
      input.creditFeature ?? defaultFeature,
      estimateUsd?.(input),
    );
}

/**
 * Run one vendor call through the credit gate, and return the **envelope**.
 *
 * ## Why this returns the envelope while `meter` unwraps it
 *
 * This returned `T` — the payload with the billing envelope stripped — and every
 * consumer was written against that. A scheduled capture is not.
 *
 * `scheduledEtvCapture.ts` reads `response.billing.costUsd` into its report, and
 * `report.actualCostUsd` is the figure an operator reconciles against the
 * DataForSEO invoice. The metered client had charged the customer and thrown the
 * receipt away, so a capture routed through it would silently report an
 * `actualCostUsd` of `undefined` — the budget still works, because it runs on the
 * price-book estimate, but the one number that shows what the vendor actually
 * billed would read as zero forever. **A charge with no receipt is exactly the
 * trust failure the evidence-drawer design exists to prevent.**
 *
 * So the internal helper keeps the envelope — strictly more information — and
 * `meter` unwraps, which leaves every existing consumer's type and behaviour
 * untouched. `meterEnvelope` is the sibling for a caller that needs the receipt.
 */
async function meterDataforseoCall<T>(
  customer: BillingCustomerContext,
  execute: () => Promise<DataforseoApiResponse<T>>,
  creditFeature?: CreditFeature,
  estimatedCostUsd?: number,
): Promise<DataforseoApiResponse<T>> {
  const isHostedMode = await isHostedServerAuthMode();

  if (!isHostedMode) {
    return execute();
  }

  const billingCustomer = await getOrCreateOrganizationCustomer(customer);

  const { monthlyRemaining } = await assertUsageCreditsAvailable(
    billingCustomer.id,
    estimatedCostUsd,
  );

  let result: DataforseoApiResponse<T>;
  try {
    result = await execute();
  } catch (error) {
    if (error instanceof DataforseoChargedTaskError) {
      // A malformed request (DataForSEO "Invalid Field: ...") that DataForSEO
      // did not bill returns no value to the customer, so don't charge — surface
      // it as a non-reportable VALIDATION_ERROR. If DataForSEO still billed us
      // (costUsd > 0), fall through to the normal charge + capture path so the
      // spend stays metered and visible instead of silently eaten.
      if (error.isInvalidField && error.billing.costUsd <= 0) {
        throw new AppError("VALIDATION_ERROR", error.message);
      }
      const chargedCredits = Math.round(
        applyCostMarkup(error.billing.costUsd, await resolveCostMarkup()) *
          AUTUMN_SEO_DATA_CREDITS_PER_USD,
      );
      await trackDataforseoCost({
        customer,
        customerId: billingCustomer.id,
        billing: error.billing,
        monthlyRemaining,
        creditFeature,
        totalCostCredits: chargedCredits,
      });
    }
    throw error;
  }

  // One computation of the charge, shared by the two side effects: what the
  // customer is charged cannot be computed twice and expected to agree, and the
  // ledger's `credits` is the number the charge used — a ledger row holding a
  // different figure is a reconciliation that never closes.
  const totalCostCredits = Math.round(
    applyCostMarkup(result.billing?.costUsd ?? 0, await resolveCostMarkup()) *
      AUTUMN_SEO_DATA_CREDITS_PER_USD,
  );

  await trackDataforseoCost({
    customer,
    customerId: billingCustomer.id,
    billing: result.billing,
    monthlyRemaining,
    creditFeature,
    totalCostCredits,
  });

  // The whole envelope, so a caller that needs the receipt — a nightly capture
  // reconciling `actualCostUsd` against the vendor invoice — is not handed a
  // charge with the billing stripped off. `meter` below unwraps it for the
  // callers that want the payload.
  return result;
}

async function trackDataforseoCost(args: {
  customer: BillingCustomerContext;
  customerId: string;
  billing: DataforseoApiCallCost;
  monthlyRemaining: number;
  creditFeature?: CreditFeature;
  /** The credits the charge used, computed once and shared with the ledger. */
  totalCostCredits: number;
}) {
  await trackUsageCreditSpend({
    customer: args.customer,
    customerId: args.customerId,
    creditFeature:
      args.creditFeature ?? mapDataforseoPathToCreditFeature(args.billing.path),
    costUsd: args.billing.costUsd,
    monthlyRemaining: args.monthlyRemaining,
    properties: {
      provider: "dataforseo",
      paths: [args.billing.path.join("/")],
      fromCache: false,
    },
  });
}
