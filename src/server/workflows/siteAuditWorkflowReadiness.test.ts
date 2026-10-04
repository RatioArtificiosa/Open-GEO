import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  pgStepMock,
  getPagesForCitabilityMock,
  runReadinessMock,
  saveReadinessReportMock,
} = vi.hoisted(() => ({
  pgStepMock: vi.fn(),
  getPagesForCitabilityMock: vi.fn(),
  // **Typed by the seam's own signature.** A bare `vi.fn()` gives `mock.calls`
  // the type `any[]`, so every read off it needs an assertion — and an
  // assertion in a test is an unchecked claim about the code under test.
  runReadinessMock: vi.fn<typeof runReadiness>(),
  saveReadinessReportMock: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
// **The reader lives in its own module now**, so the mock has to name that
// module. Mocking `AuditRepository` here looked right — the phase used to go
// through it — and silently stopped applying when the reader moved, leaving the
// *real* database call to run and fail on an unbound Drizzle client. **A mock
// that stops matching its module is a test that stops testing**, and the symptom
// was a TypeError rather than a failing assertion, which is worse: it named the
// database, not the mock.
vi.mock("@/server/features/audit/repositories/auditCitabilityPages", () => ({
  getPagesForCitability: getPagesForCitabilityMock,
}));
vi.mock("@/server/features/audit/services/runReadiness", () => ({
  runReadiness: runReadinessMock,
}));
vi.mock("@/server/features/audit/repositories/auditReadinessReports", () => ({
  saveReadinessReport: saveReadinessReportMock,
}));
vi.mock("@/server/workflows/pgStep", () => ({ pgStep: pgStepMock }));

import { runReadinessPhase } from "@/server/workflows/siteAuditWorkflowReadiness";
import type { WorkflowStepConfig } from "cloudflare:workers";
import type { runReadiness } from "@/server/features/audit/services/runReadiness";
import type { saveReadinessReport } from "@/server/features/audit/repositories/auditReadinessReports";

/**
 * The seam's input shape, derived from its signature.
 *
 * **Not exported from the seam**, and that is correct: knip keeps a type private
 * until something names it, and a test reaching in to force an export would widen
 * a module's API for its own convenience. `typeof` on a type-only import is the
 * narrow way to ask.
 */
type ReadinessInput = Parameters<typeof runReadiness>[0];

const PARAMS = {
  auditId: "audit-1",
  startUrl: "https://example.com/guide/page",
  pagesAttempted: 3,
};

/** A page row as the repository hands it over: parsed, fetchClass intact. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/a",
    fetchClass: "ok",
    headings: [{ level: 1, title: "A" }],
    schemaTypes: ["Article"],
    ...overrides,
  };
}

/**
 * One prioritised fix, complete.
 *
 * **Every field filled, and typing the mock is what forced that.** A bare
 * `vi.fn()` accepted `{ id: "a" }` — a partial row wearing a complete one's name,
 * the same shape as a zero-filled score. Typing the mock by the seam's signature
 * made it a compile error, which is the point: **a fixture that does not match
 * the contract is a test that is asserting against a fiction.**
 */
function fix(id: string) {
  return {
    id,
    kind: "switch" as const,
    fix: `do ${id}`,
    because: "it comes before everything else",
    example: null,
    order: 0,
  };
}

/**
 * A complete `runReadiness` result.
 *
 * **Every field present, not just the ones these tests read.** A partial object
 * is a fixture describing a fiction: it passes, and the day production returns a
 * `coverage` array this omits, the test still passes against `undefined`. Typing
 * the mock is what turned that from invisible into a compile error.
 */
function readinessResult(fixes: ReturnType<typeof fix>[]) {
  return {
    fixes,
    coverage: ["robots.txt was read, so crawler access was judged."],
    whyNoScore:
      "A blocked crawler and perfect content average to a healthy middle.",
    summary: "One thing to fix first.",
    pages: [],
    unavailable: [],
    notes: [],
  };
}

beforeEach(() => {
  pgStepMock.mockReset();
  getPagesForCitabilityMock.mockReset();
  runReadinessMock.mockReset();
  saveReadinessReportMock.mockReset();
  // pgStep is mocked, so the opaque WorkflowStep is never read. Passthrough lets
  // each test assert on the *config* the phase chose, which is the decision worth
  // pinning.
  pgStepMock.mockImplementation(
    async (
      _step: unknown,
      _name: string,
      _config: unknown,
      fn: () => Promise<unknown>,
    ) => fn(),
  );
  getPagesForCitabilityMock.mockResolvedValue([row()]);
  runReadinessMock.mockResolvedValue(readinessResult([fix("a"), fix("b")]));
});

describe("runReadinessPhase", () => {
  /**
   * The payload the phase wrote.
   *
   * **One cast, here, rather than six `any` reads below.** Vitest types
   * `mock.calls` as `any[]` regardless of the `vi.fn<T>()` type argument, so
   * every read off it is an unsafe access. Casting once, at the boundary where the
   * mock's value becomes the writer's declared input, keeps the assertion checked
   * against a real type.
   */
  function written() {
    const call = saveReadinessReportMock.mock.calls[0];
    if (call === undefined)
      throw new Error("saveReadinessReport was never called");
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- vitest types mock.calls as any[]; the cast is the mock's, not the assertion's
    return call[0] as Parameters<typeof saveReadinessReport>[0];
  }

  it("persists the report, because a computed report nobody can read is nobody's report", async () => {
    // **The reason `audit_readiness` exists.** An earlier version computed the
    // report and returned only a count, so the whole pipeline ended at a number in
    // a checkpoint — which is the same defect one layer up from the one the
    // phase's docblock used to describe.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    await runReadinessPhase({} as never, PARAMS);

    expect(saveReadinessReportMock).toHaveBeenCalledOnce();
    const payload = written();
    // The identifying fields, not the whole payload: `whyNoScore` is required by
    // the schema, and a write that omitted it would fail at the database rather
    // than here.
    expect(payload.auditId).toBe("audit-1");
    expect(payload.whyNoScore.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.fixes)).toBe(true);
    // **Zero, and that is right.** The fixture's result carries `pages: []`, so a
    // scored page count of zero is what the phase should persist — the count
    // describes the *report*, not the fixture's page input.
    expect(payload.pageCount).toBe(0);
  });

  it("writes nothing when the report itself failed", async () => {
    // **A failed run must not leave a stale report behind.** Persisting an empty
    // one would tell the next reader that this audit found nothing to fix, when
    // the truth is that it never finished.
    runReadinessMock.mockRejectedValue(new Error("boom"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    await runReadinessPhase({} as never, PARAMS);

    expect(saveReadinessReportMock).not.toHaveBeenCalled();
    logged.mockRestore();
  });
  /**
   * The input `runReadiness` actually received.
   *
   * **Typed through the seam's own signature rather than read off `mock.calls`
   * inline**, which is `any` — and an `any` property access is an unchecked
   * assertion wearing a test's clothes. Here a change to the seam's input type
   * becomes a compile error in the test instead of an `any` that accepts anything.
   */
  function received(): ReadinessInput {
    const call = runReadinessMock.mock.calls[0];
    if (call === undefined) throw new Error("runReadiness was never called");
    // **No assertion.** The mock is typed by the seam's signature, so this is the
    // argument the phase actually passed, checked.
    return call[0];
  }

  it("derives the origin from the start URL rather than using the URL itself", async () => {
    // The fetches build `${origin}/robots.txt`, so passing the full page URL would
    // request `https://example.com/guide/page/robots.txt` — a 404 on every audit,
    // reported as "this site publishes nothing".
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked, so the step object is never read
    await runReadinessPhase({} as never, PARAMS);

    expect(runReadinessMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://example.com" }),
    );
  });

  it("passes only pages that were actually fetched", async () => {
    getPagesForCitabilityMock.mockResolvedValue([
      row({ url: "https://example.com/ok" }),
      row({ url: "https://example.com/blocked", fetchClass: "blocked" }),
      row({ url: "https://example.com/errored", fetchClass: "error" }),
      row({ url: "https://example.com/limited", fetchClass: "rate_limited" }),
    ]);

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    await runReadinessPhase({} as never, PARAMS);

    const call = received();
    expect(call.pages.map((p: { url: string }) => p.url)).toEqual([
      "https://example.com/ok",
    ]);
  });

  it("passes no archived-answer measurements, because this audit joins none", async () => {
    // **Zeros would fabricate the one measured factor in the rubric.** The
    // competitive-density factor is the only thing here derived from observed
    // behaviour; passing 0/0/0 would turn "we never looked this URL up in the
    // archive" into "the archive says it was never cited".
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    await runReadinessPhase({} as never, PARAMS);

    const call = received();
    expect(call.pages[0]).toMatchObject({
      citationsObserved: null,
      answersObserved: null,
      competingPagesCited: null,
    });
  });

  it("forwards the attempted count so the report can name what it missed", async () => {
    // **Asserted on the value that reaches `runReadiness`, not merely that the key
    // was present.** A `toHaveBeenCalledWith(expect.objectContaining(...))` alone
    // passed while the forward was deleted, because `runReadiness` defaults the
    // field with `?? pages.length` — so a phase that forgot it would silently
    // report "3 of 3 analysed" for a crawl that attempted five. **Asserting that a
    // value was passed is not the same as asserting it arrived.**
    getPagesForCitabilityMock.mockResolvedValue([
      row(),
      row({ url: "https://example.com/b" }),
    ]);

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    await runReadinessPhase({} as never, PARAMS);

    const call = received();
    // 3 attempted, 2 analysable — the gap the report must be able to name.
    expect(call.pagesAttempted).toBe(3);
    expect(call.pages).toHaveLength(2);
  });

  it("forwards a null heading list as null, not as an empty array", async () => {
    // A page that was never parsed has *unknown* structure, which the rubric
    // scores as unmeasured. `[]` would say "parsed, and it had no headings" — a
    // finding about the customer's markup that we did not earn.
    getPagesForCitabilityMock.mockResolvedValue([
      row({ headings: null, schemaTypes: null }),
    ]);

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    await runReadinessPhase({} as never, PARAMS);

    const call = received();
    expect(call.pages[0].headings).toBeNull();
    expect(call.pages[0].schemaTypes).toBeNull();
  });

  it("uses its own step name and config", async () => {
    // The step name is part of the Workflow's durable state: renaming one orphans
    // in-flight audits, and a shared config would inherit a timeout sized for a
    // different job.
    const seen: { name: string | null; config: WorkflowStepConfig | null } = {
      name: null,
      config: null,
    };
    pgStepMock.mockImplementation(
      async (
        _step: unknown,
        name: string,
        config: WorkflowStepConfig,
        fn: () => Promise<unknown>,
      ) => {
        seen.name = name;
        seen.config = config;
        return fn();
      },
    );

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    await runReadinessPhase({} as never, PARAMS);

    expect(seen.name).toBe("readiness");
    // Retries are safe here precisely because nothing in this step is billed.
    expect(seen.config?.retries?.limit).toBe(2);
  });

  it("returns the fix count so the step is observably doing work", async () => {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    const result = await runReadinessPhase({} as never, PARAMS);

    expect(result).toEqual({ readinessFixCount: 2 });
  });

  it("resolves with a zero count when the report itself fails", async () => {
    // **The promise the docblock makes, tested.** `It cannot fail the audit` was
    // written before the catch existed — a guarantee stated where no code
    // implemented it, which is the exact shape of claim this project keeps
    // catching. A report that silently comes back empty looks precisely like a
    // site with nothing to fix, so the audit completing is only half of it: the
    // failure has to be on the record too.
    runReadinessMock.mockRejectedValue(new Error("site audit query timed out"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    const result = await runReadinessPhase({} as never, PARAMS);

    expect(result).toEqual({ readinessFixCount: 0 });
    // **Logged, not swallowed.** A silent catch is the same as no catch, with extra
    // steps.
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("lets the error escape the step so the platform's retries still apply", async () => {
    // **The catch placement is the implementation, and this asserts the boundary
    // * rather than a retry count.**
    //
    // A try/catch *inside* the `pgStep` callback would swallow the failure, so the
    // step would never fail and therefore **never retry** — a transient database
    // blip would permanently produce an empty report. Catching the *step* leaves
    // the platform's retry machinery free to do its job.
    //
    // The first version of this test asserted three attempts and failed with one,
    // which is the honest result: `pgStep` is mocked, so the platform's internal
    // retry loop never runs and a retry *count* here would be asserting the mock.
    // What can be tested is that the rejection crosses the `pgStep` boundary at
    // all — and that is precisely the property the placement changes.
    let reachedPhaseHandler = false;
    pgStepMock.mockImplementation(
      async (
        _step: unknown,
        _name: string,
        _config: unknown,
        fn: () => Promise<unknown>,
      ) =>
        // Re-throw rather than catch: this stands in for the platform letting a
        // step fail, which is what gives the platform's retries something to do.
        fn(),
    );
    runReadinessMock.mockRejectedValue(new Error("transient"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      reachedPhaseHandler = true;
    });

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    const result = await runReadinessPhase({} as never, PARAMS);

    // The rejection reached the phase's own handler rather than being absorbed by
    // the step — which is the whole difference between retrying and not.
    expect(reachedPhaseHandler).toBe(true);
    expect(result).toEqual({ readinessFixCount: 0 });
    logged.mockRestore();
  });

  it("handles an audit whose crawl persisted no pages at all", async () => {
    // A crawl that produced nothing must not throw here — the crawl phase already
    // has an integrity guard for that, and duplicating it would fail the audit
    // twice for one condition.
    getPagesForCitabilityMock.mockResolvedValue([]);

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- pgStep is mocked
    const result = await runReadinessPhase({} as never, PARAMS);

    expect(result).toEqual({ readinessFixCount: 2 });
  });
});
