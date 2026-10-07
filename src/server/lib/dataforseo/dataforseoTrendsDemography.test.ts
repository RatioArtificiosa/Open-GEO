/**
 * The demography client: the path, the cap, and the rules it shares with its sibling.
 *
 * The path is asserted because this family does not live where its name suggests —
 * `dataforseo_trends/...` alone is not an endpoint — and a wrong path passes every behavioural
 * test and fails only on a billed request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDataforseoTrendsDemography } from "@/server/lib/dataforseo/dataforseoTrendsDemography";
import { requestBody, requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const billed = {
  path: ["v3", "keywords_data", "dataforseo_trends", "demography", "live"],
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

describe("fetchDataforseoTrendsDemography", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls the demography path under keywords_data", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [{ type: "demography" }] }]),
    );

    const { data } = await fetchDataforseoTrendsDemography({
      keywords: ["rugby", "cricket"],
      locationCode: 2840,
    });

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/keywords_data/dataforseo_trends/demography/live",
    );
    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      keywords: ["rugby", "cricket"],
      type: "web",
    });
    expect(data).toHaveLength(1);
  });

  it("refuses more than five keywords before making a paid call", async () => {
    await expect(
      fetchDataforseoTrendsDemography({
        keywords: ["a", "b", "c", "d", "e", "f"],
      }),
    ).rejects.toThrow("between 1 and 5 keywords");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses timeRange together with explicit dates, as its sibling does", async () => {
    await expect(
      fetchDataforseoTrendsDemography({
        keywords: ["a"],
        timeRange: "past_30_days",
        dateFrom: "2024-01-01",
      }),
    ).rejects.toThrow("ignored by the vendor");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("holds each index type to its own earliest date", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [] }]),
    );

    await expect(
      fetchDataforseoTrendsDemography({
        keywords: ["a"],
        type: "ecommerce",
        dateFrom: "2005-01-01",
      }),
    ).rejects.toThrow("2008-01-01");
    expect(fetch).not.toHaveBeenCalled();
  });
});
