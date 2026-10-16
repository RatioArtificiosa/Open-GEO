import { describe, expect, it } from "vitest";
import { gradeContent, READABILITY_DIRECTIONS } from "./contentGrade";

/**
 * Content quality grading (CL-719).
 *
 * The load-bearing properties: the score is the vendor's `onpage_score`
 * passed through (never a sibling field, never computed); the five indices
 * are shown individually with their directions (never blended — there is no
 * blended field to assert on, which is the point); density is a displayed
 * ratio, not a grade; checks are counts, not booleans; absent inputs are
 * omitted or null, never zero.
 */

describe("gradeContent", () => {
  it("passes the onpage score through with its provenance", () => {
    const grade = gradeContent({
      onpageScore: 88,
      readability: {},
      keywordDensityRatio: null,
      checksPassed: null,
      checksTotal: null,
    });
    expect(grade.score).toBe(88);
    expect(grade.scoreSource).toBe("onpage_score");
    expect(grade.indices).toEqual([]);
    expect(grade.densityPercent).toBeNull();
    expect(grade.checkCoverage).toBeNull();
  });

  it("reads each index with its direction, omitting the absent", () => {
    const grade = gradeContent({
      onpageScore: 70,
      readability: { fleschKincaid: 62.4, smog: 9.1 },
      keywordDensityRatio: null,
      checksPassed: null,
      checksTotal: null,
    });
    expect(grade.indices).toEqual([
      {
        name: "fleschKincaid",
        label: "Flesch–Kincaid",
        value: 62.4,
        higherMeans: "easier",
      },
      { name: "smog", label: "SMOG", value: 9.1, higherMeans: "harder" },
    ]);
  });

  it("states all five directions without blending them", () => {
    expect(Object.keys(READABILITY_DIRECTIONS)).toHaveLength(5);
    expect(READABILITY_DIRECTIONS.fleschKincaid?.higherMeans).toBe("easier");
    for (const name of ["ari", "colemanLiau", "daleChall", "smog"] as const) {
      expect(READABILITY_DIRECTIONS[name]?.higherMeans).toBe("harder");
    }
  });

  it("displays density as a ratio percent, never as a grade", () => {
    const grade = gradeContent({
      onpageScore: 70,
      readability: {},
      keywordDensityRatio: 0.0237,
      checksPassed: 12,
      checksTotal: 40,
    });
    expect(grade.densityPercent).toBe(2.37);
    expect(grade.densityNote).toMatch(/not a grade/);
    expect(grade.checkCoverage).toBe("12/40 checks passed");
  });
});
