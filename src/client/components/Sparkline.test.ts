import { describe, expect, it } from "vitest";
import { sparklinePath, sparklineValues } from "./Sparkline";

const point = (year: number, month: number, searchVolume: number) => ({
  year,
  month,
  searchVolume,
});

describe("the sparkline's geometry", () => {
  it("orders a series by date and keeps the last twelve months", () => {
    const points = [
      point(2026, 3, 30),
      // Out of order on purpose, and 2025-12 sorts *after* 2026-1 as text — the
      // same zero-padding trap the archive's month key exists to avoid.
      point(2025, 12, 10),
      point(2026, 1, 20),
    ];
    expect(sparklineValues(points)).toEqual([10, 20, 30]);

    const many = Array.from({ length: 20 }, (_, i) =>
      point(2025, (i % 12) + 1, i),
    );
    expect(sparklineValues(many)).toHaveLength(12);
  });

  it("refuses to draw a trend from one reading", () => {
    // A line through a single point asserts a direction nobody measured.
    expect(sparklinePath([], 72, 20)).toBeNull();
    expect(sparklinePath([42], 72, 20)).toBeNull();
  });

  it("puts the largest value at the top, not the bottom", () => {
    // The inverted mapping is the classic bug here: peaks pointing down read as a
    // collapse, which is the same defect as a missing month drawn at zero.
    const path = sparklinePath([0, 10], 72, 20, 2);
    expect(path).toBe("M0.00 18.00 L72.00 2.00");
  });

  it("draws a flat series level, rather than dividing by a zero span", () => {
    expect(sparklinePath([5, 5, 5], 20, 20, 2)).toBe(
      "M0.00 10.00 L10.00 10.00 L20.00 10.00",
    );
  });

  it("emits one segment per point, at even spacing", () => {
    const path = sparklinePath([1, 2, 3, 4], 30, 20, 0) ?? "";
    expect(path.match(/[ML]/g)).toHaveLength(4);
    expect(path).toContain("M0.00");
    expect(path).toContain("L30.00");
  });
});
