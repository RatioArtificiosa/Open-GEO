/**
 * The subregion client: its path, its cap, and the rules it shares with its siblings.
 *
 * The path is asserted for the usual reason in this family — a wrong one passes every behavioural
 * test and fails only on a billed request — and the date rule for the reason that the two index
 * types have different floors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDataforseoTrendsSubregion } from "@/server/lib/dataforseo/dataforseoTrendsSubregion";
import { requestBody, requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const billed = {
  path: [
    "v3",
    "keywords_data",
    "dataforseo_trends",
    "subregion_interests",
    "live",
  ],
  cost: 0.0024,
  result_count: 1,
};

function okResponse(result: unknown[]) {
  return new Response(
    JSON.stringify({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [{ status_code: 20000, status_message: "Ok.", ...billed, result }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("fetchDataforseoTrendsSubregion", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls the subregion_interests path under keywords_data", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [{ type: "subregion_interests" }] }]),
    );

    const { data } = await fetchDataforseoTrendsSubregion({
      keywords: ["rugby", "cricket"],
      locationCode: 2840,
    });

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/keywords_data/dataforseo_trends/subregion_interests/live",
    );
    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      keywords: ["rugby", "cricket"],
      type: "web",
    });
    expect(data).toHaveLength(1);
  });

  it("refuses more than five keywords before making a paid call", async () => {
    await expect(
      fetchDataforseoTrendsSubregion({
        keywords: ["a", "b", "c", "d", "e", "f"],
      }),
    ).rejects.toThrow("between 1 and 5 keywords");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("holds each index type to its own earliest date", async () => {
    await expect(
      fetchDataforseoTrendsSubregion({
        keywords: ["a"],
        type: "ecommerce",
        dateFrom: "2005-01-01",
      }),
    ).rejects.toThrow("2008-01-01");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses timeRange together with explicit dates", async () => {
    await expect(
      fetchDataforseoTrendsSubregion({
        keywords: ["a"],
        timeRange: "past_30_days",
        dateFrom: "2024-01-01",
      }),
    ).rejects.toThrow("ignored by the vendor");
    expect(fetch).not.toHaveBeenCalled();
  });
});
