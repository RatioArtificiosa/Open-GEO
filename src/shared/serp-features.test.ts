import { describe, expect, it } from "vitest";
import {
  AI_OVERVIEW_FEATURE,
  hasAiOverview,
  parseSerpFeatures,
} from "@/shared/serp-features";

describe("parseSerpFeatures", () => {
  it("decodes a stored array", () => {
    expect(parseSerpFeatures('["organic","ai_overview"]')).toEqual([
      "organic",
      "ai_overview",
    ]);
  });

  it("keeps `null` as `null` rather than collapsing it to `[]`", () => {
    // **The reason this module exists.** `[]` is "checked, no features present" and
    // `null` is "no record for this check" — and the AI Overview tie-in reads absence
    // as "you were not cited", so collapsing them reports a legacy row as a confident
    // negative instead of a gap.
    expect(parseSerpFeatures(null)).toBeNull();
    expect(parseSerpFeatures("[]")).toEqual([]);
    expect(parseSerpFeatures(null)).not.toEqual(parseSerpFeatures("[]"));
  });

  it("treats an unreadable payload as unreadable, not as 'no features'", () => {
    // Same reasoning as `null`: a row we cannot parse is a gap, and a gap must not
    // read as a real answer.
    expect(parseSerpFeatures("{not json")).toBeNull();
    expect(parseSerpFeatures('{"organic":true}')).toBeNull();
  });

  it("drops non-string entries instead of leaking them into the union", () => {
    expect(parseSerpFeatures('["organic",7,null,"ai_overview",{}]')).toEqual([
      "organic",
      "ai_overview",
    ]);
  });
});

describe("hasAiOverview", () => {
  it("answers the presence question for a recorded list", () => {
    expect(hasAiOverview(["organic", AI_OVERVIEW_FEATURE])).toBe(true);
    expect(hasAiOverview(["organic", "people_also_ask"])).toBe(false);
  });

  it("cannot say yes from no record", () => {
    // `null` and `undefined` are the "we do not know" states, and neither supports a
    // yes. A caller that needs to show "not recorded" separately must test for null.
    expect(hasAiOverview(null)).toBe(false);
    expect(hasAiOverview(undefined)).toBe(false);
    expect(hasAiOverview([])).toBe(false);
  });
});
