// `scheduledAiKeywordCapture.test.ts` crossed oxlint's 400-line limit as the cap
// tests arrived, so the *bounds* — which are a distinct concern from the *data
// shape* — move here rather than being deleted or the limit raised.
//
// The split is by subject, not by size: the main file asks "what does the capture
// store?", this one asks "what does it refuse to spend?"
import { describe, expect, it, vi } from "vitest";
import { runDueAiKeywordCaptures } from "./scheduledAiKeywordCapture";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const NOW = new Date("2026-10-01T00:00:00.000Z");

/**
 * The watcher's own type, named from the **injection field**.
 *
 * Three wrong spellings before this one, all the same cause: `NonNullable` on a
 * *conditional* indexed access does not distribute, so the type comes out
 * `Fn | undefined` and `Awaited<ReturnType<…>>` rejects it because `undefined` is not
 * a constructor. **A conditional type spreads over a union correctly** — so extracting
 * the field that way and only then applying `ReturnType` is the shape that compiles,
 * and it reads better than the alternatives.
 */
type CapturedInput = NonNullable<Parameters<typeof runDueAiKeywordCaptures>[0]>;
type FetchProjects = CapturedInput extends { fetchProjects?: infer F }
  ? F
  : never;
type Watcher = Awaited<ReturnType<FetchProjects>>[number];

/** A watcher, with only the fields the capture reads. */
const watcher = (projectId: string, keywords: string[]): Watcher => ({
  projectId,
  keywords,
  locationCode: 2840,
  languageCode: "en",
});

/** A vendor response carrying no items — the shape a bounds test needs. */
const noItems = () =>
  vi.fn(async () => ({
    data: { locationCode: 2840, languageCode: "en", items: [] },
    billing: { path: ["/v3/x"], costUsd: 0.002 },
  }));

const run = (watchers: Watcher[], over: Record<string, unknown> = {}) =>
  runDueAiKeywordCaptures({
    now: NOW,
    fetchProjects: async () => watchers,
    fetchVolume: noItems(),
    writeRows: async () => {},
    ...over,
  });

const many = (projectId: string, count: number) =>
  watcher(
    projectId,
    Array.from({ length: count }, (_, i) => `keyword ${i}`),
  );

describe("runDueAiKeywordCaptures — what it refuses to spend", () => {
  it("caps one project's keywords per night, so a large customer is bounded", async () => {
    // **The bound that actually holds.** `limitProjects` counts *customers* and the
    // $5 ceiling bounds a *night*; nothing bounded one customer. With 400 prompts on a
    // single project at $0.002 a call, one batched call is $0.002 — and with the cap
    // raised it would be the customer's bill rather than ours to guess at.
    const report = await run([many("p1", 400)]);

    expect(report.keywordsAsked).toBe(25);
    expect(report.droppedForBudget).toBe(375);
    // **The money followed the cap**: one batched call, not 400. Cost here is per
    // *call*, which is exactly why a low cap is cheap — the smaller the batch, the
    // less one customer can cost us.
    expect(report.estimatedCostUsd).toBeCloseTo(0.002, 6);
  });

  it("caps per project, so one large customer does not consume another's share", async () => {
    // The cap is on a *customer*. A project with 200 keywords is held at 25 even
    // though two small projects would fit under a shared ceiling — sharing the cap
    // across projects is the bug this rules out.
    const report = await run([
      many("big", 200),
      watcher("small-1", ["s1"]),
      watcher("small-2", ["s2"]),
    ]);

    expect(report.keywordsAsked).toBe(27);
    expect(report.droppedForBudget).toBe(175);
  });

  it("still visits a project whose keywords were all dropped", async () => {
    // "1 project visited" with nothing measured reads as "projects are configured but
    // not being measured", which sends an operator looking in the wrong place.
    const report = await run([many("p1", 60)]);

    expect(report.projectsVisited).toBe(1);
    expect(report.keywordsAsked).toBe(25);
  });

  it("makes exactly one call per project however many keywords it watches", async () => {
    // **A batch calculation that could only ever return 1.** The module sliced
    // `keywords` to the vendor's 1000-keyword cap one line above, then computed
    // `Math.ceil(keywords.length / VENDOR_MAX_KEYWORDS)` — dividing an already
    // truncated list by the same cap. It *read* as a batching calculation and was a
    // constant, so a reader would believe the budget accounted for batching.
    const fetchVolume = noItems();

    const report = await run(
      [
        watcher(
          "p1",
          Array.from({ length: 40 }, (_, i) => `k${i}`),
        ),
      ],
      {
        fetchVolume,
      },
    );

    expect(fetchVolume).toHaveBeenCalledTimes(1);
    expect(report.callsMade).toBe(1);
    // **25 rather than 40**, because the per-project cap binds before batching does.
    // The subject is unchanged — one call for the project — and the cap only moved how
    // many keywords ride in it.
    expect(report.keywordsAsked).toBe(25);
    expect(report.droppedForBudget).toBe(15);
  });

  it("keeps the vendor's batch cap as a second bound, not the only one", async () => {
    // The per-project cap (25) is far below the vendor's rejection limit (1000), so
    // **the vendor cap is unreachable through this path** — which is the point: it
    // stays as a real bound for the day the per-project cap is raised, rather than
    // being deleted because today's number happens to be smaller. Exceeding it is a
    // *billed rejection*, not a truncation.
    const fetchVolume = noItems();

    const report = await run(
      [
        watcher(
          "p1",
          Array.from({ length: 1001 }, (_, i) => `k${i}`),
        ),
      ],
      {
        fetchVolume,
      },
    );

    expect(fetchVolume).toHaveBeenCalledTimes(1);
    // **The per-project cap binds first**, and the 976 the vendor's limit would have
    // dropped are reported by *this* one instead — the composition, stated.
    expect(report.keywordsAsked).toBe(25);
    expect(report.droppedForBudget).toBe(976);
  });

  it("bounds the sweep so one tick cannot fan out across every customer", async () => {
    const list = Array.from({ length: 40 }, (_, i) => watcher(`p${i}`, ["k"]));

    const report = await run(list, { limitProjects: 3 });

    expect(report.projectsVisited).toBe(3);
  });

  it("shares one budget across the night rather than giving each project a full one", async () => {
    // The alternative — a full budget per project — makes the night's ceiling depend on
    // how many customers happen to be asking.
    //
    // **2600 projects, not 30, and `limitProjects` raised to match.** Two separate
    // ceilings and the first draft tripped over the smaller one: I expected the $5 night
    // to run out around 25 calls, which assumed a $0.20 unit cost. At $0.002 the budget
    // allows 2500 calls, but the safety valve caps the sweep at 25 projects by default —
    // so with that left alone the budget was never the binding constraint and the test
    // asserted nothing about the thing its name claims.
    const list = Array.from({ length: 2600 }, (_, i) =>
      watcher(`p${i}`, ["k"]),
    );

    const report = await run(list, { limitProjects: 2600 });

    expect(report.callsMade).toBe(2500);
    expect(report.droppedForBudget).toBe(100);
    // The **vendor's** figure, not the planner's: the budget is enforced against the
    // estimate, so conflating them would let a wrong placeholder hide behind the
    // number the run was actually bounded by.
    expect(report.actualCostUsd).toBeCloseTo(5, 6);
    expect(report.estimatedCostUsd).toBeCloseTo(5, 6);
    // And the ceiling held: not one call past it.
    expect(report.estimatedCostUsd).toBeLessThanOrEqual(5);
  });

  it("reports the vendor's cost separately from the estimate, so a wrong placeholder shows", async () => {
    // `AI_KEYWORD_UNIT_COST_USD` is unverified — the live check is blocked on the
    // account being funded. If the report carried one number, a 3x error would be
    // invisible until an invoice arrived. Two numbers make the drift readable on the
    // first real night, which is the only way the placeholder gets corrected.
    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: async () => [watcher("p1", ["k"])],
      fetchVolume: vi.fn(async () => ({
        data: { locationCode: 2840, languageCode: "en", items: [] },
        billing: { path: ["/v3/x"], costUsd: 0.0006 },
      })),
      writeRows: async () => {},
    });

    expect(report.actualCostUsd).toBe(0.0006);
    expect(report.estimatedCostUsd).toBe(0.002);
    // The estimate is higher, so the planner is conservative — the right direction to
    // be wrong in: it drops work it could have afforded rather than spending money
    // nobody budgeted.
    expect(report.actualCostUsd).toBeLessThan(report.estimatedCostUsd);
  });
});
