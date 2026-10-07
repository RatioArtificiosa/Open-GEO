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
});
