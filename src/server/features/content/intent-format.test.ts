import { describe, expect, it } from "vitest";
import {
  formatForElement,
  formatsForIntent,
  INTENT_FORMAT_RULES,
  SERP_ELEMENT_FORMAT_RULES,
} from "./intent-format";

/**
 * The intent→format and SERP-element→format tables (CL-718).
 *
 * Sofia's table shipped verbatim as data. The load-bearing property is
 * completeness with no fallback: an intent or element outside the table must
 * refuse rather than guess, because a guessed format is advice nobody gave.
 * Every row is asserted so a changed table is a failed test, not silent drift.
 */

describe("formatsForIntent", () => {
  it("returns Sofia's trio per intent, as copies", () => {
    expect(formatsForIntent("informational")).toEqual([
      "guide",
      "tutorial",
      "faq",
    ]);
    expect(formatsForIntent("commercial")).toEqual([
      "comparison",
      "review",
      "alternatives",
    ]);
    expect(formatsForIntent("transactional")).toEqual([
      "product",
      "service",
      "landing",
    ]);
    expect(formatsForIntent("navigational")).toEqual(["brand", "product"]);
  });

  it("refuses unknown intent instead of defaulting to guides", () => {
    expect(formatsForIntent("unknown")).toBeNull();
  });

  it("hands out copies, so a caller cannot rewrite advice for everyone", () => {
    const first = formatsForIntent("informational");
    first?.push("video");
    expect(formatsForIntent("informational")).toEqual([
      "guide",
      "tutorial",
      "faq",
    ]);
  });

  it("covers exactly the four documented intents", () => {
    // Insertion order: string keys keep it, so no sorting is needed to
    // compare (and `.sort()` is banned here for mutating).
    expect(Object.keys(INTENT_FORMAT_RULES)).toEqual([
      "informational",
      "commercial",
      "transactional",
      "navigational",
    ]);
  });
});

describe("formatForElement", () => {
  it("maps each recognized element to its format", () => {
    expect(formatForElement("video")).toBe("video");
    expect(formatForElement("people_also_ask")).toBe("qa-section");
    expect(formatForElement("images")).toBe("originals");
    expect(formatForElement("featured_snippet")).toBe("concise-answer");
    expect(formatForElement("ai_overview")).toBe("guide");
  });

  it("refuses unrecognized elements instead of guessing", () => {
    expect(formatForElement("knowledge_graph")).toBeNull();
    expect(formatForElement("")).toBeNull();
  });

  it("covers exactly the five documented elements", () => {
    expect(Object.keys(SERP_ELEMENT_FORMAT_RULES)).toEqual([
      "video",
      "people_also_ask",
      "images",
      "featured_snippet",
      "ai_overview",
    ]);
  });
});
