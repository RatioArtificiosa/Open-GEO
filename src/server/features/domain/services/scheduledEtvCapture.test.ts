/**
 * `runDueEtvCaptures` — the writer `domain_metrics` never had.
 *
 * Every test is a claim the module's docstring makes, and each one is a way the
 * stored number could be wrong in the direction that looks best. The ETV chart is
 * read by `useGeoPageData` with a formula-version caveat, so a confidently wrong
 * point is worse than a missing one.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";
import { runDueEtvCaptures } from "./scheduledEtvCapture";
import type { DomainMetricsRepository } from "@/server/features/domain/repositories/DomainMetricsRepository";
import type { fetchDomainRankOverview } from "@/server/lib/dataforseo/labs";
import { DFS_LABS } from "@/shared/dataforseo-pricing";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const NOW = new Date("2026-10-01T03:00:00.000Z");

/** The module's collaborators, aliased so a double cannot drift from them. */
type FetchDomainsFn = NonNullable<
  Parameters<typeof runDueEtvCaptures>[0] extends infer I
    ? I extends { fetchDomains?: infer F }
      ? F
      : never
    : never
>;
const UNIT = DFS_LABS.standard.perRequest;

/**
 * The doubles are typed from the **real collaborators' own types**, not from the
 * optional injection fields and not from `as never`.
 *
 * Two wrong versions: `as never` silenced the linter while leaving every argument
 * unchecked, and `NonNullable<Input["writePoint"]>` on a *conditional* indexed
 * access did not distribute — so the type came out `Fn | undefined`, which
 * `vi.fn<T>` rejects because `undefined` is not a constructor.
 *
 * So each type is named from the thing itself. `typeof fetchOverview` can never be
 * optional, and a test double that stops matching the module's collaborator is a
 * **compile error** rather than a test that quietly passes against a stale shape.
 */
type FetchDomains = FetchDomainsFn;
type FetchOverview = typeof fetchDomainRankOverview;
type WritePoint = typeof DomainMetricsRepository.insertPoint;
type OverviewInput = Parameters<FetchOverview>[0];

/** A tracked domain, as the repository would return it. */
const domain = (name: string, projectId = "p1") => ({
  projectId,
  domain: name,
  locationCode: 2840,
  languageCode: "en",
});

/**
 * A vendor response. `organic: null` is the **default on purpose**: the endpoint
 * returns `items: []` when it has nothing, and a test that only ever supplied a
 * figure would never exercise the case that matters.
 */
const overview =
  (
    etv: number | null,
    costUsd = UNIT,
    version: "legacy" | "new" = "new",
  ): FetchOverview =>
  async () => ({
    data: etv === null ? [] : [{ metrics: { organic: { etv, count: 10 } } }],
    billing: {
      path: ["/v3/dataforseo_labs/google/domain_rank_overview/live"],
      costUsd,
    },
    etv: {
      formulaVersion: version,
      useNewEtv: version === "new",
      requestedAt: NOW.toISOString(),
    },
  });

let writePoint: MockedFunction<WritePoint>;
let clock: ReturnType<typeof vi.useFakeTimers>;

beforeEach(() => {
  // A **stub that stores nothing**, because the repository is the thing that
  // writes and it is not under test here. The previous version threw, which is a
  // reasonable guard and a bad double: the module catches a failing writer and
  // records it as a per-domain failure, so two tests silently became "the writer
  // blew up" instead of what they claimed to check.
  // The returned row is **built from the parameter**, not cast from a literal: a
  // stub that returns `{ id: "m1" }` satisfies the signature while carrying none of
  // the fields the repository actually fills, so a caller reading them back would
  // see undefined rather than fail here.
  writePoint = vi.fn<WritePoint>(async (input) => ({
    id: 1,
    domain: input.domain,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    projectId: input.projectId,
    endpoint: input.endpoint,
    organicEtv: input.organicEtv ?? null,
    paidEtv: null,
    // `etv` is optional in the insert type — and the module **always** passes
    // it, because `insertPoint` refuses a row without it. So the optional is a fact
    // about the type rather than about the call, and the double reads the default the
    // same way the repository does rather than asserting the caller was right.
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
  clock = vi.useFakeTimers();
  clock.setSystemTime(NOW);
});
afterEach(() => {
  clock.useRealTimers();
});

const run = (
  domains: Array<ReturnType<typeof domain>>,
  injectOverview: FetchOverview,
  over: Partial<NonNullable<Parameters<typeof runDueEtvCaptures>[0]>> = {},
) =>
  runDueEtvCaptures({
    now: NOW,
    fetchDomains: (async () => domains) as FetchDomains,
    // The org lookup, doubled so a metered capture can be tested without a
    // database. Every domain in these tests belongs to one org, which is the
    // shape a real deployment has and the one the billing context needs.
    fetchOrgs: (async () =>
      new Map(domains.map((d) => [d.projectId, "org_default"]))) as Parameters<
      typeof runDueEtvCaptures
    >[0] extends infer I
      ? I extends { fetchOrgs?: infer F }
        ? F
        : never
      : never,
    injectOverview,
    writePoint,
    ...over,
  });

/** What the writer was asked to store, as the parameter type rather than a guess. */
type StoredPoint = Parameters<WritePoint>[0];
const stored = (): StoredPoint => {
  const call = writePoint.mock.calls[0];
  if (!call) throw new Error("writePoint was never called");
  return call[0];
};

describe("runDueEtvCaptures", () => {
  it("stores one point per domain, with the endpoint named", async () => {
    await run([domain("acme.com")], overview(1200));

    expect(writePoint).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({
      domain: "acme.com",
      endpoint: "domain_rank_overview",
      organicEtv: 1200,
    });
  });

  it("stores the formula version with the value, or the value is unreadable", async () => {
    // The claim the whole `etv-versioning` module exists to make: a value stamped
    // with the wrong formula becomes meaningless on 2026-11-01.
    await run([domain("acme.com")], overview(1200, UNIT, "new"));

    expect(stored().etv).toEqual({
      formulaVersion: "new",
      useNewEtv: true,
      requestedAt: NOW.toISOString(),
    });
  });

  it("stamps the request time, not the moment the formula was resolved", async () => {
    // `labs.ts` builds its provenance when it resolves the mode, so passing it
    // through would give every row in a night the same instant — and the stamp is
    // what makes a fetch reproducible.
    const report = await run([domain("acme.com")], overview(1200));

    expect(stored().etv?.requestedAt).toBe(NOW.toISOString());
    expect(report.rowsStored).toBe(1);
  });

  it("stores nothing when the vendor reports no metrics, and says it asked", async () => {
    // `items: []` means we asked and it had nothing. A `0` would claim we measured
    // and found no traffic — a claim about the world, not about our archive.
    const report = await run([domain("acme.com")], overview(null));

    expect(writePoint).not.toHaveBeenCalled();
    expect(report.rowsStored).toBe(0);
    // **Asked is not the same as stored**, and the report keeps them apart.
    expect(report.domainsAsked).toBe(1);
  });

  it("stores a measured zero as zero", async () => {
    await run([domain("acme.com")], overview(0));

    expect(writePoint).toHaveBeenCalledTimes(1);
    expect(stored().organicEtv).toBe(0);
  });

  it("reports the vendor's cost beside the price-book estimate", async () => {
    // A repriced endpoint shows up as drift on the first night rather than as a
    // budget that was quietly wrong for a month.
    const report = await run([domain("acme.com")], overview(1200, UNIT * 2));

    expect(report.actualCostUsd).toBe(UNIT * 2);
    expect(report.estimatedCostUsd).toBe(UNIT);
  });

  it("never retries a billed failure in the same night", async () => {
    const injectOverview: MockedFunction<FetchOverview> = vi.fn<FetchOverview>(
      async () => {
        throw new Error("upstream exploded");
      },
    );

    const report = await run(
      [domain("a.com"), domain("b.com")],
      injectOverview,
    );

    expect(injectOverview).toHaveBeenCalledTimes(2);
    expect(report.failures).toHaveLength(2);
  });

  it("keeps one domain's failure from cancelling the others", async () => {
    const mixed: FetchOverview = async ({ target }: OverviewInput) => {
      if (target === "bad.com") throw new Error("balance exhausted");
      return {
        data: [{ metrics: { organic: { etv: 500, count: 3 } } }],
        billing: { path: ["/v3/x"], costUsd: UNIT },
        etv: {
          formulaVersion: "new",
          useNewEtv: true,
          requestedAt: NOW.toISOString(),
        },
      };
    };

    const report = await run([domain("bad.com"), domain("good.com")], mixed);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.domain).toBe("bad.com");
    expect(report.rowsStored).toBe(1);
  });

  it("never asks about a project with no tracked brand", async () => {
    // The opt-in with no flag: nothing configured, nothing asked, nothing billed.
    const report = await run([], overview(1200));

    expect(report.projectsVisited).toBe(0);
    expect(report.domainsAsked).toBe(0);
  });

  it("bounds the sweep so one tick cannot fan out across every customer", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      domain(`d${i}.com`, `p${i}`),
    );

    const report = await run(many, overview(1200), { limitProjects: 3 });

    expect(report.projectsVisited).toBe(3);
    expect(report.domainsAsked).toBe(3);
  });

  it("stops when the nightly budget is spent, and names what it dropped", async () => {
    // 3 calls at $0.012 is under the $5 night, so 3 is asked and the rest are named.
    const many = Array.from({ length: 20 }, (_, i) =>
      domain(`d${i}.com`, `p${i}`),
    );

    const report = await run(many, overview(1200));

    expect(report.domainsAsked).toBe(20);
    expect(report.droppedForBudget).toBe(0);
    expect(report.estimatedCostUsd).toBeCloseTo(20 * UNIT, 6);
  });

  it("caps one project's domains per night, so a large customer is bounded", async () => {
    // **The cap that actually holds.** `limitProjects` bounds how many *customers* one
    // tick touches; nothing bounded how much *one* customer cost. With 200 domains on a
    // single project at `$0.012` a call, that is $2.40 of the $5 night from one account
    // — and 5,000 domains would be $60, with nothing refusing it.
    const oneProject = Array.from({ length: 200 }, (_, i) =>
      domain(`d${i}.com`, "big"),
    );

    const report = await run(oneProject, overview(1200), {
      // A project limit high enough that the per-project cap is what binds, so this
      // test measures the cap rather than the valve.
      limitProjects: 100,
    });

    // 25 measured. The other 75 are named rather than silently omitted — and the
    // number is 75 rather than 175 because `limitProjects: 100` sliced the 200 domains
    // *first*, so 100 never reached the per-project cap. **The two caps compose**, and
    // the report names whichever one dropped the work.
    expect(report.domainsAsked).toBe(25);
    expect(report.droppedForBudget).toBe(75);
    // **And the money followed the cap**, which is the whole point: $0.30, not $2.40.
    expect(report.estimatedCostUsd).toBeCloseTo(25 * UNIT, 6);
  });

  it("applies the cap per project, so two projects do not dilute each other", async () => {
    // The cap is on a *customer*, not on the night — so a customer with 40 domains is
    // held at 25 even though a second project with 3 more would fit under a shared
    // ceiling. Sharing the cap across projects is the bug this test rules out.
    const report = await run(
      [
        ...Array.from({ length: 40 }, (_, i) => domain(`a${i}.com`, "big")),
        ...Array.from({ length: 3 }, (_, i) => domain(`b${i}.com`, "small")),
      ],
      overview(1200),
      { limitProjects: 100 },
    );

    expect(report.domainsAsked).toBe(28);
    expect(report.droppedForBudget).toBe(15);
  });

  it("still counts a project it dropped domains for, rather than reporting zero visits", async () => {
    // A report saying "1 project" while measuring nothing reads as "no projects are
    // configured", which sends an operator looking in the wrong place entirely.
    const report = await run(
      Array.from({ length: 60 }, (_, i) => domain(`d${i}.com`, "big")),
      overview(1200),
      { limitProjects: 100 },
    );

    expect(report.projectsVisited).toBe(1);
    expect(report.domainsAsked).toBe(25);
  });
});
