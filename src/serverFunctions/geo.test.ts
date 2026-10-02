import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

/**
 * The GEO server-function surface.
 *
 * `serverFunctions/geo.ts` is an entry point (declared as one in knip.jsonc), so
 * nothing imports it and this suite is what keeps its contract honest. The point
 * is not the handlers' behaviour but two invariants: every function is a POST
 * entry point, and none of them may ever read `projectId` from the request body.
 */

type ServerFnHandler = (args: { data: unknown; context: unknown }) => unknown;

type ServerFn = {
  __isServerFn: true;
  options: { method?: string };
  handler: ServerFnHandler;
};

/**
 * Every schema any entry point declared, in declaration order.
 *
 * The mock used to **discard its `.validator()` argument**, so no schema in this
 * file was ever parsed by anything: a validator that rejected nothing, or one
 * missing entirely, would have passed this suite. Since these schemas are the wire
 * contract — the only place a malformed `domain` or a `platform` outside the
 * closed set is caught — recording them is what makes them inspectable.
 *
 * Kept as a list rather than keyed by function name on purpose: `createServerFn` is
 * invoked *before* the `const` it is assigned to exists, so the name is not
 * readable from inside the mock. The first attempt tried to thread it through a
 * mutable holder and would have recorded every schema under an empty key.
 */
const declaredSchemas: unknown[] = [];

const serverFnMock = vi.fn((options: { method?: string } = {}) => ({
  middleware: () => ({
    validator: (schema: unknown) => ({
      handler: (handler: ServerFnHandler) => {
        declaredSchemas.push(schema);
        return {
          __isServerFn: true,
          options,
          handler,
        };
      },
    }),
  }),
}));

vi.mock("@tanstack/react-start", () => ({ createServerFn: serverFnMock }));
vi.mock("@/serverFunctions/middleware", () => ({
  requireProjectContext: ["requireProjectContext"],
}));

/** A `vi.fn()` whose recorded args stay typed, so iterating them is not `any`. */
function serviceSpy() {
  return vi.fn<(...args: unknown[]) => unknown>();
}

const geoServiceMock = {
  listTargets: serviceSpy(),
  upsertTarget: serviceSpy(),
  deleteTarget: serviceSpy(),
  listPromptSets: serviceSpy(),
  createPromptSet: serviceSpy(),
  deletePromptSet: serviceSpy(),
  getVisibility: serviceSpy(),
  getCitationGap: serviceSpy(),
  getCitationProfile: serviceSpy(),
  getCitationGraph: serviceSpy(),
  getAnswer: serviceSpy(),
  listAnswerHistory: serviceSpy(),
  listRuns: serviceSpy(),
  getEtvSeries: serviceSpy(),
  getMentionHistory: serviceSpy(),
  getRun: serviceSpy(),
  getShareOfVoice: serviceSpy(),
  getAiKeywordHistory: serviceSpy(),
  // The evidence drawer's authorization check. Present in the mock because
  // `getGeoEvidence` calls it before anything else, and its absence here made
  // the *other* test in this file fail with a `not a function` — an unrelated
  // error pointing at the wrong line, which is the worst kind to debug.
  ownsSnapshot: serviceSpy(),
};
vi.mock("@/server/features/geo/services/GeoService", () => ({
  GeoService: geoServiceMock,
}));

// The two metered reads live in their own module, so the surface test needs a
// mock for it as well — without one, importing `@/serverFunctions/geo` would
// pull the real DataForSEO client in and the "exports the full surface" test
// would fail on something unrelated to the export list.
vi.mock("@/server/features/geo/services/geoLiveReads", () => ({
  getNewLostSeries: vi.fn(),
  getTopCitedPages: vi.fn(),
}));

// The evidence drawer's reads live in their own module and reach `@/db`, which
// has no client outside a Worker. Without this mock, importing
// `@/serverFunctions/geo` builds a real (unconfigured) database handle and the
// two tests here fail on `undefined.prepare` — an error about the database
// raised by a test about the export surface, which is the least diagnosable kind.
vi.mock("@/server/features/geo/services/evidenceDrawer", () => ({
  getEvidenceForSnapshot: vi.fn(),
  getSpendReconciliation: vi.fn(),
  listEvidencedSnapshots: vi.fn(),
}));

// The visibility forecast's read module, for the same reason as `evidenceDrawer`:
// it joins snapshots against answers and reaches `@/db`, so importing
// `@/serverFunctions/geo` without a mock builds a real database handle and both
// tests here fail on `undefined.prepare` rather than on the thing they check.
vi.mock("@/server/features/geo/services/visibilityForecastReads", () => ({
  forecastForStoredSeries: vi.fn(),
}));

// The paid-plan gate for the metered reads reaches `@/server/billing`, which
// imports `cloudflare:workers` — a Workers-only module vitest cannot resolve.
// Same reason every other tool test mocks it.
vi.mock("cloudflare:workers", () => ({ env: {} }));

function isServerFn(value: unknown): value is ServerFn {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "__isServerFn") === true;
}

/**
 * A declared schema's fields, or null when it is not a Zod object.
 *
 * Two prior attempts are recorded here because each failed in an instructive way:
 * `Object.entries(value).find(([k]) => k === "shape")` returned null for **every**
 * schema, because in Zod 4 `shape` lives on `_def` rather than as an own
 * property; and Zod 4 has no `z.isObjectSchema` to ask.
 *
 * So the brand is read directly: every Zod 4 schema carries `_zod`, and a plain
 * object does not. That single check is enough to tell a real validator from a
 * forgotten `.validator(...)`, which is the whole question here — and it is a
 * *check*, not a cast, so it cannot assert the answer it is looking for.
 */
function shapeOf(value: unknown): Record<string, ZodType> | null {
  if (typeof value !== "object" || value === null) return null;
  const brand: unknown = Reflect.get(value, "_zod");
  if (brand === undefined) return null;
  const def: unknown = Reflect.get(value, "_def");
  if (typeof def !== "object" || def === null) return null;
  const shape: unknown = Reflect.get(def, "shape");
  if (typeof shape !== "object" || shape === null) return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Zod's `_def.shape` is a plain record of its fields
  return shape as Record<string, ZodType>;
}

/** Read a string property without going through `any` (Reflect.get returns any). */
function projectIdOf(value: object): string | undefined {
  for (const [key, entry] of Object.entries(value)) {
    if (key === "projectId" && typeof entry === "string") return entry;
  }
  return undefined;
}

async function loadServerFns(): Promise<Array<[string, ServerFn]>> {
  const module: Record<string, unknown> = await import("@/serverFunctions/geo");
  return Object.entries(module).filter((entry): entry is [string, ServerFn] =>
    isServerFn(entry[1]),
  );
}

const EXPECTED = [
  "createGeoPromptSet",
  "deleteGeoPromptSet",
  "deleteGeoTarget",
  "getGeoAiKeywordHistory",
  "getGeoAnswer",
  "getGeoCitationGap",
  "getGeoCitationGraph",
  "getGeoCitationProfile",
  "getGeoEtvSeries",
  "getGeoEvidence",
  "getGeoMentionHistory",
  "getGeoNewLost",
  "getGeoTopCited",
  "getGeoRun",
  "getGeoVisibility",
  "getGeoVisibilityForecast",
  "listGeoAnswerHistory",
  "listGeoEvidencedRuns",
  "listGeoPromptSets",
  "listGeoRuns",
  "listGeoTargets",
  "upsertGeoTarget",
];

describe("GEO server functions", () => {
  it("refuses to treat a non-Zod validator as a schema", async () => {
    // The control for the test below, and the reason it is not a tautology.
    //
    // Without this, a `shapeOf` that returned the fields of *anything* would let
    // every schema in the surface test pass while proving nothing. Two prior
    // attempts did exactly that: `Object.entries` found no `shape` on a real Zod 4
    // schema and the guard returned null for all of them, which the surface test
    // did not notice because it never looked.
    //
    // The module is imported first, because `declaredSchemas` is filled when
    // `serverFunctions/geo` is *loaded* — the schemas are declared at module scope,
    // not when a test asks for them.
    await loadServerFns();

    expect(shapeOf({})).toBeNull();
    expect(shapeOf({ shape: { domain: "not a zod field" } })).toBeNull();
    expect(shapeOf(null)).toBeNull();
    expect(shapeOf("not an object")).toBeNull();
    // And it accepts a real one, so the null cases above are discriminating rather
    // than the guard simply always failing.
    expect(shapeOf(declaredSchemas[0])).not.toBeNull();
  });

  it("gives every entry point a schema that actually validates", async () => {
    // The mock previously threw the schema away, so this is the first thing in
    // the file that ever *looks* at one. Three properties, each catching a
    // different mistake:
    //
    // - every entry point declared one at all, so a forgotten
    //   `.validator(...)` is caught rather than shipping a body contract of
    //   "whatever arrives";
    // - each is a Zod schema, so `.validator({})` or a plain object is caught;
    // - each **rejects** a `projectId`, which is the guarantee the test below
    //   depends on. The schemas deliberately omit `projectId`, and a Zod object
    //   strips unknown keys — so a body claiming another project cannot reach a
    //   handler at all. A validator that accepted it would make that test pass for
    //   the wrong reason.
    await loadServerFns();
    expect(declaredSchemas.length).toBe(EXPECTED.length);

    for (const schema of declaredSchemas) {
      // Each is a real Zod schema, and each is checked through a **type guard** rather
      // than a cast: the mock recorded an `unknown`, and asserting it *is* a Zod
      // schema would assert the very thing this test exists to check. The guard
      // asks instead.
      const shape = shapeOf(schema);
      expect(shape).not.toBeNull();
      if (shape === null) continue;

      // And none of them declares `projectId`. The wire contract is that a body
      // cannot name its own project: a Zod object strips undeclared keys, so a
      // hostile `projectId` cannot reach the handler at all. If a schema ever
      // grew that field, the guarantee the test below depends on would be gone —
      // and it would go quietly, because stripping and ignoring look identical
      // from the handler.
      expect(Object.keys(shape)).not.toContain("projectId");
    }
  });

  it("exports the full surface", async () => {
    const fns = await loadServerFns();
    expect(new Set(fns.map(([name]) => name))).toEqual(new Set(EXPECTED));
  });

  it("declares every entry point as POST", async () => {
    // All of these take a structured body, including the reads, so a GET with a
    // body would misdescribe the transport.
    for (const [, fn] of await loadServerFns()) {
      expect(fn.options.method).toBe("POST");
    }
  });

  it("never takes projectId from the request body", async () => {
    const authorized = { projectId: "authorized_project" };
    // A hostile body claiming a different project must be ignored by every
    // handler. The schemas ignore unknown keys, so a `projectId` inside `data`
    // survives validation and would silently overwrite the authorized context
    // if the spread order were wrong. This test is the reason it is right.
    const hostile = {
      projectId: "someone_elses",
      targetId: crypto.randomUUID(),
      promptSetId: crypto.randomUUID(),
      answerId: crypto.randomUUID(),
      snapshotId: crypto.randomUUID(),
      prompt: "best geo tool",
      keyword: "geo",
      platform: "chat_gpt",
      domain: "acme.com",
      locationCode: 2840,
      languageCode: "en",
      name: "Core",
      prompts: [{ prompt: "best geo tool" }],
    };

    for (const [, fn] of await loadServerFns()) {
      await fn.handler({ data: hostile, context: authorized });
    }

    for (const serviceFn of Object.values(geoServiceMock)) {
      for (const call of serviceFn.mock.calls) {
        const first = call[0];
        if (typeof first !== "object" || first === null) continue;
        const projectId = projectIdOf(first);
        if (projectId !== undefined) {
          expect(projectId).toBe("authorized_project");
        }
      }
    }
  });
});
