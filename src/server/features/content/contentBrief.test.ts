import { describe, expect, it } from "vitest";
import { buildContentBrief, CONTENT_BRIEF_VERSION } from "./contentBrief";
import type { BuildRecommendation } from "./whatToBuild";

/**
 * Machine briefs carry the diagnosis, never contradict it (CL-725).
 *
 * The brief is assembled from the recommendation's own fields, so every
 * assertion below is a *join* assertion: formats kept in order, the reason
 * verbatim, competitors named, and the vendor half an explicit null rather
 * than a fabricated outline.
 */

const recommendation = (
  overrides: Partial<BuildRecommendation> = {},
): BuildRecommendation => ({
  keyword: "crm software",
  formats: ["comparison", "guide"],
  serpEvidence: "video",
  score: 82,
  scoreVersion: "opp-1",
  reason: "contested gap at real volume, moving our way",
  trendFactor: 1.2,
  etv: 5000,
  competitorDomains: ["rival.example"],
  ...overrides,
});

describe("buildContentBrief", () => {
  it("carries the diagnosis verbatim with formats in order", () => {
    const brief = buildContentBrief(recommendation());
    expect(brief.briefVersion).toBe(CONTENT_BRIEF_VERSION);
    expect(brief.keyword).toBe("crm software");
    expect(brief.formats).toEqual(["comparison", "guide"]);
    expect(brief.score).toBe(82);
    expect(brief.scoreVersion).toBe("opp-1");
    expect(brief.diagnosis).toBe(
      "contested gap at real volume, moving our way",
    );
    expect(brief.competitorDomains).toEqual(["rival.example"]);
  });

  it("sources every section, and keeps ineligible SERP evidence as evidence", () => {
    const brief = buildContentBrief(recommendation());
    const sources = brief.sections.map((section) => section.source);
    expect(sources).toContain("format-rule");
    expect(sources).toContain("serp-evidence");
    expect(sources).toContain("competitor-gap");
    // The ineligible winner trails as something to mirror, never as advice:
    // formats still holds only the two eligible ones.
    expect(brief.formats).not.toContain("video");
    const evidence = brief.sections.find(
      (section) => section.source === "serp-evidence",
    );
    expect(evidence?.heading).toMatch(/video/);
    expect(evidence?.rationale).toMatch(/does not bless/);
  });

  it("leaves the vendor outline an explicit null, never a fabrication", () => {
    const brief = buildContentBrief(recommendation());
    expect(brief.subTopics).toBeNull();
  });

  it("writes no sections without a source when the evidence is thin", () => {
    const brief = buildContentBrief(
      recommendation({
        formats: ["guide"],
        serpEvidence: null,
        competitorDomains: [],
      }),
    );
    expect(brief.sections).toHaveLength(1);
    expect(brief.sections[0]?.source).toBe("format-rule");
  });
});
