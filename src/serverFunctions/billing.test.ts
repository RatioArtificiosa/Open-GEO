import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

/**
 * The operator billing surface.
 *
 * `serverFunctions/billing.ts` is an entry point, so nothing in `src/` imports
 * it and this suite is what keeps its contract honest. Two invariants matter
 * and only one of them is about the happy path:
 *
 * 1. **The admin gate fails closed.** An unconfigured deployment has no owner,
 *    so the dial must be unreachable by everyone rather than reachable by
 *    whoever is signed in. The previous version of this logic was a constant
 *    in a public repository, so the whole point is that a mistake here is
 *    silent and expensive.
 * 2. **No handler ever mutates the markup.** Only `setCostMarkupSetting`
 *    writes, and only after the gate. A second path to the same row is a
 *    second gate that has to be remembered.
 */

type ServerFnHandler = (args: {
  data: unknown;
  context: unknown;
}) => Promise<unknown>;

type ServerFn = {
  __isServerFn: true;
  options: { method?: string };
  handler: ServerFnHandler;
};

/**
 * Every schema any entry point declared, in declaration order.
 *
 * Hoisted into `vi.hoisted` alongside the mock, because a `const` here is not
 * initialized when the hoisted mock factory runs — the same failure the geo
 * surface test documents from the other direction.
 */
const { declaredSchemas } = vi.hoisted(() => ({
  declaredSchemas: [] as unknown[],
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn((options: { method?: string } = {}) => ({
    // Both shapes exist in the surface: `.middleware().validator().handler()`
    // and `.middleware().handler()` directly, so the mock returns a chain that
    // satisfies either.
    middleware: () => ({
      validator: (schema: ZodType) => ({
        // The schema is recorded so a later edit that drops or widens a
        // validator is visible here rather than only on the wire.
        handler: (handler: ServerFnHandler) => {
          declaredSchemas.push(schema);
          return { __isServerFn: true, options, handler };
        },
      }),
      handler: (handler: ServerFnHandler) => ({
        __isServerFn: true,
        options,
        handler,
      }),
    }),
  })),
}));

vi.mock("@/serverFunctions/middleware", () => ({
  requireAuthenticatedContext: ["requireAuthenticatedContext"],
  requireProjectContext: ["requireProjectContext"],
}));

/**
 * The allowlist, read from the environment by the module under test.
 *
 * A `let` rather than a constant so a single describe block can prove both
 * sides: with it empty the dial is unreachable, and with it populated only the
 * named user gets in. A frozen value would only ever test one of them.
 */
let adminAllowlist = "";

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (name: string) =>
    name === "PLATFORM_ADMIN_USER_IDS" || name === "BILLING_COST_MARKUP"
      ? adminAllowlist
      : undefined,
  ),
  getRequiredEnvValue: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
}));

vi.mock("@/server/billing/costMarkup", () => ({
  applyCostMarkup: vi.fn(),
  describeCostMarkup: vi.fn(),
  resolveCostMarkup: vi.fn(),
  setConfiguredCostMarkupOverride: vi.fn(),
}));
vi.mock("@/server/billing/autumn", () => ({
  autumn: {
    check: vi.fn(),
    track: vi.fn(),
    customers: { getOrCreate: vi.fn() },
  },
  AUTUMN_TRACK_RETRY_OPTIONS: {},
}));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  waitUntil: vi.fn(),
  env: { DATABASE_PROVIDER: "d1" },
}));

/** The module under test, loaded once. Narrowed by name in `adminFns`. */
const billingModule: Record<string, unknown> = await import("./billing");

/**
 * The dial, mocked above, wrapped so its spies keep their recorded calls
 * inspectable through the module namespace.
 */
const costMarkupMock = vi.mocked(await import("@/server/billing/costMarkup"));

const OWNER = "user_owner";
const STRANGER = "user_stranger";

const CONTEXT = { userId: STRANGER };

beforeEach(() => {
  adminAllowlist = "";
  vi.clearAllMocks();
});

/** A module value narrowed to a server function, not asserted into one. */
function isServerFn(value: unknown): value is ServerFn {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "__isServerFn") === true;
}

/**
 * Both admin entry points, resolved by name from the module they are declared
 * in — and guarded rather than cast, so a name that no longer exists is a
 * test failure rather than a call to `undefined`.
 *
 * Keeping this to the two names under test is the point: a third write path
 * appearing later would not be covered here, which is exactly the regression
 * this file exists to notice.
 */
function adminFns() {
  const read = billingModule["getBillingAdminSettings"];
  const write = billingModule["setCostMarkupSetting"];
  if (!isServerFn(read) || !isServerFn(write)) {
    throw new Error("billing server functions not loaded");
  }
  return { read, write };
}

describe("getBillingAdminSettings", () => {
  it("refuses a signed-in user when no owner is configured", async () => {
    adminAllowlist = "";
    await expect(
      adminFns().read.handler({ data: {}, context: CONTEXT }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a signed-in user who is not the owner", async () => {
    adminAllowlist = "user_somebody_else";
    await expect(
      adminFns().read.handler({ data: {}, context: CONTEXT }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns the current setting for the owner", async () => {
    adminAllowlist = `${OWNER},user_other`;
    costMarkupMock.describeCostMarkup.mockResolvedValue({
      markup: 1.28,
      source: "operator",
    });
    await expect(
      adminFns().read.handler({
        data: {},
        context: { userId: OWNER },
      }),
    ).resolves.toEqual({ markup: 1.28, source: "operator" });
  });
});

describe("setCostMarkupSetting", () => {
  it("refuses a write from a stranger", async () => {
    adminAllowlist = OWNER;
    await expect(
      adminFns().write.handler({
        data: { markup: 9 },
        context: CONTEXT,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      costMarkupMock.setConfiguredCostMarkupOverride,
    ).not.toHaveBeenCalled();
  });

  it("refuses a write when no owner is configured", async () => {
    adminAllowlist = "";
    await expect(
      adminFns().write.handler({
        data: { markup: 2 },
        context: { userId: OWNER },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      costMarkupMock.setConfiguredCostMarkupOverride,
    ).not.toHaveBeenCalled();
  });

  it("writes the owner's value and attributes it to them", async () => {
    adminAllowlist = OWNER;
    costMarkupMock.setConfiguredCostMarkupOverride.mockResolvedValue(undefined);
    costMarkupMock.describeCostMarkup.mockResolvedValue({
      markup: 1.5,
      source: "operator",
    });
    await expect(
      adminFns().write.handler({
        data: { markup: 1.5 },
        context: { userId: OWNER },
      }),
    ).resolves.toEqual({ markup: 1.5, source: "operator" });
    expect(costMarkupMock.setConfiguredCostMarkupOverride).toHaveBeenCalledWith(
      {
        markup: 1.5,
        updatedByUserId: OWNER,
      },
    );
  });

  it("clears the override when the owner sends null", async () => {
    adminAllowlist = OWNER;
    costMarkupMock.setConfiguredCostMarkupOverride.mockResolvedValue(undefined);
    costMarkupMock.describeCostMarkup.mockResolvedValue({
      markup: 1,
      source: "default",
    });
    await expect(
      adminFns().write.handler({
        data: { markup: null },
        context: { userId: OWNER },
      }),
    ).resolves.toEqual({ markup: 1, source: "default" });
    expect(costMarkupMock.setConfiguredCostMarkupOverride).toHaveBeenCalledWith(
      {
        markup: null,
        updatedByUserId: OWNER,
      },
    );
  });

  // The audit column is what makes a changed margin attributable. A write
  // that omitted it would leave an unattributable dial, which is the same as
  // an unaudited one.
  it("never writes without recording who changed it", async () => {
    adminAllowlist = OWNER;
    costMarkupMock.setConfiguredCostMarkupOverride.mockResolvedValue(undefined);
    costMarkupMock.describeCostMarkup.mockResolvedValue({
      markup: 1.2,
      source: "operator",
    });
    await adminFns().write.handler({
      data: { markup: 1.2 },
      context: { userId: OWNER },
    });
    const write = vi.mocked(costMarkupMock.setConfiguredCostMarkupOverride);
    const firstCall = write.mock.calls[0]?.[0];
    expect(firstCall?.updatedByUserId).toBe(OWNER);
  });
});
