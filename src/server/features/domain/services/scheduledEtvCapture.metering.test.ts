import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";
import { AUTUMN_SEO_DATA_BALANCE_FEATURE_ID } from "@/shared/billing";

/**
 * **The test that proves the metering seam actually runs.**
 *
 * ## Why this file exists separately
 *
 * The other test files for the nightly captures inject a vendor double
 * (`injectOverview`, `fetchVolume`, `runMonitor`). That is correct for testing the
 * capture's own logic — and it means the metered client never executes in those
 * tests, so **none of them can tell whether the capture bills.**
 *
 * So this file takes the opposite approach: no vendor double, no billing double.
 * The real `createDataforseoClient` runs against a mocked Autumn with a controlled
 * balance. That is the only configuration in which "the capture is metered" is an
 * observation rather than a claim.
 *
 * ## What is being asserted, and why it is the refusal
 *
 * The bug this phase fixed was that a zero-credit org **kept receiving captures**
 * every night, paid for by the platform's vendor account. So the assertion is on
 * the **refusal**: no vendor call, no stored point, and the report naming the
 * failure.
 *
 * Asserting "the call happened" would pass just as well on the unmetered code,
 * because the unmetered code also made the call. **An assertion both the fixed and
 * the broken version pass is not a test of the fix.**
 */

// The credit gate reads the balance through Autumn, so this is the seam that
// decides whether the capture is admitted.
const { checkMock, trackMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  trackMock: vi.fn(),
}));

vi.mock("@/server/billing/autumn", () => ({
  autumn: { check: checkMock, track: trackMock },
}));

// The real subscription module stays in place, so `assertUsageCreditsAvailable`
// and `trackUsageCreditSpend` are exercised as written. Only the customer lookup
// is stubbed — a cron's org has no customer record yet, and creating one is not
// what this test is about.
const { getOrCreateMock } = vi.hoisted(() => ({ getOrCreateMock: vi.fn() }));
vi.mock("@/server/billing/subscription", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getOrCreateOrganizationCustomer: getOrCreateMock,
  };
});

// Hosted auth mode, or the gate short-circuits and never reads a balance at all —
// the self-host path skips billing entirely by design.
const { isHostedMock } = vi.hoisted(() => ({ isHostedMock: vi.fn() }));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: isHostedMock,
}));

vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));

vi.mock("@/server/lib/dataforseo/envelope", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, tryBuildTaskBilling: vi.fn(() => undefined) };
});

// **The vendor call is stubbed at the section module, not at the capture's
// injection seam.**
//
// This is the whole point of the file. The capture's own seam (`injectOverview`)
// takes precedence over the metered client, so injecting it would bypass the
// credit gate entirely and the test would assert nothing about billing. Mocking
// the section module leaves the real metered client — and the real
// assertUsageCreditsAvailable — in the path, so the balance is genuinely read.
const { vendorCalls } = vi.hoisted(() => ({ vendorCalls: [] as unknown[] }));
vi.mock("@/server/lib/dataforseo/labs", async (importOriginal) => {
  // **Spread the real module**, because the client factory wraps every fetcher
  // in it and a mock that returns only one makes `createDataforseoClient` throw
  // on a missing export — a failure that looks like a broken client and is a
  // broken mock.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchDomainRankOverview: vi.fn(async (input: unknown) => {
      vendorCalls.push(input);
      return {
        data: [{ metrics: { organic: { etv: 100, count: 1 } } }],
        billing: { path: ["/v3/x"], costUsd: 0.012 },
      };
    }),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const { runDueEtvCaptures } = await import("./scheduledEtvCapture");

/** The write double, typed from the capture's own injection field. */
type WritePoint = NonNullable<
  NonNullable<Parameters<typeof runDueEtvCaptures>[0]>["writePoint"]
>;

let writePoint: MockedFunction<WritePoint>;

const NOW = new Date("2026-10-01T03:00:00.000Z");
const ORG = "org_zero_credit";
const PROJECT = "p1";

/** A wallet of zero, which is the state the capture used to ignore. */
function zeroWallet() {
  checkMock.mockImplementation(
    async ({ featureId }: { featureId: string }) => ({
      balance: featureId === AUTUMN_SEO_DATA_BALANCE_FEATURE_ID ? 0 : 0,
    }),
  );
}

/** A wallet that can afford the ETV call, so the positive case is provable too. */
function fundedWallet() {
  checkMock.mockImplementation(
    async ({ featureId }: { featureId: string }) => ({
      balance: featureId === AUTUMN_SEO_DATA_BALANCE_FEATURE_ID ? 57_000 : 0,
    }),
  );
}

describe("the ETV capture refuses an org with no credits", () => {
  beforeEach(() => {
    // Built from the parameter, exactly as the sibling test's double is: a row
    // cast from a literal would satisfy the signature while carrying none of the
    // fields the repository fills.
    writePoint = vi.fn<WritePoint>(async (input) => ({
      id: 1,
      domain: input.domain,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      projectId: input.projectId,
      endpoint: input.endpoint,
      organicEtv: input.organicEtv ?? null,
      paidEtv: null,
      etvFormulaVersion: input.etv?.formulaVersion ?? "legacy",
      etvRequestedAt: input.etv?.requestedAt ?? NOW.toISOString(),
      capturedAt: input.etv?.requestedAt ?? NOW.toISOString(),
      domainRank: null,
      organicKeywords: null,
      paidKeywords: null,
      pagesCount: null,
      keywordsCount: null,
      backlinksCount: null,
      rank: null,
      cpc: null,
    }));
  });

  it("makes no vendor call and stores nothing", async () => {
    isHostedMock.mockResolvedValue(true);
    getOrCreateMock.mockResolvedValue({ id: "cust_1" });
    zeroWallet();

    const writes: unknown[] = [];

    const report = await runDueEtvCaptures({
      now: new Date("2026-10-01T03:00:00.000Z"),
      limitProjects: 1,
      fetchDomains: async () => [
        {
          projectId: PROJECT,
          domain: "example.com",
          locationCode: 2840,
          languageCode: "en",
        },
      ],
      fetchOrgs: async () => new Map([[PROJECT, ORG]]),
      // **No vendor seam.** The capture's own `injectOverview` takes precedence
      // over the metered client, so injecting it here would bypass the credit gate
      // and assert nothing about billing. The section module is mocked instead,
      // which leaves the real metered client — and the real
      // `assertUsageCreditsAvailable` — in the path.
      writePoint,
    });

    // **The assertions that matter, and none of them is "the call happened".**
    //
    // A funded org MUST reach the vendor for this to mean anything, so the
    // positive case is asserted below rather than assumed.
    expect(vendorCalls.length + writes.length).toBe(0);
    expect(report.domainsAsked).toBe(0);
    expect(report.rowsStored).toBe(0);
    // **Named as a failure, not silently dropped.** "We captured nothing" and "we
    // refused because the org has no credits" are different claims, and only the
    // second is what happened.
    // `failures` is `Array<{ domain, reason }>`, so assert on the reason rather
    // than stringifying the object — `[object Object]` matches nothing and a
    // regex against it passes for the wrong reason.
    expect(report.failures.map((failure) => failure.reason).join(" ")).toMatch(
      /INSUFFICIENT_CREDITS|credit/i,
    );
    expect(report.failures).toHaveLength(1);
  });

  it("still reaches the vendor when the org has credits", async () => {
    // **The positive control, and the reason the test above means anything.**
    //
    // Without it, a capture that never called the vendor for any reason — a
    // broken seam, a thrown import, a silent early return — would pass the
    // refusal test identically. This proves the harness can observe a call, so
    // the refusal above is a refusal rather than an absence.
    isHostedMock.mockResolvedValue(true);
    getOrCreateMock.mockResolvedValue({ id: "cust_1" });
    fundedWallet();

    const report = await runDueEtvCaptures({
      now: new Date("2026-10-01T03:00:00.000Z"),
      limitProjects: 1,
      fetchDomains: async () => [
        {
          projectId: PROJECT,
          domain: "example.com",
          locationCode: 2840,
          languageCode: "en",
        },
      ],
      fetchOrgs: async () => new Map([[PROJECT, ORG]]),
      // **No vendor seam** — the section module mock stands in for the vendor, and
      // the metered client stays in the path.
      writePoint,
    });

    expect(vendorCalls).toHaveLength(1);
    expect(report.domainsAsked).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it("skips a project with no org instead of guessing one", async () => {
    // A cast-in organizationId would let the credit gate pass against a customer
    // that does not exist. The org lookup is the guard, so its absence must be a
    // skip the report can see.
    isHostedMock.mockResolvedValue(true);
    getOrCreateMock.mockResolvedValue({ id: "cust_1" });
    fundedWallet();

    const report = await runDueEtvCaptures({
      now: new Date("2026-10-01T03:00:00.000Z"),
      limitProjects: 1,
      fetchDomains: async () => [
        {
          projectId: PROJECT,
          domain: "example.com",
          locationCode: 2840,
          languageCode: "en",
        },
      ],
      // **No org for the project**, which is the case being guarded.
      fetchOrgs: async () => new Map(),
      writePoint,
    });

    expect(report.domainsAsked).toBe(0);
    expect(report.skippedNoOrganization).toBe(1);
  });
});
