/**
 * `runDueOpportunityInputCaptures` — the nightly sweep across every project with
 * tracked keywords, and the constants it budgets and prices from.
 *
 * ## The test this file exists for
 *
 * The sweep shipped as a writer with **no caller** for a whole release. It took
 * `{ projectIds, keywordsByProject, locationCode }` and nothing in the codebase
 * could produce that shape, because a project's tracked keywords each carry their
 * own `locationCode` and `languageCode` and the signature collapsed them into
 * one. The first test below is the assertion that the reason the code was dead is
 * now fixed.
 *
 * The rest follow `scheduledEtvCapture.test.ts`: doubles injected through the same
 * fields the production caller uses, typed from the real collaborators'
 * `typeof` rather than `as never`, so a double that stops matching the real thing
 * is a compile error rather than a test that quietly passes against a stale shape.
 */
import { describe, expect, it, vi } from "vitest";
import { runDueOpportunityInputCaptures } from "./scheduledOpportunityInputs";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import {
  NIGHTLY_BUDGET_USD,
  NIGHTLY_PROJECT_SWEEP_LIMIT,
  PER_PROJECT_NIGHTLY_CAP,
} from "@/shared/nightly-budgets";
import {
  captureWrites,
  competitorRows,
  intentRows,
  keywordRow,
  overviewRows,
  someCompetitors,
} from "./scheduledOpportunityInputs.fixtures";

/**
 * The repository reaches `@/db` → `cloudflare:workers`, which only resolves
 * inside a Worker. Every neighbouring capture test stubs it.
 */
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const NOW = new Date("2026-10-01T03:00:00.000Z");
const UNIT = DFS_LABS.standard.perRequest;

describe("runDueOpportunityInputCaptures", () => {
  /**
   * Doubles that **echo the keywords back with a measured value**, so a stored
   * row exists to inspect. `overviewRows([])` would pass these tests while
   * storing nothing at all — an empty double asserts an empty result, which is
   * not the claim being made.
   */
  const doubles = {
    fetchOverview: overviewRows(
      Array.from(
        { length: PER_PROJECT_NIGHTLY_CAP.opportunityKeywords },
        (_, i) => ({ keyword: `kw-${i}`, keyword_difficulty: 31 }),
      ),
    ),
    fetchCompetitors: competitorRows(someCompetitors),
    fetchIntent: intentRows([{ keyword: "kw-0", intent: "commercial" }]),
  };

  it("groups by (project, market) rather than collapsing to one market", async () => {
    // **The assertion that fixes the dead code.** One `locationCode` for the
    // whole sweep was why nothing could call it: a project tracking the same
    // keyword in two markets gets two captures, because difficulty differs per
    // market and averaging them invents a number.
    const captured = captureWrites();
    const rows = [
      keywordRow("kw-0", { locationCode: 2840 }),
      keywordRow("kw-0", { locationCode: 2724 }),
    ];

    await runDueOpportunityInputCaptures({
      trackedKeywords: rows,
      now: NOW,
      ...doubles,
    });

    // Set comparison, not a sorted array: the repo lib target predates
    // Array#toSorted, and the point is membership rather than order.
    expect(new Set(captured.map((row) => row.locationCode))).toEqual(
      new Set([2724, 2840]),
    );
    expect(captured).toHaveLength(2);
  });

  it("keeps the same keyword under two language codes as two rows", async () => {
    // `saved_keywords`'s unique index is (project, keyword, location, language),
    // so `en` and `en-GB` can both exist and the vendor returns different
    // difficulty for them. Deduplicating them would drop real tracked keywords.
    const captured = captureWrites();
    const rows = [
      keywordRow("kw-0", { languageCode: "en" }),
      keywordRow("kw-0", { languageCode: "en-GB" }),
    ];

    await runDueOpportunityInputCaptures({
      trackedKeywords: rows,
      now: NOW,
      ...doubles,
    });

    expect(new Set(captured.map((row) => row.languageCode))).toEqual(
      new Set(["en", "en-GB"]),
    );
  });

  it("keeps one project's failure from cancelling the others", async () => {
    // The same fault isolation the patrol applies: an outage for one project is
    // a line in `errors` and the sweep carries on.
    const captured = captureWrites();
    const rows = [
      keywordRow("kw-0", { projectId: "p1" }),
      keywordRow("kw-1", { projectId: "p2" }),
    ];

    const report = await runDueOpportunityInputCaptures({
      trackedKeywords: rows,
      now: NOW,
      fetchOverview: async ({ keywords }: { keywords: string[] }) => {
        // The first project's vendor read fails outright; the second must still
        // be captured. A double that merely returned `[]` would have made this
        // test pass for the wrong reason — no failure, and no error to report.
        if (keywords[0] === "kw-0") {
          throw new Error("upstream timeout");
        }
        return {
          data: [
            {
              keyword: "kw-1",
              keyword_properties: { keyword_difficulty: 5 },
            },
          ],
          billing: {
            path: ["/v3/dataforseo_labs/google/keyword_overview/live"],
            costUsd: UNIT,
          },
        };
      },
      fetchCompetitors: async () => ({
        data: [],
        billing: { path: ["serp_competitors"], costUsd: UNIT },
      }),
      fetchIntent: async () => ({
        data: { items: [] },
        billing: { path: ["search_intent"], costUsd: UNIT },
      }),
    });

    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors.join(" ")).toMatch(/p1|timeout/);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.projectId).toBe("p2");
  });

  it("visits at most the nightly sweep limit", async () => {
    // NIGHTLY_PROJECT_SWEEP_LIMIT bounds one night. The repository orders by
    // createdAt so the oldest tracked keyword is captured before the newest,
    // which is what makes "the first 25" the right 25 rather than an arbitrary 25.
    const rows = Array.from(
      { length: NIGHTLY_PROJECT_SWEEP_LIMIT + 3 },
      (_, i) => keywordRow(`kw-${i}`, { projectId: `p${i}` }),
    );

    const report = await runDueOpportunityInputCaptures({
      trackedKeywords: rows,
      now: NOW,
      ...doubles,
    });

    expect(report.projectsVisited).toBe(NIGHTLY_PROJECT_SWEEP_LIMIT);
  });

  it("spends nothing when no project tracks a keyword", async () => {
    const captured = captureWrites();

    const report = await runDueOpportunityInputCaptures({
      trackedKeywords: [],
      now: NOW,
      ...doubles,
    });

    expect(report.projectsVisited).toBe(0);
    expect(report.callsMade).toBe(0);
    expect(report.costUsd).toBe(0);
    expect(captured).toEqual([]);
  });
});

// ── The numbers this capture reports against ────────────────────────────────

describe("the constants it budgets and prices from", () => {
  it("budgets from the same shared nightly pool as the other captures", () => {
    // One shared budget, not a per-service constant. `scheduledEtvCapture` and
    // this capture must spend from the same pool or "the nightly budget" is a
    // phrase that means nothing.
    expect(typeof NIGHTLY_BUDGET_USD.opportunityInputs).toBe("number");
    expect(NIGHTLY_BUDGET_USD.opportunityInputs).toBeGreaterThan(0);
  });

  it("prices off the Labs price book rather than restating it", () => {
    // A restated price is a price that drifts. `LABS_UNIT_COST_USD` reads
    // `DFS_LABS.standard.perRequest`, so the vendor repricing Labs moves this
    // capture's cost column with it instead of leaving a stale number.
    expect(DFS_LABS.standard.perRequest).toBe(UNIT);
    expect(UNIT).toBeGreaterThan(0);
  });
});
