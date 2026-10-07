/**
 * The Trends client: the path it calls, the cap, and the two date rules that cost money.
 *
 * The path assertion matters more than usual here, because the family does **not** live where its
 * name suggests: `dataforseo_trends/explore/live` 404s in the documentation, and the real endpoint
 * is `keywords_data/dataforseo_trends/explore/live`. A client written from the family's name would
 * have passed every behavioural test and failed on a billed request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDataforseoTrendsExplore } from "@/server/lib/dataforseo/dataforseoTrends";
import { requestBody, requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const billed = {
  path: ["v3", "keywords_data", "dataforseo_trends", "explore", "live"],
  cost: 0.0012,
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

describe("fetchDataforseoTrendsExplore", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls the real path, under keywords_data", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [{ type: "dataforseo_trends_graph" }] }]),
    );

    const { data } = await fetchDataforseoTrendsExplore({
      keywords: ["iphone 14", "samsung s23"],
      locationCode: 2840,
    });

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/keywords_data/dataforseo_trends/explore/live",
    );
    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      keywords: ["iphone 14", "samsung s23"],
      type: "web",
      location_code: 2840,
    });
    expect(data).toHaveLength(1);
  });

  it("refuses more than five keywords before making a paid call", async () => {
    // One request is billed the same at one keyword or five, so silently dropping a keyword would
    // lose a series for free.
    await expect(
      fetchDataforseoTrendsExplore({
        keywords: ["a", "b", "c", "d", "e", "f"],
      }),
    ).rejects.toThrow("between 1 and 5 keywords");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses timeRange together with explicit dates, because the vendor ignores it", async () => {
    // The reference says a preset is ignored when either date is set. Sending both would give the
    // caller the dates while they believe the preset applied.
    await expect(
      fetchDataforseoTrendsExplore({
        keywords: ["a"],
        timeRange: "past_7_days",
        dateFrom: "2024-01-01",
      }),
    ).rejects.toThrow("ignored by the vendor");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("holds each index type to its own earliest date", async () => {
    // 2005 is inside the `web` window and outside `news`/`ecommerce`, so a single shared constant
    // would let half these requests through to a billed rejection.
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [] }]),
    );

    await fetchDataforseoTrendsExplore({
      keywords: ["a"],
      type: "web",
      dateFrom: "2005-01-01",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(
      fetchDataforseoTrendsExplore({
        keywords: ["a"],
        type: "news",
        dateFrom: "2005-01-01",
      }),
    ).rejects.toThrow("2008-01-01");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("omits location when none is given, which asks for global results", async () => {
    // Not an error at the vendor: omitting location returns global data, which is a different
    // thing to measure. The request should carry no location at all.
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [] }]),
    );

    await fetchDataforseoTrendsExplore({ keywords: ["a"] });

    const body = requestBody(vi.mocked(fetch))[0];
    expect(body.location_code).toBeUndefined();
  });
});
