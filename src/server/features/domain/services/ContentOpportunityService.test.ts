import { describe, expect, it } from "vitest";
import { ContentOpportunityService } from "./ContentOpportunityService";

/**
 * The decision layer, reachable.
 *
 * ## Why this file exists
 *
 * This is the fourth appearance of the same failure. The evidence drawer, the
 * forecast, and the ETV chart were each built correctly through every layer and
 * then dropped at one call site — and in each case every individual component
 * passed its own tests, because the missing fact was about the *join*. The
 * forecast shipped as a writer nothing read, and CL-503 reverted it whole.
 *
 * So this file asserts the reachability claim *and* the ranking behaviour, and the
 * ranking assertions are the same ones `opportunityRanking.test.ts` makes —
 * repeated here deliberately, because a service that bypasses its own model and
 * invents a score is the failure, and a pure-model test cannot see that.
 */

const projectId = "p1";
const US = 2840;

/** One measurement row, in the repository's shape. */
const row = (
  keyword: string,
  difficulty: number,
  locationCode = US,
): {
  keyword: string;
  locationCode: number;
  keywordDifficulty: number | null;
  serpCompetitors: number | null;
  intent: string | null;
  aiNativeRatioBp: number | null;
  rankElasticityBp: number | null;
} => ({
  keyword,
  locationCode,
  keywordDifficulty: difficulty,
  serpCompetitors: 100,
  intent: "commercial",
  aiNativeRatioBp: 3000,
  rankElasticityBp: 5000,
});

/**
 * Newest-first, per keyword — the order `listRecentByProject` documents and the
 * service depends on. A repository that returned oldest-first would make every
 * score a stale reading while the band described the archive.
 */
const rows = [
  row("volatile", 90),
  row("volatile", 10),
  row("reliable", 51),
  row("reliable", 49),
  row("reliable", 50),
];

describe("ContentOpportunityService", () => {
  it("ranks a project's keywords with a band on each", async () => {
    const ranking = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => rows,
    });

    // The reachability claim: the service returns a ranking with items. This is
    // the assertion whose absence made the forecast a dead component.
    expect(ranking.items.length).toBeGreaterThan(0);
    // ...and each one carries a band, because a rank without one is the thing this
    // whole phase exists to prevent.
    for (const item of ranking.items) {
      expect(item.band.high).toBeGreaterThanOrEqual(item.band.low);
      expect(item.measurements).toBeGreaterThan(0);
    }
  });

  it("scores the newest measurement, not the average", async () => {
    // The repository is newest-first, so the first row of each group is the
    // latest reading — the one the score reports. The rest set the band. An
    // average would blend a stale measurement into the current one, which is the
    // confusion the score's own contribution display exists to avoid.
    const volatileRows = rows.filter((r) => r.keyword === "volatile");
    expect(volatileRows[0]?.keywordDifficulty).toBe(90);
    expect(volatileRows[volatileRows.length - 1]?.keywordDifficulty).toBe(10);

    const ranking = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => volatileRows,
    });

    // A difficulty of 90 must outscore a difficulty of 10, and the score must
    // match the newest reading rather than the mean of the two. The mean would
    // land between them, so the pair of assertions below pins it to the newest.
    const scoreFrom90 = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => [row("volatile", 90)],
    }).then((r) => r.items[0]?.score ?? 0);
    const scoreFrom10 = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => [row("volatile", 10)],
    }).then((r) => r.items[0]?.score ?? 0);

    expect(ranking.items[0]?.score).toBeCloseTo(scoreFrom90, 5);
    expect(ranking.items[0]?.score).not.toBeCloseTo(scoreFrom10, 2);
    // And the archive still sets the band: the two readings disagree, so the band
    // is wider than a single-measurement floor would be.
    expect(
      (ranking.items[0]?.band.high ?? 0) - (ranking.items[0]?.band.low ?? 0),
    ).toBeGreaterThan(0);
  });

  it("refuses to rank a keyword with no measurements", async () => {
    const ranking = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => [],
    });

    expect(ranking.items).toEqual([]);
  });

  it("ranks by the band's low end, so the reliable keyword leads", async () => {
    // The decision-layer property, restated at the service level: a list ranked
    // by best case is a list that flatters. "volatile" scores 90 on its newest
    // reading but swings to 10; "reliable" holds near 50.
    const ranking = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => rows,
    });

    expect(ranking.items[0]?.keyword).toBe("reliable");
  });

  it("keeps two markets for one keyword as two ranked items", async () => {
    // The market is part of the identity. Averaging US and Spain difficulty would
    // report a value the vendor never published, so the two are ranked apart.
    const ranking = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => [
        row("hiking boots", 20, US),
        row("hiking boots", 80, 2724),
      ],
    });

    // Two items, both showing the bare keyword, ranked independently.
    expect(ranking.items).toHaveLength(2);
    expect(
      ranking.items.map((item: { keyword: string }) => item.keyword),
    ).toEqual(["hiking boots", "hiking boots"]);
  });

  it("carries a version, so a model change is visible in the output", async () => {
    // The stamping rule every other score in the product follows: an unversioned
    // rank is a rank nobody can audit after the weights move.
    const ranking = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => rows,
    });

    expect(ranking.version).toBe("1.0.0");
  });

  it("does not read the repository when rows are injected", async () => {
    // A service that silently falls back to the database makes the injection seam
    // decorative, and a test would pass against production data.
    // **The seam is proven by using it, not by spying past it.** `vi.spyOn` cannot
    // target a method added to the repository's object literal, and a spy that
    // cannot attach is a test proving nothing about the fallback. So the assertion
    // is that the injected rows are the ones ranked — which is only true if the
    // service used them rather than reaching the database.
    let injectedCalls = 0;
    const ranking = await ContentOpportunityService.rankForProject({
      projectId,
      injectRows: async () => {
        injectedCalls += 1;
        return rows;
      },
    });

    expect(injectedCalls).toBe(1);
    expect(
      ranking.items.map((item: { keyword: string }) => item.keyword),
    ).toEqual(["reliable", "volatile"]);
  });
});
