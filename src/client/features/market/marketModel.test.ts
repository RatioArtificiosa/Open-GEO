/**
 * The label rule and the ordering rule, which are the two things this screen decides.
 *
 * Both are about the same hazard: a table that looks complete. An unnamed category that is
 * dropped, or a row with no measurement that sorts as if it were zero, produces a tidier profile
 * than the data supports — and neither failure is visible to someone reading the page.
 */
import { describe, expect, it } from "vitest";
import { lastSegment, summariseMarket, toMarketRows } from "./marketModel";

const named = (
  names: Array<string | null>,
  organicEtv: number | null,
  extra: Partial<{ organicCount: number | null; paidEtv: number | null }> = {},
) => ({
  criterionIds: names.map((_, index) => 10000 + index),
  names,
  organicCount: null,
  organicEtv,
  paidCount: null,
  paidEtv: null,
  ...extra,
});

describe("toMarketRows", () => {
  it("sorts by organic ETV, biggest first", () => {
    const rows = toMarketRows([
      named(["/Apparel"], 100),
      named(["/Computers/Software"], 900),
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Software", "Apparel"]);
  });

  it("puts an unmeasured category last, not at zero", () => {
    // A profile's biggest category must never be one nobody measured.
    const rows = toMarketRows([
      named(["/Apparel"], null),
      named(["/Computers/Software"], 1),
    ]);
    expect(rows[0]?.label).toBe("Software");
    expect(rows[1]?.label).toBe("Apparel");
  });

  it("labels an unnamed category by the state it is in, not with a guess", () => {
    const rows = toMarketRows([
      { ...named([null], 10), criterionIds: [99999] },
    ]);
    expect(rows[0]?.label).toBe("Unnamed category (99999)");
    expect(rows[0]?.fullPath).toBeNull();
    expect(rows[0]?.unnamed).toBe(true);
  });

  it("uses the last path segment as the label and keeps the whole path", () => {
    const rows = toMarketRows([
      named(["/Apparel/Apparel Accessories/Bags & Packs"], 5),
    ]);
    expect(rows[0]?.label).toBe("Bags & Packs");
    expect(rows[0]?.fullPath).toBe("/Apparel/Apparel Accessories/Bags & Packs");
  });

  it("flags a row whose second criterion is unnamed even when the first is not", () => {
    // The vendor can put several criteria on one row, and one of them missing a name still means
    // the row is incompletely labelled.
    const rows = toMarketRows([named(["/Apparel", null], 5)]);
    expect(rows[0]?.label).toBe("Apparel");
    expect(rows[0]?.unnamed).toBe(true);
  });
});

describe("summariseMarket", () => {
  it("counts only the rows that report traffic", () => {
    const summary = summariseMarket(
      toMarketRows([
        named(["/Apparel"], 100),
        named(["/Computers"], 300),
        named(["/Unmeasured"], null),
      ]),
    );
    expect(summary.categoryCount).toBe(3);
    expect(summary.topLabel).toBe("Computers");
    expect(summary.totalOrganicEtv).toBe(400);
  });

  it("says nothing about a top category when nothing was measured", () => {
    const summary = summariseMarket(toMarketRows([named(["/Apparel"], null)]));
    expect(summary.topLabel).toBeNull();
    expect(summary.totalOrganicEtv).toBe(0);
  });
});

describe("lastSegment", () => {
  it("handles a trailing slash and a single-segment path", () => {
    expect(lastSegment("/Apparel/")).toBe("Apparel");
    expect(lastSegment("/Apparel")).toBe("Apparel");
  });
});
