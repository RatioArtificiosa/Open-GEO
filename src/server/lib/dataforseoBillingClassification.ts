import { AppError } from "@/server/lib/errors";
import type { ErrorCode } from "@/shared/error-codes";

const BILLING_SIGNALS = [
  "insufficient funds",
  "balance is too low",
  "payment required",
  "billing",
  "balance",
  "problem billing",
  "recharged",
];

const BILLING_STATUS_CODES = new Set([40200, 40210, 402]);

/**
 * DataForSEO gates API access on **per-account verification**, and until it is done every
 * billable endpoint returns `40104`.
 *
 * **Deliberately not filed under billing**, and the distinction is the whole point: the
 * message for a billing failure says *"billing or balance issue"*, and an account blocked
 * on verification usually has money in it. Telling an operator to top up a funded account
 * sends them away from the fix, which is a click in the user panel.
 *
 * Measured against a live response, which said:
 *
 * ```
 * 40104  "Please verify your account before using the API."
 *        "You can complete verification in the user panel"
 * ```
 *
 * and came from **two unrelated product families** — `ai_optimization` and `serp` — so the
 * block is account-wide rather than a plan that lacks one endpoint.
 *
 * Note the neighbouring `40100` is **not** in here, and it is not a throttle either. The
 * vendor's documented error list (`docs.dataforseo.com/v3/appendix/errors`, read
 * 2026-10-10) reads it plainly:
 *
 *   | Code  | Vendor message                                        |
 *   |-------|-------------------------------------------------------|
 *   | 40100 | "You are not authorized to access this resource"      |
 *   | 40202 | "The rate-limit per minute has been exceeded"         |
 *   | 40209 | "Too many simultaneous queries"                       |
 *
 * An earlier revision of `core.ts` treated it as throttling, on the strength of one
 * transient on `/v3/appendix/user_data`. That contradicted the documented meaning *and*
 * misreported in both directions: a genuinely bad credential was reported as a rate limit
 * to wait out, and a working one was told it was about to be rotated. It is an auth
 * failure, it stays out of this set, and the HTTP ladder owns it.
 */
const VERIFICATION_STATUS_CODES = new Set([40104]);
const VERIFICATION_SIGNALS = [
  "please verify your account",
  "verify your account before",
  "complete verification",
];

/**
 * Whether this is an unverified account rather than a billing one.
 *
 * **Exported so the caller can say which it is** — the two need different messages and
 * different fixes, and collapsing them is what makes an operator top up a funded account.
 */
export function isDataforseoVerificationIssue(
  status: number | undefined,
  details: string,
): boolean {
  if (status != null && VERIFICATION_STATUS_CODES.has(status)) return true;
  const text = details.toLowerCase();
  return VERIFICATION_SIGNALS.some((signal) => text.includes(signal));
}

type DataforseoBillingClassifier = (
  status: number | undefined,
  details: string,
  path: string,
) => AppError | null;

/**
 * Maps DataForSEO account-level failures for a given API section to a typed error.
 *
 * **Two distinct failures, deliberately not merged:**
 *
 * | | code | the account | the fix |
 * |---|---|---|---|
 * | billing | 40200 / 40210 / 402 | depleted | add funds |
 * | **verification** | **40104** | **usually funded** | **click a link in the panel** |
 *
 * The previous version said *"feature-enablement is no longer classified: Backlinks and AI
 * Optimization are included in every DataForSEO account"*. **That is true of the product
 * and false of the account** — API access is still gated on per-account verification, and
 * until it is done every billable endpoint returns 40104 regardless of plan.
 *
 * They share an error code because they share a *category* the caller already handles — a
 * DataForSEO call that cannot proceed — but **not a message**, because a message that says
 * "billing or balance issue" to an account holding $1.00 sends the operator the wrong way.
 */
export function createDataforseoBillingClassifier(config: {
  pathPrefix: string;
  billingIssueCode: ErrorCode;
  billingIssueMessage: string;
}): DataforseoBillingClassifier {
  return (status, details, path) => {
    if (!path.includes(config.pathPrefix)) return null;

    /**
     * **Verification first**, because it is the one where the billing message would be
     * actively misleading: the account is usually funded, and the fix is not money.
     */
    if (isDataforseoVerificationIssue(status, details)) {
      return new AppError(
        config.billingIssueCode,
        "The connected DataForSEO account has not completed verification, so " +
          "every API call is refused. Complete it at https://app.dataforseo.com/ " +
          "— topping up the balance will not help.",
      );
    }

    const text = details.toLowerCase();
    const matchesBillingStatus =
      status != null && BILLING_STATUS_CODES.has(status);
    const matchesBillingText = BILLING_SIGNALS.some((signal) =>
      text.includes(signal),
    );
    if (matchesBillingStatus || matchesBillingText) {
      return new AppError(config.billingIssueCode, config.billingIssueMessage);
    }

    return null;
  };
}
