import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { DomainIntel } from "./domainIntel";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  historicalRankOverview: vi.fn(),
  subdomains: vi.fn(),
  competitorsDomain: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
  buildCacheKey: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  // waitUntil executes inline in tests so cache writes are observable.
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
  userEmail: "intel-test@example.com",
  userId: "user_intel_test",
};

const base = {
  organizationId: "org_1",
  projectId: "00000000-0000-4000-8000-000000000001",
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildCacheKey.mockImplementation(async (prefix: string) => prefix);
  mocks.getCached.mockResolvedValue(null);
  mocks.setCached.mockResolvedValue(undefined);
  mocks.createDataforseoClient.mockReturnValue({
    domain: {
      historicalRankOverview: mocks.historicalRankOverview,
      subdomains: mocks.subdomains,
      competitorsDomain: mocks.competitorsDomain,
    },
  });
});

describe("DomainIntel.getHistoricalRanks", () => {
  it("calls the metered namespace with the hostname and market, and maps months", async () => {
    let sent: Record<string, unknown> = {};
    mocks.historicalRankOverview.mockImplementation(
      async (input: Record<string, unknown>) => {
        sent = input;
        return [
          {
            year: 2026,
            month: 9,
            metrics: { organic: { etv: 1234.6, count: 500.2 } },
          },
          { year: 2026, month: 13, metrics: null },
          { metrics: null },
        ];
      },
    );
    const result = await DomainIntel.getHistoricalRanks(base, billing);
    expect(mocks.historicalRankOverview).toHaveBeenCalledTimes(1);
    expect(sent.target).toBe("example.com");
    expect(sent.locationCode).toBe(2840);
    expect(result.months).toEqual([
      {
        year: 2026,
        month: 9,
        organicTraffic: 1235,
        organicKeywords: 500,
      },
    ]);
    expect(result.etv.useNewEtv).toBe(false);
    expect(mocks.setCached).toHaveBeenCalledTimes(1);
  });

  it("serves a warm cache without touching the metered client", async () => {
    mocks.getCached.mockResolvedValue({
      months: [
        { year: 2026, month: 8, organicTraffic: 10, organicKeywords: 5 },
      ],
      etv: { formulaVersion: "legacy", useNewEtv: false, requestedAt: "t" },
    });
    const result = await DomainIntel.getHistoricalRanks(base, billing);
    expect(result.months).toHaveLength(1);
    expect(mocks.historicalRankOverview).not.toHaveBeenCalled();
  });
});

describe("DomainIntel.getSubdomains", () => {
  it("drops unnamed rows and caches the list", async () => {
    let sent: Record<string, unknown> = {};
    mocks.subdomains.mockImplementation(
      async (input: Record<string, unknown>) => {
        sent = input;
        return [
          {
            subdomain: "blog.example.com",
            metrics: { organic: { etv: 100, count: 20 } },
          },
          { subdomain: null, metrics: null },
        ];
      },
    );
    const result = await DomainIntel.getSubdomains(
      { ...base, limit: 50 },
      billing,
    );
    expect(result.rows).toEqual([
      { name: "blog.example.com", organicTraffic: 100, organicKeywords: 20 },
    ]);
    expect(sent.limit).toBe(50);
    expect(mocks.setCached).toHaveBeenCalledTimes(1);
  });

  it("does not cache an empty list, so a later retry can bill once", async () => {
    mocks.subdomains.mockResolvedValue([]);
    const result = await DomainIntel.getSubdomains(base, billing);
    expect(result.rows).toEqual([]);
    expect(mocks.setCached).not.toHaveBeenCalled();
  });
});

describe("DomainIntel.getCompetitors", () => {
  it("maps competitor rows through the metered namespace", async () => {
    mocks.competitorsDomain.mockResolvedValue([
      {
        domain: "rival.example",
        metrics: { organic: { etv: 999.4, count: 300 } },
      },
    ]);
    const result = await DomainIntel.getCompetitors(
      { ...base, limit: 10, offset: 0 },
      billing,
    );
    expect(result.rows).toEqual([
      { name: "rival.example", organicTraffic: 999, organicKeywords: 300 },
    ]);
    expect(mocks.createDataforseoClient).toHaveBeenCalledTimes(1);
  });

  it("serves a warm cache without touching the metered client", async () => {
    mocks.getCached.mockResolvedValue([
      { name: "rival.example", organicTraffic: 1, organicKeywords: 2 },
    ]);
    const result = await DomainIntel.getCompetitors(base, billing);
    expect(result.rows).toHaveLength(1);
    expect(mocks.competitorsDomain).not.toHaveBeenCalled();
  });
});
