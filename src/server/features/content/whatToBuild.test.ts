import { describe, expect, it } from "vitest";
import { type BuildCandidate, whatToBuild } from "./whatToBuild";

/**
 * What to Build (CL-717): gaps ranked into a build list.
 *
 * The load-bearing properties, not the arithmetic: unmeasurable inputs are
 * listed as unpriced (never zero, never dropped silently); unknown intent
 * excluded formats (never defaults to guides for a buyer); the SERP winner
 * leads only inside the eligible set, trailing as evidence otherwise; ordering is score × volume × trend with ETV
 * breaking ties so equal ranks never depend on input order.
 */

function candidate(overrides: Partial<BuildCandidate> = {}): BuildCandidate {
  return {
    keyword: "example keyword",
    volume: 1000,
    keywordDifficulty: 20,
    serpCompetitors: 10,
    intent: "informational",
    aiNativeRatio: 0.5,
    rankElasticity: 0.5,
    trendFactor: 1,
    etv: 500,
    serpElements: [],
    competitorDomains: ["rival.com"],
    ...overrides,
  };
}

describe("whatToBuild", () => {
  it("ranks the better bet first with its formats and reason", () => {
    const { build, unpriced } = whatToBuild([
      candidate({ keyword: "hard", keywordDifficulty: 90 }),
      candidate({ keyword: "easy", keywordDifficulty: 5 }),
    ]);
    expect(unpriced).toEqual([]);
    expect(build.map((entry) => entry.keyword)).toEqual(["easy", "hard"]);
    expect(build[0]?.formats).toEqual(["guide", "tutorial", "faq"]);
    expect(build[0]?.reason).toMatch(/scores \d+/);
    expect(build[0]?.scoreVersion).toBe("1.0.0");
  });

  it("lists unmeasurable keywords as unpriced, never as zero and never dropped", () => {
    const { build, unpriced } = whatToBuild([
      candidate({ keyword: "no-volume", volume: null }),
      candidate({ keyword: "zero-volume", volume: 0 }),
      candidate({ keyword: "no-intent", intent: "unknown" }),
      candidate({ keyword: "ok" }),
    ]);
    expect(build.map((entry) => entry.keyword)).toEqual(["ok"]);
    expect(unpriced.map((entry) => entry.keyword)).toEqual([
      "no-volume",
      "zero-volume",
      "no-intent",
    ]);
    for (const entry of unpriced) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("leads with the SERP-element winner only inside the eligible set", () => {
    const { build } = whatToBuild([
      candidate({
        keyword: "guide SERP",
        serpElements: ["unknown-thing", "ai_overview"],
      }),
    ]);
    // ai_overview maps to guide, already first for informational intent —
    // and exactly once, never duplicated by the winner logic.
    expect(build[0]?.formats).toEqual(["guide", "tutorial", "faq"]);
    expect(build[0]?.reason).toMatch(/the SERP asks for guide/);
  });

  it("carries an ineligible SERP winner as evidence, never as a format", () => {
    // video is outside the informational trio: recommending it would advise
    // long-form buyers to shoot video. Formats stay eligible; the evidence
    // rides alongside, named as outside.
    const { build } = whatToBuild([
      candidate({
        keyword: "video SERP",
        serpElements: ["unknown-thing", "video"],
      }),
    ]);
    expect(build[0]?.formats).toEqual(["guide", "tutorial", "faq"]);
    expect(build[0]?.serpEvidence).toBe("video");
    expect(build[0]?.reason).toMatch(/outside informational formats/);
  });

  it("orders by volume and trend, with ETV breaking ties", () => {
    const big = candidate({ keyword: "big", volume: 100000 });
    const small = candidate({ keyword: "small", volume: 100 });
    expect(
      whatToBuild([small, big]).build.map((entry) => entry.keyword),
    ).toEqual(["big", "small"]);
    const rising = candidate({ keyword: "rising", trendFactor: 1.8 });
    const falling = candidate({ keyword: "falling", trendFactor: 0.4 });
    expect(
      whatToBuild([falling, rising]).build.map((entry) => entry.keyword),
    ).toEqual(["rising", "falling"]);
  });

  it("treats unknown trend as flat rather than excluding", () => {
    const { build, unpriced } = whatToBuild([
      candidate({ keyword: "no-trend", trendFactor: null }),
    ]);
    expect(unpriced).toEqual([]);
    expect(build[0]?.reason).toMatch(/no trend read/);
  });
});
