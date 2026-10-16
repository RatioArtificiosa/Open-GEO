import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { creditsFor } from "@/server/mcp/dry-run";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import { getDomainCompetitorsTool } from "./get-domain-competitors";
import { getDomainHistoricalTool } from "./get-domain-historical";
import { getDomainSubdomainsTool } from "./get-domain-subdomains";
import { makeToolContext, textContent } from "./tool-test-support";

/**
 * First-caller proof for the three CL-401 tools.
 *
 * Each tool defaults to a dry run that spends nothing; the pins below are
 * the quote triple (endpoint path in the tool file, book entry, this test).
 * Each live path reaches the metered DomainIntel service exactly once and
 * renders its rows into the text block — a table of counts is the failure
 * this suite exists to prevent.
 */

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getHistoricalRanks: vi.fn(),
  getSubdomains: vi.fn(),
  getCompetitors: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/features/domain/services/domainIntel", () => ({
  DomainIntel: {
    getHistoricalRanks: mocks.getHistoricalRanks,
    getSubdomains: mocks.getSubdomains,
    getCompetitors: mocks.getCompetitors,
  },
}));

const toolContext = makeToolContext();

const dryRunShape = z
  .object({ dryRun: z.literal(true), estimatedCredits: z.number() })
  .passthrough();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2840,
    languageCode: "en",
  });
});

describe("get_domain_historical", () => {
  it("dry-runs by default without touching the service, quoting the book", async () => {
    const result = await getDomainHistoricalTool.handler(
      { projectId: "project_1", domain: "example.com" },
      toolContext,
    );
    expect(mocks.getHistoricalRanks).not.toHaveBeenCalled();
    const structured = dryRunShape.parse(result.structuredContent);
    // Triple: historical_rank_overview, DFS_LABS.historicalRank, this pin.
    // The open-ended default resolves to today's explicit date_to, and a
    // resolved six-month window touches seven calendar months:
    // 0.12 + 7 × 0.0012 = 0.1284 USD.
    expect(structured.estimatedCredits).toBeCloseTo(
      creditsFor(
        DFS_LABS.historicalRank.perRequest +
          DFS_LABS.historicalRank.perUnit * 7,
      ),
      10,
    );
    expect(textContent(result)).toContain("dry_run: false");
  });

  it("renders the monthly rows on dry_run false", async () => {
    mocks.getHistoricalRanks.mockResolvedValue({
      months: [
        { year: 2026, month: 9, organicTraffic: 1200, organicKeywords: 300 },
      ],
      etv: { formulaVersion: "legacy", useNewEtv: false, requestedAt: "t" },
      scope: "subdomains",
      displayTarget: "example.com",
    });
    const result = await getDomainHistoricalTool.handler(
      { projectId: "project_1", domain: "example.com", dry_run: false },
      toolContext,
    );
    expect(mocks.getHistoricalRanks).toHaveBeenCalledTimes(1);
    const text = textContent(result);
    expect(text).toContain("2026-09");
    expect(text).toContain("1200");
    expect(text).toContain("legacy");
  });
});

describe("get_domain_subdomains", () => {
  it("dry-runs by default, quoting the stated limit exactly", async () => {
    const result = await getDomainSubdomainsTool.handler(
      { projectId: "project_1", domain: "example.com", limit: 10 },
      toolContext,
    );
    expect(mocks.getSubdomains).not.toHaveBeenCalled();
    const structured = dryRunShape.parse(result.structuredContent);
    // Triple: subdomains/live, DFS_LABS.standard, this pin.
    expect(structured.estimatedCredits).toBeCloseTo(
      creditsFor(DFS_LABS.standard.perRequest + DFS_LABS.standard.perUnit * 10),
      10,
    );
  });

  it("renders subdomain rows on dry_run false", async () => {
    mocks.getSubdomains.mockResolvedValue({
      rows: [
        {
          name: "blog.example.com",
          organicTraffic: 100,
          organicKeywords: 20,
        },
      ],
      scope: "subdomains",
      displayTarget: "example.com",
    });
    const result = await getDomainSubdomainsTool.handler(
      { projectId: "project_1", domain: "example.com", dry_run: false },
      toolContext,
    );
    expect(mocks.getSubdomains).toHaveBeenCalledTimes(1);
    expect(textContent(result)).toContain("blog.example.com");
  });

  it("reports an empty answer, not a failure, when nothing ranks", async () => {
    mocks.getSubdomains.mockResolvedValue({
      rows: [],
      scope: "subdomains",
      displayTarget: "example.com",
    });
    const result = await getDomainSubdomainsTool.handler(
      { projectId: "project_1", domain: "example.com", dry_run: false },
      toolContext,
    );
    expect(textContent(result)).toContain("No subdomains found");
  });
});

describe("get_domain_competitors", () => {
  it("dry-runs at the default limit of 25", async () => {
    const result = await getDomainCompetitorsTool.handler(
      { projectId: "project_1", domain: "example.com" },
      toolContext,
    );
    expect(mocks.getCompetitors).not.toHaveBeenCalled();
    const structured = dryRunShape.parse(result.structuredContent);
    // Triple: competitors_domain/live, DFS_LABS.standard, this pin.
    expect(structured.estimatedCredits).toBeCloseTo(
      creditsFor(DFS_LABS.standard.perRequest + DFS_LABS.standard.perUnit * 25),
      10,
    );
  });

  it("renders competitor rows on dry_run false", async () => {
    mocks.getCompetitors.mockResolvedValue({
      rows: [
        { name: "rival.example", organicTraffic: 999, organicKeywords: 300 },
      ],
      scope: "subdomains",
      displayTarget: "example.com",
    });
    const result = await getDomainCompetitorsTool.handler(
      { projectId: "project_1", domain: "example.com", dry_run: false },
      toolContext,
    );
    expect(mocks.getCompetitors).toHaveBeenCalledTimes(1);
    expect(textContent(result)).toContain("rival.example");
  });
});
