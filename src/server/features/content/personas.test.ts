import { describe, expect, it } from "vitest";
import { aggregatePersona } from "./personas";

/**
 * Aggregate persona builder (CL-721): a population, never a person.
 *
 * The input type has no field a person could be assigned to, so the
 * aggregate-only rule is structural. Shares that do not sum to ~1 are
 * refused, individual shares outside 0-1 are refused with them, habits
 * describe what the SERP shows (never what the audience does), and an
 * unmeasured funnel stage travels as null.
 */

describe("aggregatePersona", () => {
  const input = {
    demography: [
      { label: "25–34", share: 0.45 },
      { label: "35–44", share: 0.35 },
      { label: "45+", share: 0.2 },
    ],
    funnelStage: "commercial" as const,
    serpFeatures: ["video", "people_also_ask"],
    sampleSize: 1200,
  };

  it("names the leading segment with sample and habits", () => {
    const persona = aggregatePersona(input);
    expect(persona.dominantSegment).toBe("25–34");
    expect(persona.funnelStage).toBe("commercial");
    expect(persona.readingHabits).toEqual([
      "video answers surface on the SERP",
      "follow-up questions are asked outright (PAA)",
    ]);
    expect(persona.sampleSize).toBe(1200);
    expect(persona.caveat).toMatch(/never a person/);
  });

  it("refuses shares that cannot be a population", () => {
    expect(() => aggregatePersona({ ...input, demography: [] })).toThrow(
      /at least one/,
    );
    expect(() =>
      aggregatePersona({
        ...input,
        demography: [{ label: "x", share: 0.4 }],
      }),
    ).toThrow(/not ~1/);
    // -0.2 and 1.2 sum to 1 and would otherwise pass as a population.
    expect(() =>
      aggregatePersona({
        ...input,
        demography: [
          { label: "x", share: -0.2 },
          { label: "y", share: 1.2 },
        ],
      }),
    ).toThrow(/outside 0-1/);
  });

  it("carries unmeasured funnel stage as null, not a guess", () => {
    const persona = aggregatePersona({ ...input, funnelStage: null });
    expect(persona.funnelStage).toBeNull();
    expect(persona.caveat).toMatch(/unmeasured/);
  });
});
