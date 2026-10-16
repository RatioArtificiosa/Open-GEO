import { describe, expect, it } from "vitest";
import {
  citationWinProbability,
  summarizeWinWindow,
  type CitationWinProbability,
  type ReadinessModifier,
  type RetrievalObservation,
} from "./citationWinProbability";

/**
 * The win probability, and the three refusals that keep it honest.
 *
 * The number is a **measured base rate with its uncertainty**, composed from the
 * two shipped ingredients (CL-206's gap list, CL-601's readiness), and every
 * refusal below is a way the number would otherwise become confident arithmetic
 * on noise.
 */

/** `n` retrievals, `cited` of them cited. */
function retrievals(n: number, cited: number): RetrievalObservation[] {
  return Array.from({ length: n }, (_, i) => ({ cited: i < cited }));
}

/** The three readiness states, asserted rather than assumed. */
const READINESS_STATES: ReadinessModifier[] = [
  "readiness-complete",
  "capped-by-readiness",
  "readiness-unknown",
];

describe("citationWinProbability", () => {
  it("reports the measured rate with its interval and the sample size", () => {
    const result = citationWinProbability({
      retrievals: retrievals(40, 10),
      retrievalsComplete: true,
    });

    expect(result.baseRate).toBeCloseTo(0.25, 5);
    expect(result.probability).toBeCloseTo(0.25, 5);
    // The denominator is always named: a rate without its count is the number
    // this product refuses to print.
    expect(result.retrievalsObserved).toBe(40);
    expect(result.citationsObserved).toBe(10);
    expect(result.summary).toMatch(
      /Of 40 retrieved pages, 10 were cited — 25%/,
    );
    expect(result.readinessModifier).toBe("readiness-complete");
    expect(result.summary).toMatch(
      /checks completed, so the point estimate stands/,
    );
  });

  it("quotes the low end when the audit still has fixes outstanding", () => {
    // **Readiness bounds, never inflates.** An unquotable page winning a
    // citation is the case with the least evidence behind it, so the quote is
    // the interval's low end and the reason travels in the sentence.
    const result = citationWinProbability({
      retrievals: retrievals(40, 10),
      retrievalsComplete: false,
    });

    expect(result.baseRate).toBeCloseTo(0.25, 5);
    expect(result.probability).not.toBeNull();
    expect(result.probability ?? 1).toBeLessThan(0.25);
    expect(result.readinessModifier).toBe("capped-by-readiness");
    expect(result.summary).toMatch(/low end of the interval is quoted/);
  });

  it("declines a rate from a sample under the floor", () => {
    // The floor is shared with the visibility direction, so the two cannot
    // disagree about where a rate starts being real. Seven rows is exactly the
    // shape a permissive answer would print a percentage from.
    const result = citationWinProbability({
      retrievals: retrievals(7, 1),
      retrievalsComplete: true,
    });

    expect(result.probability).toBeNull();
    expect(result.summary).toMatch(/Only 7 retrieved pages.*8 are the floor/);
    // The count is still reported — the list to act on survives the refusal.
    expect(result.summary).toMatch(/Of them, 1 were cited/);
  });

  it("treats no retrievals as no answer, not as a zero rate", () => {
    // "We retrieved nothing and cited nothing" is a measurement of the answers,
    // not of the citation rate. A 0% here reads as "never cited", which is the
    // flattering-misleading direction the product refuses.
    const result = citationWinProbability({
      retrievals: [],
      retrievalsComplete: true,
    });

    expect(result.baseRate).toBeNull();
    expect(result.probability).toBeNull();
    expect(result.summary).toMatch(/is not the same as nothing was cited/);
  });

  it("invents no penalty for an audit that never ran", () => {
    // Readiness unknown is its own state: "we could not check" is not "we
    // checked and found problems", and applying the conservative bound to it
    // would invent evidence — the same rule the readiness panel enforces.
    const result = citationWinProbability({
      retrievals: retrievals(40, 10),
      retrievalsComplete: null,
    });

    expect(result.readinessModifier).toBe("readiness-unknown");
    expect(result.probability).toBeCloseTo(0.25, 5);
    expect(result.summary).not.toMatch(/low end/);
  });

  it("reports a perfect record as perfect, without rounding it to certainty", () => {
    const result = citationWinProbability({
      retrievals: retrievals(30, 30),
      retrievalsComplete: true,
    });
    expect(result.baseRate).toBe(1);
    expect(result.probability).toBe(1);
    expect(result.summary).toMatch(/100%/);
  });

  it("only ever reports one of the three readiness states", () => {
    // The states are the contract: "we could not check" and "we checked and
    // found problems" must never collapse, and a fourth state arriving silently
    // would be a rule the module's callers cannot reason about.
    const states = new Set<ReadinessModifier>();
    for (const retrievalsComplete of [true, false, null]) {
      const result: CitationWinProbability = citationWinProbability({
        retrievals: retrievals(40, 10),
        retrievalsComplete,
      });
      states.add(result.readinessModifier);
    }
    // Sorted through a named local, because the repo's `lib` has no `toSorted`
    // and the lint rule fires on a `.sort()` over a fresh spread.
    const seen = [...states];
    seen.sort((a, b) => a.localeCompare(b));
    const expected = [...READINESS_STATES];
    expected.sort((a, b) => a.localeCompare(b));
    expect(seen).toEqual(expected);
  });
});

describe("summarizeWinWindow", () => {
  it("widens counts to rows with the same mapping every caller shares", () => {
    // The MCP citation-gap tool inlined this widening; the page's win-rate
    // function reads it from here. Both must quote the same number for the
    // same window, or the page and the agent disagree about one measurement.
    const shared = summarizeWinWindow(
      { retrievals: 40, citations: 10 },
      "fixes-outstanding",
    );
    const inline = citationWinProbability({
      retrievals: [
        ...Array.from({ length: 30 }, () => ({ cited: false })),
        ...Array.from({ length: 10 }, () => ({ cited: true })),
      ],
      retrievalsComplete: false,
    });
    expect(shared).toEqual(inline);
    expect(shared.probability).toBe(shared.low);
    expect(shared.readinessModifier).toBe("capped-by-readiness");
  });

  it("maps each readiness state to its sentence, never inventing a penalty", () => {
    expect(
      summarizeWinWindow({ retrievals: 40, citations: 10 }, "complete")
        .readinessModifier,
    ).toBe("readiness-complete");
    expect(
      summarizeWinWindow({ retrievals: 40, citations: 10 }, "unknown")
        .readinessModifier,
    ).toBe("readiness-unknown");
    // Unknown changes nothing: inventing a penalty for a check never run is
    // inventing evidence, so the point estimate stands.
    expect(
      summarizeWinWindow({ retrievals: 40, citations: 10 }, "unknown")
        .probability,
    ).toBeCloseTo(0.25, 5);
  });

  it("declines a thin window rather than printing arithmetic on noise", () => {
    const declined = summarizeWinWindow(
      { retrievals: 3, citations: 3 },
      "complete",
    );
    expect(declined.probability).toBeNull();
    expect(declined.retrievalsObserved).toBe(3);
    expect(declined.citationsObserved).toBe(3);
  });
});
