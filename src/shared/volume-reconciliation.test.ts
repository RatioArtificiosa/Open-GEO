import { describe, expect, it } from "vitest";
import {
  CORROBORATION_BAND,
  reconcileVolume,
  summariseReconciliation,
} from "@/shared/volume-reconciliation";

const US = "US";

function reconcile(overrides: {
  referenceVolume: number | null;
  countryVolume?: number | null;
  globalVolume?: number | null;
  countryIsoCode?: string;
}) {
  return reconcileVolume({
    keyword: "plumber",
    referenceVolume: overrides.referenceVolume,
    globalVolume: overrides.globalVolume ?? 1_000_000,
    countryDistribution:
      overrides.countryVolume === undefined
        ? []
        : [{ countryIsoCode: "US", searchVolume: overrides.countryVolume }],
    countryIsoCode: overrides.countryIsoCode ?? US,
  });
}

describe("the verdict", () => {
  it("corroborates two figures inside the band", () => {
    const result = reconcile({ referenceVolume: 1_000, countryVolume: 1_100 });
    expect(result.verdict).toBe("corroborated");
    expect(result.ratio).toBeCloseTo(1.1, 5);
  });

  it("reports a measured figure above the band as higher, and says why", () => {
    const result = reconcile({ referenceVolume: 1_000, countryVolume: 2_000 });
    expect(result.verdict).toBe("measured-higher");
    expect(result.note).toMatch(/grouped this keyword with others/);
  });

  it("reports a measured figure below the band as lower, and says why", () => {
    const result = reconcile({ referenceVolume: 1_000, countryVolume: 500 });
    expect(result.verdict).toBe("measured-lower");
    expect(result.note).toMatch(/inherited from a cluster/);
  });

  it("treats the band as inclusive on both edges", () => {
    // The boundary is a stated rule, so it is pinned: exactly ±25% still counts as
    // agreement, and one unit past it does not.
    expect(
      reconcile({ referenceVolume: 1_000, countryVolume: 1_250 }).verdict,
    ).toBe("corroborated");
    expect(
      reconcile({ referenceVolume: 1_000, countryVolume: 1_251 }).verdict,
    ).toBe("measured-higher");
    expect(
      reconcile({ referenceVolume: 1_000, countryVolume: 750 }).verdict,
    ).toBe("corroborated");
    expect(
      reconcile({ referenceVolume: 1_000, countryVolume: 749 }).verdict,
    ).toBe("measured-lower");
    expect(CORROBORATION_BAND).toBe(0.25);
  });
});

describe("the global figure never decides the verdict", () => {
  it("corroborates on the country figure while the global one is enormous", () => {
    // **The trap this module exists to close.** The clickstream endpoint is global and
    // everything we show is national, so a view that compared the top-level number would
    // declare a 1,000x discrepancy on every keyword and be wrong every time.
    const result = reconcile({
      referenceVolume: 1_000,
      countryVolume: 1_050,
      globalVolume: 976_222_640,
    });
    expect(result.verdict).toBe("corroborated");
    // The global figure is still carried, as context for the reader.
    expect(result.globalVolume).toBe(976_222_640);
  });

  it("is uncomparable when the breakdown has no entry for the market", () => {
    const result = reconcile({
      referenceVolume: 1_000,
      countryVolume: undefined,
      globalVolume: 976_222_640,
    });
    expect(result.verdict).toBe("uncomparable");
    expect(result.countryVolume).toBeNull();
    // The note names the market, so a reader is not left guessing which one is missing.
    expect(result.note).toMatch(/no figure for US/);
    expect(result.note).toMatch(/global figure is context only/);
  });

  it("matches the country case-insensitively", () => {
    const result = reconcile({
      referenceVolume: 1_000,
      countryVolume: 1_000,
      countryIsoCode: "us",
    });
    expect(result.verdict).toBe("corroborated");
  });
});

describe("edges that would otherwise invent a finding", () => {
  it("is uncomparable when nothing is stored for the keyword", () => {
    const result = reconcile({ referenceVolume: null, countryVolume: 900 });
    expect(result.verdict).toBe("uncomparable");
    expect(result.ratio).toBeNull();
  });

  it("calls zero against zero agreement", () => {
    const result = reconcile({ referenceVolume: 0, countryVolume: 0 });
    expect(result.verdict).toBe("corroborated");
    expect(result.ratio).toBeNull();
  });

  it("flags a keyword we show as zero but that is measurably searched", () => {
    // The most actionable row this view can produce: the keyword is being written off.
    const result = reconcile({ referenceVolume: 0, countryVolume: 5_000 });
    expect(result.verdict).toBe("measured-higher");
    expect(result.note).toMatch(/being written off/);
  });
});

describe("summariseReconciliation", () => {
  const rows = [
    reconcile({ referenceVolume: 1_000, countryVolume: 1_000 }),
    reconcile({ referenceVolume: 1_000, countryVolume: 1_000 }),
    reconcile({ referenceVolume: 1_000, countryVolume: 3_000 }),
    reconcile({ referenceVolume: 1_000, countryVolume: 200 }),
    reconcile({ referenceVolume: 1_000, countryVolume: undefined }),
  ];

  it("counts each verdict", () => {
    expect(summariseReconciliation(rows)).toEqual({
      total: 5,
      corroborated: 2,
      measuredHigher: 1,
      measuredLower: 1,
      uncomparable: 1,
      corroborationRate: 0.5,
    });
  });

  it("rates agreement over comparable rows only, and reports the rest separately", () => {
    // Counting the uncomparable row as agreement would flatter the number; counting it as
    // disagreement would invent a finding. It is excluded, and the reader can see it.
    expect(summariseReconciliation(rows).corroborationRate).toBe(0.5);
  });

  it("reports no rate at all when nothing was comparable", () => {
    const nothing = [
      reconcile({ referenceVolume: 1_000, countryVolume: undefined }),
    ];
    expect(summariseReconciliation(nothing).corroborationRate).toBeNull();
  });

  it("reports no rate for an empty set rather than dividing by zero", () => {
    expect(summariseReconciliation([]).corroborationRate).toBeNull();
    expect(summariseReconciliation([]).total).toBe(0);
  });
});
