/**
 * `runOpportunityInputCapture` — one project's nightly capture of the three
 * inputs the Opportunity Score never had: `keywordDifficulty`,
 * `serpCompetitors` and `intent`.
 *
 * ## The test this file exists for
 *
 * The service read `row.keyword_difficulty` and `row.competitors` off the same
 * `keyword_overview` row. The vendor nests the former under `keyword_properties`
 * and has no `competitors` field at all — `serp_competitors` is a separate
 * endpoint. So every capture stored two nulls, for the two columns the capture
 * exists to fill, every night, forever. Nothing caught it because the service had
 * no test, and no caller, so nothing noticed it storing nothing.
 *
 * `competitorEase(0)` reads a null as the *lowest* opportunity, so the forecast
 * job would have scored every keyword as trivially easy from data that was never
 * collected. **A writer that runs and stores nothing** is the failure this module
 * exists to prevent.
 *
 * Doubles live in `scheduledOpportunityInputs.fixtures.ts`, in the shapes the
 * vendor actually sends — the repo's own `ga4-test-fixtures.ts` convention, and
 * the thing that would have caught the bug above.
 */
import { describe, expect, it, vi } from "vitest";
import { runOpportunityInputCapture } from "./scheduledOpportunityInputs";
import { KeywordOpportunityInputsRepository } from "@/server/features/domain/repositories/KeywordOpportunityInputsRepository";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import { PER_PROJECT_NIGHTLY_CAP } from "@/shared/nightly-budgets";
import {
  captureWrites,
  competitorRows,
  counting,
  emptyCompetitors,
  emptyIntent,
  emptyOverview,
  intentRows,
  overviewRows,
  someCompetitors,
} from "./scheduledOpportunityInputs.fixtures";

/**
 * The repository reaches `@/db` → `cloudflare:workers`, which only resolves
 * inside a Worker. Every neighbouring capture test stubs it, and the provider
 * must be reported as `d1` so the barrel resolves to SQLite: this test is
 * dual-dialect by construction and never exercises Postgres.
 */
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const NOW = new Date("2026-10-01T03:00:00.000Z");
const UNIT = DFS_LABS.standard.perRequest;

describe("runOpportunityInputCapture", () => {
  it("reads keyword_difficulty from keyword_properties, not off the row", async () => {
    // **The regression test for the bug this service shipped with.**
    //
    // The first draft read `row.keyword_difficulty` and `row.competitors`
    // directly. The vendor nests difficulty under `keyword_properties` and has no
    // `competitors` field at all, so *every* capture stored two nulls for the two
    // columns the capture exists to fill. Nothing caught it because the service
    // had no test — and with no caller either, nothing noticed it storing
    // nothing. `competitorEase(0)` reads a null as the *lowest* opportunity, so
    // the forecast job would have scored every keyword as trivially easy from
    // data that was never collected.
    //
    // A double written in the flat invented shape passes trivially, which is why
    // this file's doubles use the nested one.
    const captured = captureWrites();

    await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["hiking boots"],
      locationCode: 2840,
      now: NOW,
      fetchOverview: overviewRows([
        { keyword: "hiking boots", keyword_difficulty: 42 },
      ]),
      fetchCompetitors: competitorRows(someCompetitors),
      fetchIntent: emptyIntent,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.keywordDifficulty).toBe(42);
    expect(captured[0]?.serpCompetitors).toBe(3);
  });

  it("stores null, never 0, for a field the vendor did not return", async () => {
    // The load-bearing rule, and it applies to all three now:
    // `competitorEase(0)` treats an unmeasured competitor count as the *lowest*
    // opportunity, so a default of 0 for a missing field scores an absent row as
    // if it had been measured and found easy.
    const captured = captureWrites();

    await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["Hiking Boots"],
      locationCode: 2840,
      now: NOW,
      fetchOverview: overviewRows([{ keyword: "hiking boots" }]),
      fetchCompetitors: emptyCompetitors,
      fetchIntent: emptyIntent,
    });

    expect(captured).toHaveLength(1);
    // keyword_difficulty is absent from the vendor row, so it stays null.
    expect(captured[0]?.keywordDifficulty).toBeNull();
    // ...and an empty `serp_competitors` response is an unmeasured SERP, not an
    // uncrowded one. Writing 0 here would read as "no competition".
    expect(captured[0]?.serpCompetitors).toBeNull();
  });

  it("lowercases keywords before matching and before storing", async () => {
    // The vendor echoes the keyword back with its own casing, so a stored
    // "Hiking Boots" would never join the intent row for "hiking boots".
    const captured = captureWrites();

    await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["  Hiking Boots  "],
      locationCode: 2840,
      now: NOW,
      fetchOverview: overviewRows([
        { keyword: "Hiking Boots", keyword_difficulty: 31 },
      ]),
      fetchCompetitors: emptyCompetitors,
      fetchIntent: emptyIntent,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.keyword).toBe("hiking boots");
    expect(captured[0]?.keywordDifficulty).toBe(31);
  });

  it("counts competing domains once, not once per keyword", async () => {
    // `serp_competitors` is one request over the whole keyword list and returns
    // one row per domain. Three keywords each storing 3 would read as nine
    // competitors for one SERP.
    const captured = captureWrites();

    await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["a", "b", "c"],
      locationCode: 2840,
      now: NOW,
      fetchOverview: overviewRows([
        { keyword: "a", keyword_difficulty: 10 },
        { keyword: "b", keyword_difficulty: 20 },
        { keyword: "c", keyword_difficulty: 30 },
      ]),
      fetchCompetitors: competitorRows(someCompetitors),
      fetchIntent: emptyIntent,
    });

    expect(captured).toHaveLength(3);
    for (const row of captured) expect(row.serpCompetitors).toBe(3);
  });

  it("counts each measurement separately so a partial night cannot read as complete", async () => {
    // difficulty, competitors and intent are three different vendor responses,
    // and a silent total is what would let "we captured one of three" look done.
    const captured = captureWrites();

    const report = await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["a", "b", "c"],
      locationCode: 2840,
      now: NOW,
      fetchOverview: overviewRows([
        { keyword: "a", keyword_difficulty: 10 },
        { keyword: "b", keyword_difficulty: 20 },
        { keyword: "c" },
      ]),
      fetchCompetitors: competitorRows(someCompetitors),
      fetchIntent: intentRows([{ keyword: "a", intent: "commercial" }]),
    });

    expect(report.difficultyStored).toBe(2);
    expect(report.competitorsStored).toBe(3);
    expect(report.intentStored).toBe(1);
    // Three rows stored, three separate counts. The numbers are *not* required
    // to agree, which is the point of reporting them apart.
    expect(captured).toHaveLength(3);
  });

  it("makes all three vendor calls, and reports the spend for three", async () => {
    // The call count is the budget's denominator, so an undercount here is a
    // budget that stops one call too late.
    const captured = captureWrites();
    const overview = counting(
      overviewRows([{ keyword: "a", keyword_difficulty: 1 }]),
    );
    const competitors = counting(competitorRows(someCompetitors));
    const intent = counting(
      intentRows([{ keyword: "a", intent: "commercial" }]),
    );

    const report = await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["a"],
      locationCode: 2840,
      now: NOW,
      budgetUsd: null,
      fetchOverview: overview.wrapped,
      fetchCompetitors: competitors.wrapped,
      fetchIntent: intent.wrapped,
    });

    expect(overview.calls()).toBe(1);
    expect(competitors.calls()).toBe(1);
    expect(intent.calls()).toBe(1);
    expect(report.callsMade).toBe(3);
    expect(report.costUsd).toBeCloseTo(UNIT * 3, 6);
    expect(report.errors).toEqual([]);
    expect(captured).toHaveLength(1);
  });

  it("skips the intent call once the budget is spent, and says so", async () => {
    // A cap consulted after the spend is a report, not a cap. With room for two
    // of the three calls, the intent read must not start — and the report must
    // name the shortfall rather than looking like a complete night.
    const captured = captureWrites();
    const intent = counting(
      intentRows([{ keyword: "a", intent: "commercial" }]),
    );

    const report = await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["a"],
      locationCode: 2840,
      now: NOW,
      // Room for the first two calls but not the third: after them the spend
      // is 2×UNIT and 1.5×UNIT is already exceeded, so the intent read stops.
      budgetUsd: UNIT * 1.5,
      fetchOverview: overviewRows([{ keyword: "a", keyword_difficulty: 1 }]),
      fetchCompetitors: competitorRows(someCompetitors),
      fetchIntent: intent.wrapped,
    });

    expect(intent.calls()).toBe(0);
    expect(report.callsMade).toBe(2);
    expect(report.errors.join(" ")).toMatch(/budget/i);
    // Difficulty and competitors were still stored: they were paid for, and
    // dropping a paid row is a loss, not a saving.
    expect(report.difficultyStored).toBe(1);
    expect(report.competitorsStored).toBe(1);
    expect(captured).toHaveLength(1);
  });

  it("caps the keywords per project at the shared nightly cap", async () => {
    // PER_PROJECT_NIGHTLY_CAP.opportunityKeywords is the ceiling; without it a
    // project with 5,000 tracked keywords buys 5,000 Labs rows in one night.
    const captured = captureWrites();
    const many = Array.from(
      { length: PER_PROJECT_NIGHTLY_CAP.opportunityKeywords + 25 },
      (_, i) => `kw-${i}`,
    );

    await runOpportunityInputCapture({
      projectId: "p1",
      keywords: many,
      locationCode: 2840,
      now: NOW,
      budgetUsd: null,
      fetchOverview: overviewRows(
        many.map((keyword) => ({ keyword, keyword_difficulty: 20 })),
      ),
      fetchCompetitors: emptyCompetitors,
      fetchIntent: emptyIntent,
    });

    expect(captured).toHaveLength(PER_PROJECT_NIGHTLY_CAP.opportunityKeywords);
  });

  it("spends nothing and stores nothing for a project with no keywords", async () => {
    // No vendor call at all, not three: a project with an empty keyword list is a
    // no-op, and an early check is the only way to make that true.
    const captured = captureWrites();
    const overview = counting(overviewRows([]));
    const competitors = counting(competitorRows([]));
    const intent = counting(intentRows([]));

    const report = await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["   ", ""],
      locationCode: 2840,
      now: NOW,
      fetchOverview: overview.wrapped,
      fetchCompetitors: competitors.wrapped,
      fetchIntent: intent.wrapped,
    });

    expect(report.keywordsAsked).toBe(0);
    expect(report.callsMade).toBe(0);
    expect(report.costUsd).toBe(0);
    expect(overview.calls()).toBe(0);
    expect(competitors.calls()).toBe(0);
    expect(intent.calls()).toBe(0);
    expect(captured).toEqual([]);
  });

  it("never lets one keyword's write failure lose the rest", async () => {
    // A single row that fails to insert is a string in `errors`, not a thrown
    // capture: the night's other keywords are already paid for and stored.
    //
    // The first write fails and the rest succeed, so `captured` holds the
    // survivors and `errors` names the loss — both, not one. A test that only
    // asserted the error would pass while the second keyword was silently dropped,
    // which is the failure this claims to prevent.
    const captured = captureWrites();
    vi.spyOn(
      KeywordOpportunityInputsRepository,
      "insertPoint",
    ).mockImplementationOnce(async () => {
      throw new Error("database is locked");
    });

    const report = await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["a", "b"],
      locationCode: 2840,
      now: NOW,
      budgetUsd: null,
      fetchOverview: overviewRows([
        { keyword: "a", keyword_difficulty: 1 },
        { keyword: "b", keyword_difficulty: 2 },
      ]),
      fetchCompetitors: emptyCompetitors,
      fetchIntent: emptyIntent,
    });

    expect(report.errors.join(" ")).toMatch(/locked/);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.keyword).toBe("b");
  });

  it("passes no location and no language to the intent call", async () => {
    // `as const`, so the intent is the vendor's label union and not the
    // widened `string` that `SearchIntentItem.intent` rejects.
    const rows = [{ keyword: "a", intent: "commercial" }] as const;
    // *"A task carrying an unknown field is a billed rejection."* Intent is a
    // marketless endpoint, and this is the codebase's most-repeated mistake —
    // so the assertion is on the *arguments*, not merely on the result.
    // Typed from the fetcher's own parameter, so the argument is captured
    // without an assertion and the response matches the real envelope.
    let seen: { keywords: string[]; tag?: string } | undefined;
    await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["a"],
      locationCode: 2840,
      languageCode: "en",
      now: NOW,
      budgetUsd: null,
      fetchOverview: overviewRows([{ keyword: "a" }]),
      fetchCompetitors: emptyCompetitors,
      fetchIntent: async (input: { keywords: string[]; tag?: string }) => {
        seen = input;
        return {
          data: {
            items: rows.map((row) => ({
              keyword: row.keyword,
              intent: row.intent,
              probability: 1,
              secondaryIntents: [],
            })),
          },
          billing: { path: ["search_intent"], costUsd: UNIT },
        };
      },
    });

    expect(seen).toEqual({ keywords: ["a"], tag: "opportunity-inputs:p1" });
    expect(seen).not.toHaveProperty("locationCode");
    expect(seen).not.toHaveProperty("languageCode");
  });

  it("ignores a vendor row for a keyword this project never asked about", async () => {
    // The loop iterates the vendor's *response*, not the keywords it sent, so a
    // row outside `requestedKeywords` would be written into
    // `keyword_opportunity_inputs` for a project that never tracked that
    // keyword. The forecast job would then read it as research that never
    // happened. The first draft of this test caught exactly that: a double that
    // returned every row when 25 keywords were requested stored 50 writes, and
    // the assertion "cap holds" failed for the wrong reason until the guard
    // existed.
    const captured = captureWrites();

    await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["a", "b"],
      locationCode: 2840,
      now: NOW,
      fetchOverview: overviewRows([
        { keyword: "a", keyword_difficulty: 10 },
        { keyword: "b", keyword_difficulty: 20 },
        { keyword: "someone-elses-keyword", keyword_difficulty: 99 },
      ]),
      fetchCompetitors: emptyCompetitors,
      fetchIntent: emptyIntent,
    });

    const keywords = captured.map((row) => row.keyword);
    expect(new Set(keywords)).toEqual(new Set(["a", "b"]));
    expect(keywords).not.toContain("someone-elses-keyword");
  });

  it("stores nothing from an empty vendor response, without throwing", async () => {
    // `items: []` is what the endpoints return with nothing to say, and a suite
    // that only ever supplied figures would never exercise it. Capturing an empty
    // response must store nothing, cost what was spent, and not throw.
    const captured = captureWrites();

    const report = await runOpportunityInputCapture({
      projectId: "p1",
      keywords: ["a"],
      locationCode: 2840,
      now: NOW,
      budgetUsd: null,
      fetchOverview: emptyOverview,
      fetchCompetitors: emptyCompetitors,
      fetchIntent: emptyIntent,
    });

    expect(captured).toEqual([]);
    expect(report.callsMade).toBe(3);
    expect(report.difficultyStored).toBe(0);
    expect(report.errors).toEqual([]);
  });
});
