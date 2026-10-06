import { describe, expect, it } from "vitest";
import {
  formatVolume,
  reconciliationHeadline,
  verdictBadge,
} from "./volumeHonestyModel";

describe("verdictBadge", () => {
  it("describes every verdict the rule can produce", () => {
    expect(verdictBadge("corroborated").label).toBe("Corroborated");
    expect(verdictBadge("measured-higher").label).toBe("Measured higher");
    expect(verdictBadge("measured-lower").label).toBe("Measured lower");
    expect(verdictBadge("uncomparable").label).toBe("Not checked");
  });

  it("tones a disagreement as a warning rather than an error", () => {
    // Nothing is broken: a grouped estimate is how Google Ads reports volume. An error tone
    // would send a reader to fix a number that is simply an estimate.
    expect(verdictBadge("measured-higher").tone).toBe("warn");
    expect(verdictBadge("measured-lower").tone).toBe("warn");
    expect(verdictBadge("corroborated").tone).toBe("ok");
  });

  it("renders an unknown verdict as unchecked rather than dressing it up", () => {
    // A verdict this panel has not been taught about must not read as a result.
    expect(verdictBadge("something-new")).toEqual(verdictBadge("uncomparable"));
  });
});

describe("formatVolume", () => {
  it("separates thousands and keeps zero as a real number", () => {
    expect(formatVolume(1_050)).toBe("1,050");
    expect(formatVolume(0)).toBe("0");
  });

  it("uses a dash when there is no figure", () => {
    expect(formatVolume(null)).toBe("—");
  });
});

describe("reconciliationHeadline", () => {
  it("leads with the share of comparable keywords that agreed", () => {
    expect(
      reconciliationHeadline({
        total: 10,
        corroborated: 4,
        uncomparable: 2,
        corroborationRate: 0.5,
      }),
    ).toBe(
      "4 of 8 comparable keywords (50%) have a volume the measured data supports.",
    );
  });

  it("says nothing was checkable rather than reporting a zero rate", () => {
    // "0% agreed" and "nothing could be checked" are different statements, and the second is
    // the one that is true when every row was missing a figure.
    expect(
      reconciliationHeadline({
        total: 3,
        corroborated: 0,
        uncomparable: 3,
        corroborationRate: null,
      }),
    ).toBe(
      "No volume could be checked: every keyword was missing a figure on one side.",
    );
  });

  it("handles a single comparable keyword without pluralising it", () => {
    expect(
      reconciliationHeadline({
        total: 1,
        corroborated: 1,
        uncomparable: 0,
        corroborationRate: 1,
      }),
    ).toBe(
      "1 of 1 comparable keyword (100%) have a volume the measured data supports.",
    );
  });
});
