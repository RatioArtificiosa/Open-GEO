/**
 * The date rules, which are the expensive half of this endpoint.
 *
 * `domain_metrics_by_categories` takes `first_date` and `second_date` in `yyyy-mm-dd` and refuses
 * several combinations — the same month twice, anything before 2020-10-01, anything in the future.
 * Every one of those refusals is a **billed** rejection when the vendor makes it, so each is
 * checked locally. The assertion that matters in every case here is that **no request was sent**.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDomainMetricsByCategories } from "@/server/lib/dataforseo/labsDomainMetrics";
import { requestBody, requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const billed = {
  path: [
    "v3",
    "dataforseo_labs",
    "google",
    "domain_metrics_by_categories",
    "live",
  ],
  cost: 0.1212,
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

const NOW = new Date("2026-10-06T00:00:00.000Z");

function args(overrides: Record<string, unknown> = {}) {
  return {
    categoryCodes: [11494, 13418],
    locationCode: 2840,
    languageCode: "en",
    firstDate: "2021-06-01",
    secondDate: "2021-10-01",
    limit: 10,
    now: NOW,
    ...overrides,
  };
}

describe("fetchDomainMetricsByCategories", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls the documented path with both dates", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [{ domain: "enricospastryshop.com" }] }]),
    );

    const { data } = await fetchDomainMetricsByCategories(args());

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/dataforseo_labs/google/domain_metrics_by_categories/live",
    );
    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      category_codes: [11494, 13418],
      first_date: "2021-06-01",
      second_date: "2021-10-01",
    });
    expect(data[0]?.domain).toBe("enricospastryshop.com");
  });

  it("refuses more than five categories before making a paid call", async () => {
    // This endpoint caps at 5, not the 20 its sibling allows — copying the sibling's guard would
    // send a request the vendor rejects after charging for it.
    await expect(
      fetchDomainMetricsByCategories(
        args({ categoryCodes: [1, 2, 3, 4, 5, 6] }),
      ),
    ).rejects.toThrow("between 1 and 5 categories");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses the same month twice before making a paid call", async () => {
    await expect(
      fetchDomainMetricsByCategories(
        args({ firstDate: "2021-06-01", secondDate: "2021-06-30" }),
      ),
    ).rejects.toThrow("same month");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a date before the supported window", async () => {
    await expect(
      fetchDomainMetricsByCategories(args({ firstDate: "2020-09-30" })),
    ).rejects.toThrow("2020-10-01");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a date in the future", async () => {
    await expect(
      fetchDomainMetricsByCategories(args({ secondDate: "2026-11-01" })),
    ).rejects.toThrow("in the future");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the dates in either order, as the reference allows", async () => {
    // The endpoint explicitly permits first_date to be later than second_date, so a client that
    // assumed an order would reject valid calls.
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [] }]),
    );

    await fetchDomainMetricsByCategories(
      args({ firstDate: "2021-10-01", secondDate: "2021-06-01" }),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a topCategoriesCount below the number of categories asked for", async () => {
    await expect(
      fetchDomainMetricsByCategories(args({ topCategoriesCount: 1 })),
    ).rejects.toThrow("cannot be less than");
    expect(fetch).not.toHaveBeenCalled();
  });
});
