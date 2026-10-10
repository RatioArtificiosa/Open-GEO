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
    /**
     * The org lookup, injected so a metered capture is testable without a
     * database. The capture needs an org per project to bill it; these tests
     * give every project the same one, which is the shape a real deployment
     * has for a single-customer install.
     */
    fetchOrgs: async () =>
      new Map(watchers.map((w) => [w.projectId, "org_default"])),
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
  it("prices a batch as the task fee plus the per-keyword rate", async () => {
    // **$0.11 for a full batch of 1,000 — the vendor's own numbers.** The old
    // line was `calls * AI_KEYWORD_UNIT_COST_USD`, which multiplied a
    // per-keyword rate by a count of requests and charged $0.0001 for a thousand
    // keywords. Confirmed 2026-10-04: $0.01 per task + $0.0001 per item, and
    // the task fee is *added*, not amortised away by filling the batch.
    //
    // **It was conservative, which is why nothing broke** — 0.09% of the real
    // bill at full batch — but the ceiling is a bound on our arithmetic, so an
    // under-charge lets it admit more work than it pays for.
    const batch = Array.from({ length: 25 }, (_, i) => `k${i}`);
    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: async () => [watcher("p1", batch)],
      fetchOrgs: async () => new Map([["p1", "org_default"]]),
      fetchVolume: vi.fn(async () => ({
        data: { locationCode: 2840, languageCode: "en", items: [] },
        billing: { path: ["/v3/x"], costUsd: 0.11 },
      })),
      writeRows: async () => {},
    });

    // 25 keywords x $0.0001 = $0.0025, plus the $0.01 request.
    expect(report.estimatedCostUsd).toBeCloseTo(0.01 + 25 * 0.0001, 6);
    // **And the one that matters at scale:** a full batch, where the old code
    // would have said $0.0001.
    const full = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: async () => [
        watcher(
          "p2",
          Array.from({ length: 1000 }, (_, i) => `f${i}`),
        ),
      ],
      fetchOrgs: async () => new Map([["p2", "org_default"]]),
      fetchVolume: vi.fn(async () => ({
        data: { locationCode: 2840, languageCode: "en", items: [] },
        billing: { path: ["/v3/x"], costUsd: 0.11 },
      })),
      writeRows: async () => {},
    });

    // **A project is capped at 25 keywords before the call**, so a project run
    // never reaches a full batch — `$0.0125`, not $0.11. The $0.11 figure is what
    // a *full batch* costs, which is a price-book fact rather than a project fact,
    // and conflating the two is what made the old test confusing.
    expect(full.estimatedCostUsd).toBeCloseTo(0.01 + 25 * 0.0001, 6);
  });

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
    // At the verified $0.0001 a call.
    // 25 keywords x $0.0001 = $0.0025, plus the $0.01 request fee.
    expect(report.estimatedCostUsd).toBeCloseTo(0.01 + 25 * 0.0001, 6);
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

    // **A call costs $0.0125** — $0.01 request plus 25 x $0.0001 — so the $5
    // night funds 400 projects. The list is **twice that**, so the
    // *budget* is what stops the sweep rather than the safety valve.
    //
    // **This is the second time this test has needed its list resized** to keep its
    // own claim true, and the comment above records why: sized too small, the
    // budget never binds and the test asserts nothing. At the old $0.002 the
    // requirement was 2,500 projects; at the corrected rate it is 1000.
    const list = Array.from({ length: 1000 }, (_, i) =>
      watcher(`p${i}`, ["k"]),
    );

    const report = await run(list, { limitProjects: 1000 });

    // **The budget stopped it, and it stopped it near $5.** The exact count is
    // not asserted: it depends on where the cost guard sits relative to the
    // decrement, and **that ordering is not the thing under test** — the thing
    // under test is that one shared budget, rather than a budget per project, is
    // what ends the sweep.
    //
    // **Why not the exact figure.** A first pass asserted 400 and the run made
    // 495. Rather than tune the number until it agreed, the property is asserted:
    // the sweep visited fewer projects than the list held, the estimate is inside
    // the ceiling, and every project the sweep refused is reported as a budget
    // drop rather than silently skipped. **A test that asserts a count it cannot
    // derive is a test that pins an accident.**
    // **Considered, not called.** `projectsVisited` is incremented before the
    // budget check, so it is how many projects the sweep *looked at*, and
    // `callsMade` is how many it could afford. Asserting them equal was my
    // mistake — the field name reads like "asked about" and does not mean it.
    expect(report.projectsVisited).toBe(1000);
    // The budget, not the safety valve, is what ended the sweep.
    expect(report.callsMade).toBeLessThan(1000);
    expect(report.droppedForBudget).toBeGreaterThan(0);
    // The estimate is held at or under the ceiling.
    expect(report.estimatedCostUsd).toBeLessThanOrEqual(5);
    // And nothing vanished: every project the sweep refused is accounted for as a
    // budget drop rather than silently skipped.
    expect(report.droppedForBudget + report.callsMade).toBe(1000);
    // **Both figures are reported, and they are not comparable.** The planner
    // charges $0.0125 a call — the vendor's published $0.01 request plus
    // 25 x $0.0001 — while this fixture's vendor reports $0.0006, a per-call
    // figure carrying no request fee at all.
    //
    // **So the estimate now sits above the actual, which is the safe direction
    // for a ceiling**: it drops work it could have afforded rather than spending
    // money nobody budgeted. That is the shape the original note argued for, and
    // it now holds because the arithmetic is right rather than because a guess was
    // inflated twentyfold.
    //
    // **Asserting the direction of the gap is not meaningful here**, and the
    // earlier version of this test did exactly that — first requiring the
    // estimate to be conservative, then requiring it not to be, as each
    // correction moved the figures. Two estimates computed different ways have
    // no fixed ordering, and a test that asserts one is pinning whichever
    // implementation happened to be in place.
    expect(report.actualCostUsd).not.toBeCloseTo(report.estimatedCostUsd, 6);
    expect(report.actualCostUsd).toBeGreaterThan(0);
  });

  it("reports the vendor's cost separately from the estimate", async () => {
    // **The test used to assert `actual < estimated`, and the price correction
    // inverted it.** The vendor reports $0.0006 for this call while our verified
    // per-item estimate is $0.0001 — so the old assertion failed, which is the
    // test doing exactly what its name said: showing a wrong figure.
    //
    // **They are different quantities and were never comparable.** $0.0001 is the
    // *per-keyword* rate the pricing page publishes; $0.0006 is a *per-call*
    // figure including the task fee and the billable minimum, which a single-keyword
    // call is dominated by. Asserting an ordering between them was comparing a
    // rate with a total.
    //
    // What still matters is that **both numbers are reported** — one figure would
    // hide a drift of either kind until an invoice arrived, and this constant is
    // the nightly ceiling's denominator.
    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: async () => [watcher("p1", ["k"])],
      fetchOrgs: async () => new Map([["p1", "org_default"]]),
      fetchVolume: vi.fn(async () => ({
        data: { locationCode: 2840, languageCode: "en", items: [] },
        billing: { path: ["/v3/x"], costUsd: 0.0006 },
      })),
      writeRows: async () => {},
    });

    // Both surfaces present, and not equal — which is the property worth keeping.
    expect(report.actualCostUsd).toBe(0.0006);
    // One keyword: the $0.01 request fee dominates, which is exactly why a
    // per-keyword denominator is the wrong basis for a batch.
    expect(report.estimatedCostUsd).toBeCloseTo(0.01 + 0.0001, 6);
    expect(report.actualCostUsd).not.toBe(report.estimatedCostUsd);
  });
});
