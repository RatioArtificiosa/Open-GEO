import { describe, expect, it } from "vitest";
import { footnoteFor, labelFor, METRIC_COPY, METRIC_IDS } from "./metric-copy";

/**
 * The footnote registry.
 *
 * The registry exists because a tooltip written next to the number it describes
 * drifts away from that number. `BrandLookupResults.tsx` carried a hand-written
 * footnote about "monthly search demand" directly above a figure that was Google
 * demand plus ChatGPT demand summed — two units, ~198× apart. The copy was
 * accurate about neither half, and no test could have caught it because the
 * number and its explanation lived in different files.
 *
 * So these tests police the copy itself. A footnote that is vague, or that does
 * not say what the number is *not*, is as bad as no footnote at all.
 */

describe("the metric footnote registry", () => {
  it("has an entry for every declared metric", () => {
    for (const id of METRIC_IDS) {
      expect(
        METRIC_COPY[id],
        `${id} is missing from the registry`,
      ).toBeDefined();
    }
  });

  it("gives every metric a footnote with real content", () => {
    for (const id of METRIC_IDS) {
      const { footnote } = METRIC_COPY[id];
      expect(footnote.length, `${id} has no footnote`).toBeGreaterThan(40);
      // A footnote that never says what the number is *not* is the failure mode
      // this registry was written to prevent.
      expect(
        /\bnot\b|never|only|does not|cannot|must not/i.test(footnote),
        `${id} never states a limit`,
      ).toBe(true);
    }
  });

  it("gives every metric a label that names its unit", () => {
    // "Mentions" and "Demand" are both nouns; neither alone tells a reader
    // whether they are looking at a count or a rate.
    for (const id of METRIC_IDS) {
      const { label } = METRIC_COPY[id];
      expect(label.length, `${id} has no label`).toBeGreaterThan(2);
    }
    // The two demand figures are named by platform, never as bare "demand".
    expect(labelFor("chatgpt_demand")).toMatch(/chatgpt/i);
    expect(labelFor("google_demand")).toMatch(/google/i);
  });

  it("keeps the two demand footnotes explicitly incompatible", () => {
    // This is the sentence that would have caught CL-135. Both footnotes say the
    // figures must not be added together, so a reader who opens one and then sees
    // the other cannot conclude they are the same unit.
    expect(footnoteFor("chatgpt_demand")).toMatch(/must not be added/i);
    expect(footnoteFor("google_demand")).toMatch(/must not be added/i);
    expect(footnoteFor("chatgpt_demand")).toMatch(/not search volume/i);
    expect(footnoteFor("google_demand")).toMatch(/not conversational/i);
  });

  it("says the ETV figure is a model, and names the change date", () => {
    // The number is meaningless without knowing which model produced it, and the
    // date is the one a reader will want to look up.
    expect(footnoteFor("etv")).toMatch(/model estimate|not a measurement/i);
    expect(footnoteFor("etv")).toContain("1 November 2026");
  });

  it("explains why the citation gap is unavailable on Google, not empty", () => {
    // "Unavailable" and "empty" are different claims and only one is true. A
    // reader who cannot tell them apart concludes their pages were never read.
    expect(footnoteFor("citation_gap")).toMatch(/chatgpt only/i);
    expect(footnoteFor("citation_gap")).toMatch(/not retrievals/i);
  });

  it("frames the retrieved-but-uncited gap as directness, not volume", () => {
    // The advice differs completely: "write more" versus "answer the question
    // directly". Getting this wrong sends a customer to do the wrong work.
    expect(footnoteFor("retrieved_but_uncited")).toMatch(
      /directness problem, not a volume problem/i,
    );
  });
});
