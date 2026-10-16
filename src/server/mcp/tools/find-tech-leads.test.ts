import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { estimateTechLeadListUsd } from "@/shared/tech-lead-cost";
import { creditsFor } from "@/server/mcp/dry-run";
import { findTechLeadsTool } from "./find-tech-leads";
import { makeToolContext, textContent } from "./tool-test-support";

/**
 * CL-408 lead-list proof: the dry run quotes the whole list before it runs
 * (quote triple: WHOIS + technologies paths, `DFS_DOMAIN` book entries, this
 * test), and the live path divides that estimate by the prospects found
 * rather than inventing a per-prospect receipt the vendor never sends.
 */

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  findTechLeads: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/features/domain/services/techLeads", () => ({
  TechLeadsService: { findTechLeads: mocks.findTechLeads },
  TECH_LEADS_MAX_CANDIDATES: 25,
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

describe("find_tech_leads", () => {
  it("dry-runs by default, quoting WHOIS plus one tech read per candidate", async () => {
    const result = await findTechLeadsTool.handler(
      {
        projectId: "project_1",
        domainPattern: "plumb",
        requiredTech: ["shopify"],
        excludedTech: ["klaviyo"],
      },
      toolContext,
    );
    expect(mocks.findTechLeads).not.toHaveBeenCalled();
    const structured = dryRunShape.parse(result.structuredContent);
    // Triple: whois/overview + domain_technologies paths, DFS_DOMAIN, pin.
    // Default ten candidates: whois(10) + 10 × tech.
    expect(structured.estimatedCredits).toBeCloseTo(
      creditsFor(estimateTechLeadListUsd(10)),
      10,
    );
    expect(textContent(result)).toContain("dry_run: false");
  });

  it("scales the quote with maxCandidates", async () => {
    const result = await findTechLeadsTool.handler(
      {
        projectId: "project_1",
        domainPattern: "plumb",
        requiredTech: ["shopify"],
        maxCandidates: 5,
      },
      toolContext,
    );
    const structured = dryRunShape.parse(result.structuredContent);
    expect(structured.estimatedCredits).toBeCloseTo(
      creditsFor(estimateTechLeadListUsd(5)),
      10,
    );
  });

  it("renders prospects with contacts and a per-prospect estimate", async () => {
    mocks.findTechLeads.mockResolvedValue({
      prospects: [
        {
          domain: "a.example",
          technologies: ["shopify"],
          emails: ["ops@a.example"],
          phoneNumbers: [],
          socialUrls: [],
          countryIsoCode: "US",
          title: "A",
        },
      ],
      examined: 10,
      failed: [{ domain: "dead.example", reason: "vendor timeout" }],
    });
    const result = await findTechLeadsTool.handler(
      {
        projectId: "project_1",
        domainPattern: "plumb",
        requiredTech: ["shopify"],
        dry_run: false,
      },
      toolContext,
    );
    expect(mocks.findTechLeads).toHaveBeenCalledTimes(1);
    const text = textContent(result);
    expect(text).toContain("a.example");
    expect(text).toContain("ops@a.example");
    expect(text).toContain("dead.example");
    const structured = z
      .object({
        prospects: z.array(z.looseObject({})),
        estimatedCostPerProspectUsd: z.number(),
      })
      .passthrough()
      .parse(result.structuredContent);
    expect(structured.prospects).toHaveLength(1);
    // One prospect of ten candidates: the whole list price on one row.
    expect(structured.estimatedCostPerProspectUsd).toBeCloseTo(
      estimateTechLeadListUsd(10),
      10,
    );
  });

  it("reports an empty answer with the examined count, not a failure", async () => {
    mocks.findTechLeads.mockResolvedValue({
      prospects: [],
      examined: 10,
      failed: [],
    });
    const result = await findTechLeadsTool.handler(
      {
        projectId: "project_1",
        domainPattern: "plumb",
        requiredTech: ["shopify"],
        dry_run: false,
      },
      toolContext,
    );
    expect(textContent(result)).toContain("No prospects");
    expect(textContent(result)).toContain("10 candidates examined");
  });
});
