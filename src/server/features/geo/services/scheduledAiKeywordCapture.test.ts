/**
 * The nightly AI keyword demand capture.
 *
 * Every test here is a **claim**, not a value — the module's docstring lists four,
 * and this file checks each:
 *
 * 1. the market comes from the target, never the caller;
 * 2. cost is per *call* and the budget is checked **before** the first one;
 * 3. a month of `0` and a month of `null` stay distinct;
 * 4. a billed failure is never retried on the same tick.
 */
import { describe, expect, it, vi } from "vitest";
import { runDueAiKeywordCaptures } from "./scheduledAiKeywordCapture";

/**
 * `@/db` reads `env` at import time through this module, which only exists inside
 * a worker. The capture is driven entirely through injected collaborators below, so
 * the database is never touched — this only has to satisfy the import graph.
 */
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const NOW = new Date("2026-10-01T00:00:00.000Z");

type Watcher = {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
};

type VolumeItem = {
  keyword: string;
  ai_search_volume?: number | null;
  ai_monthly_searches?: Array<{
    year: number;
    month: number;
    ai_search_volume?: number | null;
  }> | null;
};

/** A watcher list, as the repository would return it. */
const watchers = (list: Watcher[]) => async () => list;

/**
 * A vendor response, as `fetchAiKeywordVolume` resolves it.
 *
 * **`billing` is not optional in the real type** and that is the point: it is the
 * vendor's own cost, the authoritative figure the product meters against. A test
 * double that omits it would be asserting against a shape the client cannot return.
 */
const volume =
  (items: VolumeItem[], costUsd = 0.002) =>
  async () => ({
    data: { locationCode: 2840, languageCode: "en", items },
    billing: {
      path: ["/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live"],
      costUsd,
    },
  });

/** A sink that records what it was asked to store. */
function sink() {
  const stored: Array<Record<string, unknown>> = [];
  return {
    stored,
    write: async (rows: Array<Record<string, unknown>>) =>
      void stored.push(...rows),
  };
}

describe("runDueAiKeywordCaptures", () => {
  it("writes one row per month the vendor reported", async () => {
    const w = sink();
    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: ["best crm"],
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume: volume([
        {
          keyword: "best crm",
          ai_monthly_searches: [
            { year: 2026, month: 7, ai_search_volume: 1200 },
            { year: 2026, month: 8, ai_search_volume: 1400 },
            { year: 2026, month: 9, ai_search_volume: 1500 },
          ],
        },
      ]),
      writeRows: w.write,
    });

    expect(report.rowsStored).toBe(3);
    expect(report.keywordsAsked).toBe(1);
    expect(w.stored.map((r) => r.month)).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });

  it("stores the vendor's keyword verbatim, because that is the join key", async () => {
    // `ai-keywords.ts` normalises on both request and response precisely so the
    // returned string is safe to join on. Re-normalising here would be a second
    // copy of that rule, and a second copy is where mis-joined rows come from.
    const w = sink();
    await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: ["Best CRM"],
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume: volume([
        {
          keyword: "best crm",
          ai_monthly_searches: [{ year: 2026, month: 9, ai_search_volume: 5 }],
        },
      ]),
      writeRows: w.write,
    });

    expect(w.stored[0]?.keyword).toBe("best crm");
  });

  it("keeps a month of zero distinct from a month with no data", async () => {
    // The pair this table exists to preserve. The vendor's own schema says a month
    // may legitimately be 0 — "the keyword had no recorded AI demand then" — and
    // the repository refuses to interpolate a missing month to zero because that
    // invents a dip. Flattening them here would undo both defences at once.
    const w = sink();
    await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: ["k"],
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume: volume([
        {
          keyword: "k",
          ai_monthly_searches: [
            { year: 2026, month: 7, ai_search_volume: 0 },
            { year: 2026, month: 8, ai_search_volume: null },
          ],
        },
      ]),
      writeRows: w.write,
    });

    expect(w.stored.map((r) => r.aiSearchVolume)).toEqual([0, null]);
  });

  it("sends the target's market, never the caller's", async () => {
    // A US-only figure attached to a London project is a different measurement
    // wearing the same label. The market is not a parameter of this function at
    // all, which is the strongest form of that rule.
    const fetchVolume = vi.fn(async () => ({
      data: { locationCode: 2840, languageCode: "en", items: [] },
      billing: { path: ["/v3/x"], costUsd: 0.002 },
    }));

    await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: ["k"],
          locationCode: 2826,
          languageCode: "en",
        },
      ]),
      fetchVolume,
      writeRows: async () => {},
    });

    expect(fetchVolume).toHaveBeenCalledWith(
      expect.objectContaining({ locationCode: 2826, languageCode: "en" }),
    );
  });

  it("never retries a billed failure on the same tick", async () => {
    // The request was metered and we do not know whether it landed, so a second
    // attempt can bill twice for one night. A retry is how a budget disappears
    // without a trace.
    const fetchVolume = vi.fn(async () => {
      throw new Error("upstream exploded");
    });

    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: ["k"],
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume,
      writeRows: async () => {},
    });

    expect(fetchVolume).toHaveBeenCalledTimes(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason).toMatch(/upstream exploded/);
  });

  it("keeps one project's failure from cancelling the others", async () => {
    const w = sink();
    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "bad",
          keywords: ["k"],
          locationCode: 2840,
          languageCode: "en",
        },
        {
          projectId: "good",
          keywords: ["k2"],
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume: async ({ keywords }: { keywords: string[] }) => {
        if (keywords[0] === "k") throw new Error("balance exhausted");
        return {
          data: {
            locationCode: 2840,
            languageCode: "en",
            items: [
              {
                keyword: "k2",
                ai_monthly_searches: [
                  { year: 2026, month: 9, ai_search_volume: 3 },
                ],
              },
            ],
          },
          billing: { path: ["/v3/x"], costUsd: 0.002 },
        };
      },
      writeRows: w.write,
    });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.projectId).toBe("bad");
    expect(report.rowsStored).toBe(1);
  });

  it("drops a keyword's months rather than writing a malformed one", async () => {
    // A vendor sending month 13 would produce "2026-13", which sorts after every
    // real month and reads as the newest point on the chart — a plausible number
    // in the wrong place. Skipped rather than clamped: inventing month 12 is also
    // a fabrication.
    const w = sink();
    await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: ["k"],
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume: volume([
        {
          keyword: "k",
          ai_monthly_searches: [
            { year: 2026, month: 13, ai_search_volume: 999 },
            { year: 2026, month: 0, ai_search_volume: 888 },
            { year: 2026, month: 9, ai_search_volume: 7 },
          ],
        },
      ]),
      writeRows: w.write,
    });

    expect(w.stored.map((r) => r.month)).toEqual(["2026-09"]);
  });

  it("reports a keyword with no monthly history as asked-about but not stored", async () => {
    // The vendor can return a keyword with `ai_monthly_searches` absent. That is
    // "we looked and there is no history", not a failure — and the report keeps
    // the two apart so a reader is not told the keyword was skipped.
    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: ["k"],
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume: volume([{ keyword: "k" }]),
      writeRows: async () => {},
    });

    expect(report.keywordsAsked).toBe(1);
    expect(report.rowsStored).toBe(0);
    expect(report.failures).toHaveLength(0);
  });

  it("bounds the sweep so one tick cannot fan out across every customer", async () => {
    const list = Array.from({ length: 40 }, (_, i) => ({
      projectId: `p${i}`,
      keywords: ["k"],
      locationCode: 2840,
      languageCode: "en",
    }));
    const report = await runDueAiKeywordCaptures({
      now: NOW,
      limitProjects: 3,
      fetchProjects: watchers(list),
      fetchVolume: volume([]),
      writeRows: async () => {},
    });

    expect(report.projectsVisited).toBe(3);
  });

  it("shares one budget across the night rather than giving each project a full one", async () => {
    // The alternative — a full budget per project — makes the night's ceiling
    // depend on how many customers happen to be asking, which is the bug the AI
    // Mode runner fixed the other way round.
    //
    // **2600 projects, not 30 — and `limitProjects` raised to match.** Two separate
    // ceilings, and the first draft tripped over the smaller one: I expected the $5
    // night to run out around 25 calls, which assumed a $0.20 unit cost. At the real
    // $0.002 the budget allows 2500 calls — but the first-deploy safety valve caps
    // the sweep at **25 projects** by default, so with that left alone the budget
    // was never the binding constraint and the test asserted nothing about the
    // thing its name claims.
    //
    // Two lessons in one: a test needs its *binding* constraint to be the one it is
    // about, and a second safety ceiling hides behind the first.
    const list = Array.from({ length: 2600 }, (_, i) => ({
      projectId: `p${i}`,
      keywords: ["k"],
      locationCode: 2840,
      languageCode: "en",
    }));

    const report = await runDueAiKeywordCaptures({
      now: NOW,
      limitProjects: 2600,
      fetchProjects: watchers(list),
      fetchVolume: volume([]),
      writeRows: async () => {},
    });

    // $5 / $0.002 = 2500 affordable calls, 100 projects named as dropped.
    expect(report.callsMade).toBe(2500);
    expect(report.droppedForBudget).toBe(100);
    // The **vendor's** figure, not the planner's: the budget is enforced against
    // the estimate, so conflating the two would let a wrong placeholder hide behind
    // the number the run was actually bounded by.
    expect(report.actualCostUsd).toBeCloseTo(5, 6);
    expect(report.estimatedCostUsd).toBeCloseTo(5, 6);
    // And the ceiling held: not one call past it.
    expect(report.estimatedCostUsd).toBeLessThanOrEqual(5);
  });

  it("reports the vendor's cost separately from the estimate, so a wrong placeholder shows", async () => {
    // `AI_KEYWORD_UNIT_COST_USD` is unverified — the live check is blocked on the
    // account being funded. If the report only carried one number, a 3x error would
    // be invisible until an invoice arrived. Two numbers make the drift readable on
    // the first real night, which is the only way the placeholder gets corrected.
    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: ["k"],
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume: volume([], 0.0006),
      writeRows: async () => {},
    });

    expect(report.actualCostUsd).toBe(0.0006);
    expect(report.estimatedCostUsd).toBe(0.002);
    // The estimate is higher, so the planner is conservative — which is the right
    // direction to be wrong in: it drops work it could have afforded rather than
    // spending money nobody budgeted.
    expect(report.actualCostUsd).toBeLessThan(report.estimatedCostUsd);
  });

  it("makes exactly one call per project however many keywords it watches", async () => {
    // **A batch calculation that could only ever return 1.** The module sliced
    // `keywords` to the vendor's 1000-keyword cap one line above, then computed
    // `Math.ceil(keywords.length / VENDOR_MAX_KEYWORDS)` — dividing an
    // already-truncated list by the same cap. The expression *read* as a batching
    // calculation and was a constant, so a reader would believe the budget accounted
    // for batching when it accounted for nothing.
    //
    // The overflow is still handled — the slice above drops it and names it in
    // `droppedForBudget` — so the claim here is narrower: one project is one call,
    // and the test pins the call count rather than the arithmetic.
    const fetchVolume = vi.fn(async () => ({
      data: { locationCode: 2840, languageCode: "en", items: [] },
      billing: { path: ["/v3/x"], costUsd: 0.002 },
    }));

    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: Array.from({ length: 40 }, (_, i) => `keyword ${i}`),
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume,
      writeRows: async () => {},
    });

    expect(fetchVolume).toHaveBeenCalledTimes(1);
    expect(report.callsMade).toBe(1);
    expect(report.keywordsAsked).toBe(40);
    // One call's worth of spend for forty keywords, which is the point of batching.
    expect(report.estimatedCostUsd).toBeCloseTo(0.002, 6);
  });

  it("names the keywords it dropped when a set exceeds the vendor's batch cap", async () => {
    // The other half of the same fact: the slice is not silent. A set of 1001
    // keywords asks about 1000 and says so, rather than quietly covering the 999th
    // for a month.
    const fetchVolume = vi.fn(async () => ({
      data: { locationCode: 2840, languageCode: "en", items: [] },
      billing: { path: ["/v3/x"], costUsd: 0.002 },
    }));

    const report = await runDueAiKeywordCaptures({
      now: NOW,
      fetchProjects: watchers([
        {
          projectId: "p1",
          keywords: Array.from({ length: 1001 }, (_, i) => `keyword ${i}`),
          locationCode: 2840,
          languageCode: "en",
        },
      ]),
      fetchVolume,
      writeRows: async () => {},
    });

    expect(fetchVolume).toHaveBeenCalledTimes(1);
    expect(report.keywordsAsked).toBe(1000);
    expect(report.droppedForBudget).toBe(1);
  });
});
