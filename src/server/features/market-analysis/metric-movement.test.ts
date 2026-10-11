/**
 * Movement, and the two cases where it must refuse to answer.
 *
 * The vendor returns its own difference block and does not pin its sign — the reference says
 * "subtracting the greater date from the smaller" without saying whether *greater* means later or
 * larger — and its sample contradicts itself. So this product computes direction from the two
 * months it asked about, and these tests hold that line: the arithmetic is the caller's, and a
 * movement that cannot be sourced to two readings is **null**, never a confident zero.
 */
import { describe, expect, it } from "vitest";
import { describeMetricsMovement } from "./metric-movement";

const months = {
  // The vendor's own sample: ETV rose from 147.22 in June to 308.87 in October.
  "202106": { organic: { etv: 147.2205658582747, count: 41 } },
  "202110": { organic: { etv: 308.8720009159297, count: 46 } },
};

describe("describeMetricsMovement", () => {
  it("computes growth as later minus earlier, whatever order the caller asked in", () => {
    const movement = describeMetricsMovement(months);
    expect(movement?.fromMonth).toBe("202106");
    expect(movement?.toMonth).toBe("202110");
    expect(movement?.etvChange).toBeCloseTo(161.65143505765496, 6);
    expect(movement?.growing).toBe(true);
  });

  it("sorts the months itself rather than trusting the key order", () => {
    // The API keys are an object, and nothing promises insertion order. Reading `Object.keys()[0]`
    // as "the first date" would silently reverse any comparison whose order differed.
    const reversed = {
      "202110": months["202110"],
      "202106": months["202106"],
    };
    expect(describeMetricsMovement(reversed)?.growing).toBe(true);
  });

  it("reports a decline as a decline", () => {
    const movement = describeMetricsMovement({
      "202106": { organic: { etv: 500 } },
      "202110": { organic: { etv: 200 } },
    });
    expect(movement?.etvChange).toBe(-300);
    expect(movement?.growing).toBe(false);
  });

  it("says nothing rather than guessing when a month has no ETV", () => {
    // `growing: null` and not `false`: "we have no reading" and "it fell" are different claims,
    // and a table that renders the second for the first invents a decline.
    const movement = describeMetricsMovement({
      "202106": { organic: { etv: 100 } },
      "202110": { organic: null },
    });
    expect(movement?.etvChange).toBeNull();
    expect(movement?.growing).toBeNull();
    expect(movement?.fromEtv).toBe(100);
  });

  it("refuses a movement it cannot source to two readings", () => {
    // One month is not a movement: printing a change from a single point would be arithmetic
    // dressed as evidence.
    expect(
      describeMetricsMovement({ "202106": { organic: { etv: 1 } } }),
    ).toBeNull();
    expect(describeMetricsMovement(null)).toBeNull();
    expect(describeMetricsMovement({})).toBeNull();
  });

  it("ignores keys that are not months", () => {
    const withNoise = {
      ...months,
      updated: { organic: { etv: 999 } },
    } as Record<string, { organic: { etv: number } }>;
    expect(describeMetricsMovement(withNoise)?.toMonth).toBe("202110");
  });

  // ------------------------------------------------- the 2026-11-01 ETV boundary

  /**
   * **The C6 gap, and the reason these cases are here rather than in `etv-versioning.test.ts`.**
   *
   * `domain_metrics_by_categories` takes two **caller-supplied** dates and returns a
   * `metrics_history` keyed by `YYYYMM`, so a caller can ask about `2026-10` and `2026-11`
   * — a window straddling the day the vendor switched ETV models. Across that boundary
   * `etvChange` is the difference between two formulas, not between two traffic figures,
   * and it is non-zero even for a site whose rankings never moved.
   *
   * Phase 1 closed every *chart* and forecast that plots ETV across the boundary. This is
   * the movement read in `market-tools`, which was not one of the surfaces that closed —
   * and it was reachable from a tool whose text said "grew between them", which is the
   * claim the boundary invalidates.
   */
  describe("a window straddling 2026-11-01", () => {
    it("refuses to report a direction, because two formulas apart there is none", () => {
      // **The negative control's mirror.** Before the fix this returned `growing: true`, so
      // a tool would have said a domain "grew" on the strength of a model change.
      const straddling = describeMetricsMovement({
        "202610": { organic: { etv: 100 } },
        "202611": { organic: { etv: 260 } },
      });

      expect(straddling?.spansCutover).toBe(true);
      // **The raw change is still reported**, because witholding it would be a different
      // lie: a caller can see the number AND that it is not comparable, which is a better
      // answer than hiding either half.
      expect(straddling?.etvChange).toBe(160);
      expect(straddling?.growing).toBeNull();
    });

    it("still reports direction on the far side of the cutover", () => {
      // Both months on the new model: a normal comparison. Without this, a boundary check
      // that flagged everything would pass the case above by never reporting growth at all.
      const after = describeMetricsMovement({
        "202611": { organic: { etv: 100 } },
        "202612": { organic: { etv: 120 } },
      });

      expect(after?.spansCutover).toBe(false);
      expect(after?.growing).toBe(true);
    });

    it("still reports direction entirely before the cutover", () => {
      const before = describeMetricsMovement({
        "202601": { organic: { etv: 100 } },
        "202602": { organic: { etv: 80 } },
      });

      expect(before?.spansCutover).toBe(false);
      expect(before?.growing).toBe(false);
    });
  });
});
