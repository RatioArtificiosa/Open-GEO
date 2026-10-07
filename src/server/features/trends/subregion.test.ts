/**
 * Three rulers, and the null that is an answer.
 *
 * The failure this guards against is subtle and looks fine: every keyword's strongest location
 * scores 100, so a table that treated the per-keyword block as cross-location data would show a
 * dozen strongholds per keyword and none of them would be comparable. The tests name each block.
 */
import { describe, expect, it } from "vitest";
import { readSubregionComparison, readSubregionInterests } from "./subregion";

const item = {
  keywords: ["rugby", "cricket"],
  interests: [
    {
      keyword: "rugby",
      values: [
        { geo_name: "New Hampshire", value: 100 },
        { geo_name: "Alaska", value: 0 },
      ],
    },
    {
      keyword: "cricket",
      values: [
        { geo_name: "North Dakota", value: 100 },
        { geo_name: "Alaska", value: 22 },
      ],
    },
  ],
  interests_comparison: {
    items: [{ geo_name: "Alabama", values: [23, 77] }],
    absolute_items: [{ geo_name: "Alabama", values: [10, 33] }],
  },
};

describe("readSubregionInterests", () => {
  it("keeps each keyword's own strongest location as its 100", () => {
    const [rugby, cricket] = readSubregionInterests(item);
    expect(rugby?.locations[0]).toEqual({ geo: "New Hampshire", value: 100 });
    // Two keywords, two different peaks. Reading these as one scale would invent a comparison.
    expect(cricket?.locations[0]).toEqual({ geo: "North Dakota", value: 100 });
  });

  it("maps the vendor's 0 to null, as everywhere in this family", () => {
    const [rugby] = readSubregionInterests(item);
    expect(rugby?.locations[1]).toEqual({ geo: "Alaska", value: null });
  });

  it("keys on geo_name, because the vendor's own sample sends a null geo_id", () => {
    const [rugby] = readSubregionInterests(item);
    expect(rugby?.locations.map((row) => row.geo)).toEqual([
      "New Hampshire",
      "Alaska",
    ]);
  });
});

describe("readSubregionComparison", () => {
  it("keeps the two comparison blocks apart", () => {
    const comparison = readSubregionComparison(item);
    expect(comparison?.withinLocation[0]?.values).toEqual([23, 77]);
    // The same location, on the only ruler that crosses locations.
    expect(comparison?.acrossAllLocations[0]?.values).toEqual([10, 33]);
  });

  it("returns null for a single keyword, which is what the vendor sends", () => {
    expect(
      readSubregionComparison({
        keywords: ["rugby"],
        interests_comparison: null,
      }),
    ).toBeNull();
  });

  it("applies the 0 rule to both comparison blocks", () => {
    const comparison = readSubregionComparison({
      interests_comparison: {
        items: [{ geo_name: "Alaska", values: [0, 100] }],
        absolute_items: [],
      },
    });
    expect(comparison?.withinLocation[0]?.values).toEqual([null, 100]);
    expect(comparison?.acrossAllLocations).toEqual([]);
  });
});
