/**
 * The two rulers, and the null that is an answer rather than an absence.
 *
 * This endpoint returns two normalised blocks that look identical and answer opposite questions:
 * one shares a keyword's own buckets against its own peak, the other shares the requested keywords
 * within each bucket. A surface that mixed them would produce a confident comparison that means
 * nothing, which is why the reader names them separately and the tests assert the difference.
 */
import { describe, expect, it } from "vitest";
import { readDemographyComparison, readKeywordDemography } from "./demography";

/** The vendor's own sample, abbreviated to two keywords and two buckets each. */
const item = {
  keywords: ["rugby", "cricket"],
  demography: {
    age: [
      {
        keyword: "rugby",
        values: [
          { type: "45-54", value: 100 },
          { type: "55-64", value: 49 },
          { type: "18-24", value: 0 },
        ],
      },
      {
        keyword: "cricket",
        values: [
          { type: "35-44", value: 100 },
          { type: "18-24", value: 42 },
        ],
      },
    ],
    gender: [{ keyword: "rugby", values: [{ type: "male", value: 100 }] }],
  },
  demography_comparison: {
    age: { "18-24": [30, 70], "45-54": [25, 75] },
    gender: { female: [20, 80] },
  },
};

describe("readKeywordDemography", () => {
  it("keeps each keyword's own peak as 100, which is how the vendor normalises it", () => {
    const [rugby, cricket] = readKeywordDemography(item);
    expect(rugby?.keyword).toBe("rugby");
    expect(rugby?.age[0]).toEqual({ bucket: "45-54", value: 100 });
    // Both keywords peak at 100 in different buckets: these are two rulers, not one.
    expect(cricket?.age[0]).toEqual({ bucket: "35-44", value: 100 });
  });

  it("maps the vendor's 0 to null, as everywhere else in this family", () => {
    const [rugby] = readKeywordDemography(item);
    expect(rugby?.age[2]).toEqual({ bucket: "18-24", value: null });
  });

  it("gives a keyword with no gender block an empty list rather than dropping it", () => {
    const [rugby, cricket] = readKeywordDemography(item);
    expect(rugby?.gender).toHaveLength(1);
    expect(cricket?.gender).toEqual([]);
    expect(cricket?.keyword).toBe("cricket");
  });
});

describe("readDemographyComparison", () => {
  it("reads the cross-keyword shares, aligned to the request's order", () => {
    const comparison = readDemographyComparison(item);
    expect(comparison?.age["18-24"]).toEqual([30, 70]);
    expect(comparison?.gender.female).toEqual([20, 80]);
  });

  it("returns null for a single keyword, which is what the vendor sends", () => {
    // An empty object would render as "no data" and blame the index for a comparison that was
    // never asked for.
    expect(
      readDemographyComparison({
        keywords: ["rugby"],
        demography_comparison: null,
      }),
    ).toBeNull();
  });

  it("applies the 0 rule to the comparison too", () => {
    const comparison = readDemographyComparison({
      demography_comparison: { age: { "18-24": [0, 100] }, gender: {} },
    });
    expect(comparison?.age["18-24"]).toEqual([null, 100]);
  });
});
