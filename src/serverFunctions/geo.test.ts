import { describe, expect, it, vi } from "vitest";

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

const serverFnMock = vi.fn((options: { method?: string } = {}) => ({
  middleware: () => ({
    validator: () => ({
      handler: (handler: ServerFnHandler) => ({
        __isServerFn: true,
        options,
        handler,
      }),
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

// The paid-plan gate for the metered reads reaches `@/server/billing`, which
// imports `cloudflare:workers` — a Workers-only module vitest cannot resolve.
// Same reason every other tool test mocks it.
vi.mock("cloudflare:workers", () => ({ env: {} }));

function isServerFn(value: unknown): value is ServerFn {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "__isServerFn") === true;
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
  "getGeoCitationProfile",
  "getGeoEtvSeries",
  "getGeoEvidence",
  "getGeoMentionHistory",
  "getGeoNewLost",
  "getGeoTopCited",
  "getGeoRun",
  "getGeoShareOfVoice",
  "getGeoVisibility",
  "listGeoAnswerHistory",
  "listGeoEvidencedRuns",
  "listGeoPromptSets",
  "listGeoRuns",
  "listGeoTargets",
  "upsertGeoTarget",
];

describe("GEO server functions", () => {
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
