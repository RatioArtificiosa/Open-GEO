/**
 * `runAiModeMonitor`.
 *
 * **This module had no test at all**, despite every collaborator being injectable —
 * `fetchAnswer`, `alreadyRanInWindow`, `recordRun` — and a docstring explaining that
 * injection existed *so the ordering could be tested*. The test was designed for and
 * never written, which is the same class of gap as the keyword table with no writer:
 * the seams are all there, so everything looks finished.
 *
 * The seam that matters most is the **ordering** of the idempotency check against
 * the vendor calls. It is invisible from the outside — both happen — and getting it
 * wrong bills a customer twice for one night with no error anywhere. So that is the
 * first test here, and it asserts the check happens *before* any fetch.
 */
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { runAiModeMonitor } from "./aiModeMonitor";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

/**
 * The repository is the one collaborator that is **not** injectable, so it is
 * mocked at the module boundary. Everything it is asked for here is either empty
 * (no previous captures, so no diff) or a write we are not asserting — the module
 * under test is the planner and the cost accounting, not the persistence.
 */
vi.mock("@/server/features/geo/repositories/GeoRunRepository", () => ({
  GeoRunRepository: {
    listAiModeSnapshots: async () => [],
    insertAiModeSnapshot: async () => {},
    insertSnapshot: async () => {},
  },
}));

const NOW = new Date("2026-10-01T03:00:00.000Z");

/**
 * A `vi.fn()` whose recorded arguments stay typed.
 *
 * `NonNullable<...["recordRun"]>` rather than `...["recordRun"]` directly: the
 * input field is optional, and `vi.fn` rejects `undefined` as a constructor type.
 * Naming the function rather than the optionality is what lets the spy be read
 * back as a value instead of an `any`.
 */
type RecordRun = NonNullable<RunAiModeMonitor["recordRun"]>;

/** The monitor's input type, named once so the spies below can reference it. */
type RunAiModeMonitor = Parameters<typeof runAiModeMonitor>[0];

/**
 * A watched prompt, as the scheduler reads it.
 *
 * **`estimatedCostUsd` and `observedChanges` are load-bearing**, not decoration: the
 * planner sums the cost to enforce the budget and ranks on the change count, so a
 * fixture omitting them yields `NaN`. That is how the first draft of this file
 * produced a suite full of `expected NaN to be close to 0.004` — and `NaN` never
 * equals anything, so the assertion failed loudly rather than passing quietly,
 * which is the one mercy in that particular trap.
 *
 * `observations: 0` **is** the never-observed case; there is no `neverObserved`
 * field, and inventing one would have tested a shape the planner cannot read.
 */
const prompt = (keyword: string) => ({
  keyword,
  estimatedCostUsd: 0.004,
  observedChanges: 0,
  observations: 0,
});

/**
 * An answer, as `fetchAiModeAnswer` resolves it.
 *
 * **Every field of `AiModeAnswer` is present, not the four the module happens to
 * read.** The first draft carried only `keyword`, `elements`, `references` and
 * `checkUrl`, and the tests still passed — because a test double need only satisfy
 * the *reader*, and the reader never looks at `locationCode`. So a fixture that
 * does not match the vendor's shape is invisible to `vitest` and loud only to
 * `tsc`, which is why the type checker is in the sweep rather than left to CI.
 *
 * The four extra fields are also **nullable in the real type**, so they are null
 * here: an answer whose market Google did not echo back is a case the module has to
 * survive, and a fixture with `locationCode: 2840` invented would hide it.
 */
const answer = (costUsd = 0.004, references: Array<{ url?: string }> = []) => ({
  data: {
    keyword: "k",
    locationCode: null,
    languageCode: null,
    datetime: null,
    checkUrl: null,
    elementTypes: ["paragraph"],
    // `type` is **required** on every element in the real type, and `markdownOf`
    // ignores it - so a fixture omitting it passes every assertion and fails `tsc`.
    elements: [{ type: "paragraph", markdown: "the model said something" }],
    references,
  },
  billing: { path: ["/v3/serp/google/ai_mode/live/advanced"], costUsd },
});

const run = (over: Partial<RunAiModeMonitor> = {}) =>
  runAiModeMonitor({
    projectId: "p1",
    prompts: [prompt("k")],
    budgetUsd: 1,
    locationCode: 2840,
    languageCode: "en",
    now: NOW,
    fetchAnswer: async () => answer(),
    alreadyRanInWindow: async () => false,
    recordRun: async () => {},
    ...over,
  });

describe("runAiModeMonitor", () => {
  it("checks the window BEFORE any vendor call, because a repeat bills twice", async () => {
    // The ordering is the whole test. Both the check and the fetch happen in either
    // implementation, so only the *call count* distinguishes them — and getting it
    // wrong charges a customer twice for one night with nothing failing anywhere.
    const fetchAnswer = vi.fn(async () => answer());

    const result = await run({
      alreadyRanInWindow: async () => true,
      fetchAnswer,
    });

    expect(result.ran).toBe(false);
    expect(fetchAnswer).toHaveBeenCalledTimes(0);
    // And the reason is a sentence, not a boolean — an operator reading the log
    // needs to know it was skipped deliberately rather than silently.
    expect(result.skippedReason).toMatch(/already ran in this window/);
  });

  it("reports nothing captured and nothing spent when it skipped", async () => {
    const result = await run({ alreadyRanInWindow: async () => true });

    expect(result.captured).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.actualCostUsd).toBe(0);
  });

  it("reports the vendor's cost beside the estimate", async () => {
    // The estimate is what the budget was enforced against; this is what the
    // customer will be invoiced. A single field would have to be one or the other.
    // Two numbers make a vendor price change visible on the night it happens, which
    // matters because `AI_MODE_UNIT_COST_USD` is verified once and never re-checked.
    const result = await run({ fetchAnswer: async () => answer(0.0031) });

    expect(result.actualCostUsd).toBe(0.0031);
    expect(result.estimatedCostUsd).toBeCloseTo(0.004, 6);
    // A verified constant that has drifted is a stale fact wearing a current date.
    expect(result.actualCostUsd).not.toBe(result.estimatedCostUsd);
  });

  it("counts a billed failure as spending, because the vendor still charged", async () => {
    // A `DataforseoChargedTaskError` failed *after* billing. Counting only the
    // successes would under-report the bill in the direction that hides our own
    // gap — and a failure that cannot say what it cost cannot be reconciled.
    const result = await run({
      fetchAnswer: async () => {
        throw new DataforseoChargedTaskError("upstream task failed", {
          path: ["/v3/serp/google/ai_mode/live/advanced"],
          costUsd: 0.004,
        });
      },
    });

    expect(result.captured).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.actualCostUsd).toBe(0.004);
  });

  it("counts an unbilled failure as nothing, because nothing was charged", async () => {
    // The mirror of the test above, and the pair is the point: a validation error
    // never reached the vendor, so adding an estimate for it would overstate the
    // bill. Zero is the honest figure — not a missing one.
    const result = await run({
      fetchAnswer: async () => {
        throw new AppError(
          "VALIDATION_ERROR",
          "Invalid Field: 'location_name'.",
        );
      },
    });

    expect(result.failed).toHaveLength(1);
    expect(result.actualCostUsd).toBe(0);
  });

  it("never retries a billed failure in the same window", async () => {
    const fetchAnswer = vi.fn(async () => {
      throw new DataforseoChargedTaskError("upstream task failed", {
        path: ["/v3/serp/google/ai_mode/live/advanced"],
        costUsd: 0.004,
      });
    });

    await run({ prompts: [prompt("k"), prompt("k2")], fetchAnswer });

    // One call per admitted keyword, and no retry on top: a retry after an
    // unknown-outcome request is how a budget disappears without a trace.
    expect(fetchAnswer).toHaveBeenCalledTimes(2);
  });

  it("records the run so the next window can see it", async () => {
    // Typed rather than bare `vi.fn(async () => {})`, so reading a recorded
    // argument back is a value and not an `any` — the same helper
    // `scheduledGeoPatrol.test.ts` uses for the same reason.
    const recordRun = vi.fn<RecordRun>(async () => {});

    await run({ recordRun });

    // Without this, the idempotency check above can never fire and every tick
    // re-bills — the failure mode the check exists to prevent.
    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun.mock.calls[0]?.[0]).toMatchObject({
      projectId: "p1",
      startedAt: NOW.toISOString(),
    });
  });

  it("keeps one keyword's failure from cancelling the others", async () => {
    const result = await run({
      prompts: [prompt("bad"), prompt("good")],
      fetchAnswer: async ({ keyword }) => {
        if (keyword === "bad") throw new AppError("INTERNAL_ERROR", "boom");
        return answer();
      },
    });

    expect(result.captured).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.keyword).toBe("bad");
  });

  it("captures a repeated keyword once, however many times it appears in the set", async () => {
    // **A real finding, not a fixture bug.** `geo_prompts` has a unique index on
    // `(prompt_set_id, position)` — **not on the prompt text** — so a set can
    // legitimately hold the same question twice at two positions. Before this, each
    // duplicate became a paid call for one question *and* two rows captured in the
    // same run, which next night's diff would report as a change that never
    // happened. A baseline taken twice in the same second is not a baseline.
    const result = await run({
      prompts: [prompt("k"), prompt("k"), prompt("K ")],
      fetchAnswer: async () => answer(),
    });

    expect(result.captured).toBe(1);
    expect(result.actualCostUsd).toBe(0.004);
  });
});
