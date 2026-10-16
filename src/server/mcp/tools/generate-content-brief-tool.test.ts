import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateContentBriefTool } from "./generate-content-brief-tool";
import { makeToolContext, textContent } from "./tool-test-support";

/**
 * The brief loop's first half (CL-725): a candidate with evidence becomes a
 * sourced brief, and an unpriced candidate becomes a reason rather than a
 * guessed outline. Pure — no vendor call, so no dry_run to offer and none
 * to test for.
 */

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();

const candidate = () => ({
  keyword: "crm software",
  volume: 1000 as number | null,
  keywordDifficulty: 30,
  serpCompetitors: 100,
  intent: "commercial" as const,
  aiNativeRatio: 0.3,
  rankElasticity: 0.5,
  trendFactor: 1.2 as number | null,
  etv: 5000 as number | null,
  serpElements: ["video"],
  competitorDomains: ["rival.example"],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2840,
    languageCode: "en",
  });
});

describe("generate_content_brief", () => {
  it("briefs the candidate with sourced sections and the diagnosis", async () => {
    const result = await generateContentBriefTool.handler(
      { projectId: "project_1", candidate: candidate() },
      toolContext,
    );
    const structured = z
      .object({ brief: z.looseObject({}), unpricedReason: z.null() })
      .passthrough()
      .parse(result.structuredContent);
    const briefShape = z
      .object({
        keyword: z.string(),
        formats: z.array(z.string()),
        diagnosis: z.string(),
        subTopics: z.null(),
        sections: z.array(z.object({ source: z.string() }).passthrough()),
      })
      .passthrough();
    const brief = briefShape.parse(structured.brief);
    expect(brief.keyword).toBe("crm software");
    expect(brief.formats.length).toBeGreaterThan(0);
    expect(brief.diagnosis.length).toBeGreaterThan(0);
    // The vendor half is an explicit absence.
    expect(brief.subTopics).toBeNull();
    expect(brief.sections.length).toBeGreaterThan(0);
    for (const section of brief.sections) {
      expect(["format-rule", "competitor-gap", "serp-evidence"]).toContain(
        section.source,
      );
    }
    const text = textContent(result);
    expect(text).toContain("crm software");
    expect(text).toContain("empty until the funding-day vendor call");
  });

  it("refuses an unpriced candidate instead of briefing a guess", async () => {
    const result = await generateContentBriefTool.handler(
      {
        projectId: "project_1",
        candidate: { ...candidate(), volume: null },
      },
      toolContext,
    );
    expect(textContent(result)).toMatch(/No brief.*no measured volume/);
    const structured = z
      .object({ brief: z.null(), unpricedReason: z.string() })
      .passthrough()
      .parse(result.structuredContent);
    expect(structured.unpricedReason).toMatch(/volume/);
  });
});
