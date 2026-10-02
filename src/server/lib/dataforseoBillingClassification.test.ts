import { describe, expect, it } from "vitest";
import {
  createDataforseoBillingClassifier,
  isDataforseoVerificationIssue,
} from "@/server/lib/dataforseoBillingClassification";

const classify = createDataforseoBillingClassifier({
  pathPrefix: "/backlinks/",
  billingIssueCode: "BACKLINKS_BILLING_ISSUE",
  billingIssueMessage: "billing issue",
});

/**
 * Verbatim from a live probe of this account. **Every message below is the vendor's own
 * wording**, because the whole finding is that the wording is what distinguishes these.
 */
const VERIFICATION_MESSAGE =
  "Please verify your account before using the API. You can complete verification in the user panel: https://app.dataforseo.com/ .";

const THROTTLE_MESSAGE =
  "You are not Authorized to Access this Resource. Your Login Information Here: https://app.dataforseo.com/login .";

describe("createDataforseoBillingClassifier", () => {
  it("returns null when the path is outside the configured prefix", () => {
    expect(classify(402, "payment required", "/v3/serp/google/live")).toBe(
      null,
    );
  });

  it.each([40200, 40210, 402])(
    "translates billing status %s into the configured billing error code",
    (status) => {
      const err = classify(status, "", "/v3/backlinks/summary/live");
      expect(err?.code).toBe("BACKLINKS_BILLING_ISSUE");
    },
  );

  it.each([
    "insufficient funds",
    "payment required",
    "balance is too low",
    "problem billing",
    "account was not recharged",
  ])(
    "translates billing signal %s into the configured billing code",
    (message) => {
      const err = classify(undefined, message, "/v3/backlinks/summary/live");
      expect(err?.code).toBe("BACKLINKS_BILLING_ISSUE");
    },
  );

  it("no longer classifies feature-access signals now that the add-ons are bundled", () => {
    expect(
      classify(40204, "subscription required", "/v3/backlinks/summary/live"),
    ).toBe(null);
    expect(classify(403, "access denied", "/v3/backlinks/summary/live")).toBe(
      null,
    );
  });

  it("returns null when neither status nor text matches", () => {
    expect(classify(500, "boom", "/v3/backlinks/summary/live")).toBe(null);
  });

  it("matches billing signals case-insensitively", () => {
    const err = classify(
      undefined,
      "INSUFFICIENT funds",
      "/v3/backlinks/summary/live",
    );
    expect(err?.code).toBe("BACKLINKS_BILLING_ISSUE");
  });
});

/**
 * The two account-level failures a live probe surfaced, which no test here covered.
 *
 * Every message is the vendor's verbatim wording, read from a real response — because the
 * finding is precisely that the *wording* is what tells them apart, and an invented
 * message would not have.
 */
describe("a DataForSEO account blocked on verification", () => {
  it("names verification for 40104, and does not call it a balance problem", () => {
    const err = classify(
      40104,
      VERIFICATION_MESSAGE,
      "/v3/backlinks/summary/live",
    );

    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/verification/i);
    // **It must say that adding money will not help.** That sentence is what stops an
    // operator topping up an account that already holds $1.00.
    expect(err?.message).toMatch(/topping up.*will not help/i);
    // **And it must not *report the problem as* a balance issue** — which is a different
    // claim from merely mentioning the word. An earlier version of this assertion was
    // `not.toMatch(/balance/i)`, which the message fails **because of the very clause
    // that helps**: "topping up the balance will not help". Deleting that clause would have
    // made the test pass and the product worse.
    expect(err?.message).not.toMatch(/balance (or|and) balance issue/i);
    expect(err?.message).not.toMatch(/has a billing/i);
  });

  it("recognises verification by wording when the status is absent", () => {
    // The status is `undefined` on some transport failures, and the wording is still
    // specific enough to act on.
    expect(isDataforseoVerificationIssue(undefined, VERIFICATION_MESSAGE)).toBe(
      true,
    );
    expect(
      classify(undefined, VERIFICATION_MESSAGE, "/v3/backlinks/summary/live")
        ?.message,
    ).toMatch(/verification/i);
  });

  it("does NOT file the throttling wording as an account problem", () => {
    // **The negative control, and the reason this block exists.** `40100` reads
    // "You are not Authorized to Access this Resource" — which looks like a broken
    // credential and is actually rate limiting: the identical call returned 200 moments
    // later. Classifying it would tell an operator to rotate a working API key.
    expect(
      classify(40100, THROTTLE_MESSAGE, "/v3/backlinks/summary/live"),
    ).toBe(null);
    expect(isDataforseoVerificationIssue(40100, THROTTLE_MESSAGE)).toBe(false);
  });

  it("still classifies a genuine balance failure as billing", () => {
    // **The control on the control.** Recognising verification must not have narrowed the
    // billing path — a classifier that matches everything is as useless as one that matches
    // nothing.
    const err = classify(
      40200,
      "Insufficient funds",
      "/v3/backlinks/summary/live",
    );
    expect(err?.code).toBe("BACKLINKS_BILLING_ISSUE");
    expect(err?.message).toBe("billing issue");
    expect(err?.message).not.toMatch(/verification/i);
  });

  it("ignores verification wording on a path outside the configured prefix", () => {
    // The factory's `pathPrefix` guard still holds for the new branch.
    expect(classify(40104, VERIFICATION_MESSAGE, "/v3/serp/google/live")).toBe(
      null,
    );
  });
});
