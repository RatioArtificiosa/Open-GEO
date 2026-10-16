import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { findTechLeads } from "./techLeads";

/**
 * CL-408 lead lists: WHOIS finds the candidates, technologies recovers each
 * stack with its contacts, and the slicer keeps the stack gap the list is
 * sold on. A failed technologies read reports its domain rather than voiding
 * the prospects already paid for — the WHOIS call is billed either way, so
 * failing the list would charge for nothing.
 */

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  whoisOverview: vi.fn(),
  domainTechnologies: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
  buildCacheKey: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: mocks.buildCacheKey,
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));

const billing: BillingCustomerContext = {
  organizationId: "org_1",
  userEmail: "leads-test@example.com",
  userId: "user_leads_test",
};

const base = {
  organizationId: "org_1",
  projectId: "00000000-0000-4000-8000-000000000001",
  domainPattern: "plumb",
  requiredTech: ["shopify"],
  excludedTech: ["klaviyo"],
};

const techRow = (
  domain: string,
  technologies: string[],
  emails: string[] = [],
) => ({
  domain,
  domain_rank: 1000,
  title: `${domain} title`,
  description: null,
  country_iso_code: "US",
  technologies: {
    ecommerce: technologies.map((name) => ({ name, categories: [] })),
  },
  emails,
  phone_numbers: [],
  social_graph_urls: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildCacheKey.mockImplementation(async (prefix: string) => prefix);
  mocks.getCached.mockResolvedValue(null);
  mocks.setCached.mockResolvedValue(undefined);
  mocks.createDataforseoClient.mockReturnValue({
    domain: {
      whoisOverview: mocks.whoisOverview,
      domainTechnologies: mocks.domainTechnologies,
    },
  });
});

describe("findTechLeads", () => {
  it("slices candidates to the stack gap and keeps contacts", async () => {
    let whoisSent: Record<string, unknown> = {};
    mocks.whoisOverview.mockImplementation(
      async (input: Record<string, unknown>) => {
        whoisSent = input;
        return [
          { domain: "a.example" },
          { domain: "b.example" },
          { domain: "c.example" },
        ];
      },
    );
    mocks.domainTechnologies.mockImplementation(
      async (input: Record<string, unknown>) => {
        if (input.target === "a.example")
          return [techRow("a.example", ["Shopify"], ["ops@a.example"])];
        if (input.target === "b.example")
          return [techRow("b.example", ["Shopify", "Klaviyo"])];
        return [techRow("c.example", ["WordPress"])];
      },
    );

    const result = await findTechLeads(base, billing);

    // WHOIS filtered on the pattern, capped at the default ten.
    expect(mocks.whoisOverview).toHaveBeenCalledTimes(1);
    expect(whoisSent.filters).toEqual([["domain", "like", "%plumb%"]]);
    expect(whoisSent.limit).toBe(10);
    // One technologies read per candidate.
    expect(mocks.domainTechnologies).toHaveBeenCalledTimes(3);
    // a.example runs Shopify without Klaviyo; b.example is excluded by the
    // gap it does not have; c.example never ran Shopify at all.
    expect(result.examined).toBe(3);
    expect(result.failed).toEqual([]);
    expect(result.prospects).toEqual([
      {
        domain: "a.example",
        technologies: ["shopify"],
        emails: ["ops@a.example"],
        phoneNumbers: [],
        socialUrls: [],
        countryIsoCode: "US",
        title: "a.example title",
      },
    ]);
    expect(mocks.setCached).toHaveBeenCalledTimes(1);
  });

  it("reports a failed technologies read instead of voiding the list", async () => {
    mocks.whoisOverview.mockResolvedValue([
      { domain: "a.example" },
      { domain: "dead.example" },
    ]);
    mocks.domainTechnologies.mockImplementation(
      async (input: Record<string, unknown>) => {
        if (input.target === "dead.example") throw new Error("vendor timeout");
        return [techRow("a.example", ["Shopify"])];
      },
    );

    const result = await findTechLeads(base, billing);

    expect(result.prospects).toHaveLength(1);
    expect(result.failed).toEqual([
      { domain: "dead.example", reason: "vendor timeout" },
    ]);
  });

  it("refuses an unfiltered call and a cap-busting one before spending", async () => {
    await expect(
      findTechLeads({ ...base, domainPattern: "  " }, billing),
    ).rejects.toThrow(/domain pattern/);
    await expect(
      findTechLeads({ ...base, requiredTech: [] }, billing),
    ).rejects.toThrow(/required technology/);
    await expect(
      findTechLeads({ ...base, maxCandidates: 26 }, billing),
    ).rejects.toThrow(/cap/);
    expect(mocks.whoisOverview).not.toHaveBeenCalled();
    expect(mocks.domainTechnologies).not.toHaveBeenCalled();
  });

  it("serves a warm cache without touching the metered client", async () => {
    mocks.getCached.mockResolvedValue({
      prospects: [],
      examined: 2,
      failed: [],
    });
    const result = await findTechLeads(base, billing);
    expect(result.examined).toBe(2);
    expect(mocks.whoisOverview).not.toHaveBeenCalled();
  });
});
