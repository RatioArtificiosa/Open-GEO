/**
 * `GeoPatrol` in queued mode.
 *
 * Extracted from `GeoPatrol.test.ts` when that file crossed the lint's line cap
 * while being converted to `noUncheckedIndexedAccess`. The extraction is not
 * cosmetic: **the queued branch is a distinct code path** — it posts prompts and
 * returns rather than calling the vendor itself, and every fixture below is the
 * mock that makes that path observable. A single file holding two unrelated mock
 * setups would make both harder to read, and would grow back to the same size the
 * next time a finding needed a fix.
 *
 * The mocks below are a copy of the ones in `GeoPatrol.test.ts` on purpose: the
 * two paths do not share their collaborators, and a shared fixture module between
 * them would be an abstraction over two independent things that only look alike.
 */

import { describe, expect, it, vi } from "vitest";
import { geoAnswerUnitCostUsd } from "@/shared/dataforseo-pricing";

/** A `vi.fn()` whose recorded args stay typed, so reading one back is not `any`. */
function spy() {
  return vi.fn<(...args: never[]) => unknown>();
}

const listTargets = spy();
const mentionsSearch = spy();
const recordRun = spy();
const recordVendorTask = spy().mockResolvedValue(true);
/** The project's saved prompts, which the queued branch now reads. */
const promptsForQueuedRun = spy().mockResolvedValue([]);
/**
 * The size of every batch the queue was asked to post, in order.
 *
 * A plain array rather than a `vi.fn()`: the shared `spy()` helper types its
 * parameters `never[]` so a test can *read* recorded arguments back without
 * touching `any`, and that correctly rejects a call carrying an argument. The
 * first version passed the input to the spy, `tsc` rejected it on Linux, and
 * `knip` — which does not type-check — stayed green locally.
 */
const postedBatches: number[] = [];
/**
 * Its response shape matters, and getting it wrong produces a failure that looks
 * exactly like the bug under test: `postBatch` reads `response.data` for the
 * accepted count and `response.billing.costUsd` for the advance, so a mock
 * returning `{}` makes every post "refused" and the run reports
 * `promptsAsked: 0` — indistinguishable from the dormancy being fixed. The first
 * version of this test did precisely that and reported a product bug that was in
 * the mock. So the shape is mirrored here, once, and used by the mock below.
 */
function acceptedResponse(count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => ({ id: `task_${i}` })),
    billing: {
      costUsd: count * 0.01,
      path: ["/v3/ai_optimization/llm_responses/task_post/live"],
    },
  };
}

/**
 * The metered task post, stubbed at the client's entry point.
 *
 * A plain function rather than a spy, and the response is the vendor's own
 * shape: `data` is the accepted list (one entry per task) and `billing.costUsd`
 * is the post-time advance. See the note on `spy()` above for why a `vi.fn()`
 * with `never[]` parameters cannot carry the input.
 */
function postQueuedTasks(input: { tasks: unknown[] }) {
  postedBatches.push(input.tasks.length);
  return Promise.resolve(acceptedResponse(input.tasks.length));
}

vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { listTargets },
  platformSupportsRetrieval: (platform: string) => platform === "chat_gpt",
}));
vi.mock("@/server/features/geo/services/GeoService", () => ({
  GeoService: { recordRun, promptsForQueuedRun },
}));
/**
 * The queued post now travels **through the metered client** — CL-202 was a
 * post that reached the vendor without it, paying with the platform's own
 * account against orgs whose balance was never read. So the mock moved from the
 * section module up to the client's entry point, which is the seam the
 * production code uses. `queuePlanner.test.ts` keeps the *real* client and the
 * real gate in the path and proves the money behaviour there; this file is
 * about the run's reporting, so a stubbed entry is the right level.
 *
 * **Counted, not recorded through the shared `spy()`.** That helper types its
 * parameters `never[]` so a test can *read* recorded arguments back without
 * touching `any` — and `never[]` rejects a call with an argument, which is
 * correct for its purpose and wrong for this one. The first version passed the
 * input to the spy and `tsc` rejected it on Linux while the file had already
 * been committed; `knip` does not type-check, so it stayed green here.
 */
vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: () => ({
    aiSearch: { mentionsSearch, llmResponsesTaskPost: postQueuedTasks },
  }),
}));
vi.mock("@/server/features/geo/services/vendorTaskRecorder", () => ({
  recordVendorTask,
}));

const { GeoPatrol } = await import("@/server/features/geo/services/GeoPatrol");

const TARGET = {
  id: "t1",
  domain: "acme.com",
  locationCode: 2840,
  languageCode: "en",
  name: "Acme",
  createdAt: "2026-01-01T00:00:00.000Z",
  aliases: null,
};

const CUSTOMER = {
  organizationId: "org_1",
  userEmail: "test@example.com",
  userId: "user_1",
  projectId: "p1",
};

describe("GeoPatrol in queued mode", () => {
  /**
   * The queued branch was, until this change, **built, tested and unreachable**:
   * it required `input.queuePrompts` and nothing in production supplied one. The
   * tests below are the first that exercise it with no explicit prompts at all,
   * which is the only shape the scheduler now uses.
   */
  it("asks the project's saved prompts when the caller supplies none", async () => {
    listTargets.mockReset().mockResolvedValue([TARGET]);
    recordRun.mockClear();
    postedBatches.length = 0;
    promptsForQueuedRun
      .mockClear()
      .mockResolvedValue(["best crm", "acme pricing"]);

    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      unitCostUsd: geoAnswerUnitCostUsd(),
      createdBy: "schedule",
      mode: "queued",
      platforms: ["chat_gpt"],
    });

    // The prompts came from the project, not the caller.
    expect(promptsForQueuedRun).toHaveBeenCalledWith("p1");
    // And something was posted — the assertion that matters, because before the
    // fix this returned `promptsAsked: 0` with a note and no vendor call.
    expect(postedBatches.length).toBeGreaterThan(0);
    expect(result.promptsAsked).toBeGreaterThan(0);
    expect(result.answersArchived).toBe(0);
    // A queued run posts and returns; it archives nothing, and the archive fills
    // in when the answers arrive. A non-null snapshot here would mean it had
    // invented one.
    expect(result.snapshotId).toBeNull();
  });
});
