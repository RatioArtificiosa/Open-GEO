import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTUMN_PAID_PLAN_FEATURE_ID,
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
  SEO_DATA_COST_MARKUP,
} from "@/shared/billing";

const { checkMock, getOrCreateMock, kvGetMock, kvPutMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  getOrCreateMock: vi.fn(),
  kvGetMock: vi.fn(),
  kvPutMock: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { KV: { get: kvGetMock, put: kvPutMock } },
}));

vi.mock("@/server/billing/autumn", () => ({
  autumn: {
    check: checkMock,
    customers: {
      getOrCreate: getOrCreateMock,
    },
  },
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(),
}));

// subscription.ts now imports posthog (for trackUsageCreditSpend); stub it so
// the test doesn't pull in the cloudflare:workers runtime it depends on.
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

import {
  assertUsageCreditsAvailable,
  customerHasPaidPlan,
  getOrCreateOrganizationCustomer,
} from "./subscription";

describe("subscription billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvGetMock.mockResolvedValue(null);
    kvPutMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks the paid plan entitlement", async () => {
    checkMock.mockResolvedValue({ allowed: true });

    await expect(customerHasPaidPlan("org_123")).resolves.toBe(true);

    expect(checkMock).toHaveBeenCalledWith({
      customerId: "org_123",
      featureId: AUTUMN_PAID_PLAN_FEATURE_ID,
    });
  });

  it("returns false without retrying when org lacks paid plan", async () => {
    checkMock.mockResolvedValue({ allowed: false });

    await expect(customerHasPaidPlan("org_123")).resolves.toBe(false);
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("recovers from a degraded negative read when retryDenied is set", async () => {
    vi.useFakeTimers();
    checkMock
      .mockResolvedValueOnce({ allowed: false })
      .mockResolvedValueOnce({ allowed: true });

    const result = customerHasPaidPlan("org_123", { retryDenied: true });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(true);
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("retries a missing monthly balance once", async () => {
    vi.useFakeTimers();
    let monthlyChecks = 0;
    checkMock.mockImplementation(
      async ({ featureId }: { featureId: string }) => {
        if (featureId === AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID) {
          return { balance: null };
        }
        if (featureId === AUTUMN_SEO_DATA_BALANCE_FEATURE_ID) {
          monthlyChecks += 1;
          return monthlyChecks === 1
            ? { balance: null }
            : { balance: { remaining: 250 } };
        }
        throw new Error(`Unexpected feature ${featureId}`);
      },
    );

    const result = assertUsageCreditsAvailable("org_123");
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ monthlyRemaining: 250 });
    expect(monthlyChecks).toBe(2);
  });

  it("fails closed when the retry still has no monthly balance", async () => {
    vi.useFakeTimers();
    checkMock.mockResolvedValue({ balance: null });

    const result = assertUsageCreditsAvailable("org_123");
    const assertion = expect(result).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await vi.runAllTimersAsync();

    await assertion;
    expect(checkMock).toHaveBeenCalledTimes(3);
  });

  it("looks up the billing customer by organization id", async () => {
    getOrCreateMock.mockResolvedValue({ id: "cust_123" });

    await getOrCreateOrganizationCustomer({
      organizationId: "org_123",
      userId: "user_123",
      userEmail: "alice@example.com",
    });

    expect(getOrCreateMock).toHaveBeenCalledWith({
      customerId: "org_123",
      email: "alice@example.com",
    });
    expect(kvPutMock).toHaveBeenCalled();
  });

  it("skips the Autumn round trip when the customer was recently ensured", async () => {
    kvGetMock.mockResolvedValue("1");

    const result = await getOrCreateOrganizationCustomer({
      organizationId: "org_123",
      userId: "user_123",
      userEmail: "alice@example.com",
    });

    expect(result).toEqual({ id: "org_123" });
    expect(getOrCreateMock).not.toHaveBeenCalled();
  });

  it("falls back to Autumn when the customer cache read fails", async () => {
    const cacheError = new Error("KV read unavailable");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    kvGetMock.mockRejectedValue(cacheError);
    getOrCreateMock.mockResolvedValue({ id: "cust_123" });

    await expect(
      getOrCreateOrganizationCustomer({
        organizationId: "org_123",
        userId: "user_123",
        userEmail: "alice@example.com",
      }),
    ).resolves.toEqual({ id: "cust_123" });

    expect(getOrCreateMock).toHaveBeenCalledWith({
      customerId: "org_123",
      email: "alice@example.com",
    });
    expect(console.warn).toHaveBeenCalledWith(
      "billing.customer-cache-read failed:",
      cacheError,
    );
  });

  it("returns the resolved customer when the customer cache write fails", async () => {
    const cacheError = new Error("KV write unavailable");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getOrCreateMock.mockResolvedValue({ id: "cust_123" });
    kvPutMock.mockRejectedValue(cacheError);

    await expect(
      getOrCreateOrganizationCustomer({
        organizationId: "org_123",
        userId: "user_123",
        userEmail: "alice@example.com",
      }),
    ).resolves.toEqual({ id: "cust_123" });

    expect(console.warn).toHaveBeenCalledWith(
      "billing.customer-cache-write failed:",
      cacheError,
    );
  });
});

describe("assertUsageCreditsAvailable's affordability floor", () => {
  /**
   * **The floor must convert the estimate with the same arithmetic the charge
   * uses, or it is not a floor.**
   *
   * The first version divided the balance by the rate to get an "affordable USD"
   * figure and compared the estimate against it. Same two constants, different
   * conversion: it skipped both `roundUsdForBilling` and the `Math.ceil`, the two
   * steps that decide what a charge actually is. CodeRabbit caught it — *"Keep the
   * balance and estimated charge in the same units"* — and the fix is to convert
   * the estimate to credits with `trackUsageCreditSpend`'s own three steps, then
   * compare credits to credits.
   *
   * So these tests hold the conversion, not just the boundary. Each pair is a
   * balance and a cost where getting the arithmetic wrong flips the answer.
   */
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A wallet of `monthlyCredits` with a `topupCredits` top-up, and optionally an
   * estimated cost in USD.
   *
   * `autumn.check` is the only seam the balance reaches, so it is driven
   * directly — no spying on internals, and no dependency on an export this file
   * would have to add only to be tested.
   */
  async function assert(
    monthlyCredits: number,
    estimatedCostUsd?: number,
    topupCredits = 0,
  ): Promise<string | null> {
    checkMock.mockImplementation(async ({ featureId }: { featureId: string }) =>
      // **The balance is nested.** `autumn.check` answers
      // `{ balance: { remaining } }`, so `{ balance: 57000 }` reads
      // `undefined` — and `undefined <= 0` is false, so the floor never
      // fires and every test passes for the wrong reason. The shape is
      // `getUsageCreditsRemaining` reading `monthlyCheck.balance.remaining`.
      featureId === AUTUMN_SEO_DATA_BALANCE_FEATURE_ID
        ? { balance: { remaining: monthlyCredits } }
        : { balance: { remaining: topupCredits } },
    );

    try {
      await assertUsageCreditsAvailable("org_billing", estimatedCostUsd);
      return null;
    } catch (error) {
      // Narrowed by inspection rather than by assertion, because the type-aware
      // linter bans the `as { code?: string }` cast. `AppError` exposes `code`
      // through a getter and its base type does not declare it, so the read needs
      // a runtime check either way — the check *is* the narrowing.
      if (error instanceof Error && "code" in error) {
        const code: unknown = Reflect.get(error, "code");
        if (typeof code === "string") return code;
      }
      return "NOT_AN_APP_ERROR";
    }
  }

  it("allows a cost whose charge the balance covers", async () => {
    // One credit per USD of marked-up cost. 57_000 credits at the real rate is
    // about $4.46 of vendor spend, so a $4.00 estimate is comfortably inside.
    expect(await assert(57_000, 4)).toBeNull();
  });

  it("refuses a cost whose charge the balance does not cover", async () => {
    expect(await assert(57_000, 100)).toBe("INSUFFICIENT_CREDITS");
  });

  it("refuses when the estimate lands just past the boundary", async () => {
    // The boundary has to be exact rather than generous: a floor that lets a cost
    // through by one credit is the difference between an error and an overdraft.
    // The conversion is ceil(roundUsdForBilling(cost * MARKUP) * CREDITS_PER_USD),
    // so the largest affordable cost is solved from the balance and then nudged
    // past by an amount that survives the rounding.
    //
    // **Computed from the shared constants, not written out.** The first version
    // of this test used `57_000 / (1.28 * 10_000)` — a factor of ten off, because
    // `AUTUMN_SEO_DATA_CREDITS_PER_USD` is 1000, not 10_000. A test whose
    // arithmetic disagrees with the module it is testing passes for the wrong
    // reason, and only the failing case exposed it.
    const affordable =
      57_000 / (SEO_DATA_COST_MARKUP * AUTUMN_SEO_DATA_CREDITS_PER_USD);
    expect(await assert(57_000, affordable)).toBeNull();
    expect(await assert(57_000, affordable + 0.01)).toBe(
      "INSUFFICIENT_CREDITS",
    );
  });

  it("counts the top-up pool toward affordability", async () => {
    // monthly + topup, not one or the other: the two pools are what the charge
    // splits across.
    expect(await assert(0, 4, 57_000)).toBeNull();
  });

  it("still allows a call with no estimate, on a non-empty wallet", async () => {
    // The estimate is optional and omitting it keeps the pre-floor behaviour:
    // any non-empty balance is enough.
    expect(await assert(1)).toBeNull();
  });

  it("still refuses an empty wallet regardless of the estimate", async () => {
    expect(await assert(0, 0.5)).toBe("INSUFFICIENT_CREDITS");
    expect(await assert(0, undefined)).toBe("INSUFFICIENT_CREDITS");
  });
});
