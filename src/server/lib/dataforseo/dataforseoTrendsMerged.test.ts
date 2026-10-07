/**
 * The merged client: one path, one call, and the rules it shares with its three siblings.
 *
 * The point of this endpoint is that the three views cannot disagree about their window, so the
 * assertion that matters most is the simplest one: the request carries **one** pair of dates and
 * one location for all three.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDataforseoTrendsMergedData,
  MERGED_TREND_ELEMENT_TYPES,
} from "@/server/lib/dataforseo/dataforseoTrendsMerged";
import { requestBody, requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const billed = {
  path: ["v3", "keywords_data", "dataforseo_trends", "merged_data", "live"],
  cost: 0.006,
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

describe("fetchDataforseoTrendsMergedData", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls the merged_data path and returns the three elements", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([
        {
          items: MERGED_TREND_ELEMENT_TYPES.map((type) => ({ type })),
        },
      ]),
    );

    const { data } = await fetchDataforseoTrendsMergedData({
      keywords: ["rugby", "cricket"],
      locationCode: 2840,
      dateFrom: "2023-01-01",
      dateTo: "2024-01-01",
    });

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/keywords_data/dataforseo_trends/merged_data/live",
    );
    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      keywords: ["rugby", "cricket"],
      type: "web",
      date_from: "2023-01-01",
      date_to: "2024-01-01",
      location_code: 2840,
    });
    expect(data.map((element) => element.type)).toEqual([
      "dataforseo_trends_graph",
      "subregion_interests",
      "demography",
    ]);
  });

  it("refuses more than five keywords before making a paid call", async () => {
    await expect(
      fetchDataforseoTrendsMergedData({
        keywords: ["a", "b", "c", "d", "e", "f"],
      }),
    ).rejects.toThrow("between 1 and 5 keywords");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses timeRange together with explicit dates", async () => {
    await expect(
      fetchDataforseoTrendsMergedData({
        keywords: ["a"],
        timeRange: "past_30_days",
        dateFrom: "2024-01-01",
      }),
    ).rejects.toThrow("ignored by the vendor");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("holds each index type to its own earliest date", async () => {
    await expect(
      fetchDataforseoTrendsMergedData({
        keywords: ["a"],
        type: "news",
        dateFrom: "2005-01-01",
      }),
    ).rejects.toThrow("2008-01-01");
    expect(fetch).not.toHaveBeenCalled();
  });
});
