import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  fetchCompetitorsDomain,
  fetchHistoricalRankOverview,
  fetchSubdomains,
  historicalMonthsSpanned,
} from "@/server/lib/dataforseo/labsDomainOverview";
import { requestUrl } from "./test-support";

/**
 * The three missing domain-overview endpoints (CL-401 remainder).
 *
 * Signatures verified against the endpoint references 2026-10-16
 * (historical_rank_overview, subdomains) and the 2026-10-06 browser read
 * (competitors_domain): historical needs one of each pair, subdomains needs
 * only a target, competitors_domain needs one of each pair. A test per rule,
 * because a signature copied from a sibling is how billed rejections happen.
 */

function okEnvelope(path: string[], result: unknown[] = []) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        cost: 0,
        result_count: result.length,
        path,
        data: {},
        result: [{ items: result }],
      },
    ],
  };
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchHistoricalRankOverview", () => {
  it("posts to the historical endpoint with a legacy ETV stamp", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        okEnvelope(
          [
            "v3",
            "dataforseo_labs",
            "google",
            "historical_rank_overview",
            "live",
          ],
          [{ year: 2026, month: 9, metrics: {} }],
        ),
      ),
    );
    const result = await fetchHistoricalRankOverview({
      target: "example.com",
      locationCode: 2840,
      languageCode: "en",
      now: new Date("2026-10-16T00:00:00Z"),
    });
    expect(requestUrl(fetchMock)).toContain(
      "/v3/dataforseo_labs/google/historical_rank_overview/live",
    );
    expect(result.data).toHaveLength(1);
    // Historical endpoints are excluded from the new model by vendor
    // definition: legacy, stamped, never guessed.
    expect(result.etv.formulaVersion).toBe("legacy");
    expect(result.etv.useNewEtv).toBe(false);
  });

  it("refuses an empty target and a missing pair before billing", async () => {
    await expect(fetchHistoricalRankOverview({ target: "  " })).rejects.toThrow(
      /needs a target domain/,
    );
    await expect(
      fetchHistoricalRankOverview({ target: "example.com" }),
    ).rejects.toThrow(/location_code or location_name/);
    await expect(
      fetchHistoricalRankOverview({
        target: "example.com",
        locationCode: 2840,
      }),
    ).rejects.toThrow(/language_code or language_name/);
    await expect(
      fetchHistoricalRankOverview({
        target: "example.com",
        locationCode: 2840,
        languageCode: "en",
        dateFrom: "last Tuesday",
      }),
    ).rejects.toThrow(/yyyy-mm-dd/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchSubdomains", () => {
  it("posts with only a target and null ETV provenance", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        okEnvelope(
          ["v3", "dataforseo_labs", "google", "subdomains", "live"],
          [{ subdomain: "blog.example.com" }],
        ),
      ),
    );
    const result = await fetchSubdomains({ target: "example.com" });
    expect(requestUrl(fetchMock)).toContain(
      "/v3/dataforseo_labs/google/subdomains/live",
    );
    expect(result.data).toHaveLength(1);
    expect(result.etv.formulaVersion).toBeNull();
    expect(result.etv.useNewEtv).toBe(false);
  });

  it("refuses an empty target without fetching", async () => {
    await expect(fetchSubdomains({ target: "" })).rejects.toThrow(
      /needs a target domain/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchCompetitorsDomain", () => {
  it("posts with target plus one of each pair", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        okEnvelope(
          ["v3", "dataforseo_labs", "google", "competitors_domain", "live"],
          [{ domain: "rival.com" }],
        ),
      ),
    );
    const result = await fetchCompetitorsDomain({
      target: "example.com",
      locationName: "United States",
      languageName: "English",
    });
    expect(requestUrl(fetchMock)).toContain(
      "/v3/dataforseo_labs/google/competitors_domain/live",
    );
    expect(result.data).toHaveLength(1);
    expect(result.etv.formulaVersion).toBeNull();
  });

  it("requires one of each pair — stricter than its subdomains sibling", async () => {
    await expect(
      fetchCompetitorsDomain({ target: "example.com" }),
    ).rejects.toThrow(/location_code or location_name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("historicalMonthsSpanned", () => {
  it("counts whole months inclusive without reading a clock", () => {
    expect(historicalMonthsSpanned("2026-01-01", "2026-03-29")).toBe(3);
    expect(historicalMonthsSpanned("2026-05-05", "2026-05-05")).toBe(1);
    expect(historicalMonthsSpanned(undefined, undefined)).toBe(6);
    expect(historicalMonthsSpanned(undefined, "2026-03-29")).toBe(6);
    expect(historicalMonthsSpanned("2026-03-29", "2026-01-01")).toBe(6);
  });
});
