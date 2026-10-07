/**
 * `categories_for_domain`, and the one thing about it that decides the feature's shape.
 *
 * A response carries **numeric criterion IDs and no labels at all** — `categories: [10007]`, not
 * "Computers". The names are published separately as a taxonomy CSV, so this client's contract is
 * to hand the IDs through unchanged: inventing a label, or dropping an ID whose label is unknown,
 * would each be worse than a join the caller can do. That is the assertion worth keeping, because
 * a well-meaning "improvement" here would look like a tidy-up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCategoriesForDomain } from "@/server/lib/dataforseo/labsCategories";
import { fetchKeywordsForCategories } from "@/server/lib/dataforseo/labsCategories";
import { requestBody, requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const billed = {
  path: ["v3", "dataforseo_labs", "google", "categories_for_domain", "live"],
  cost: 0.012,
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

describe("fetchCategoriesForDomain", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls the documented path and returns the vendor's numeric criterion IDs unlabelled", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([
        {
          items: [
            {
              categories: [10007],
              metrics: { organic: { etv: 5467.57, count: 1431 } },
            },
          ],
        },
      ]),
    );

    const { data, billing } = await fetchCategoriesForDomain({
      target: "dataforseo.com",
      locationCode: 2840,
      languageCode: "en",
      limit: 10,
    });

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/dataforseo_labs/google/categories_for_domain/live",
    );
    expect(data[0]?.categories).toEqual([10007]);
    expect(data[0]?.metrics?.organic?.etv).toBe(5467.57);
    // Billing reads the task's own `cost`, never the price book's arithmetic — the reference's
    // sample response is stamped 2024 and carries a price that no longer applies.
    expect(billing.costUsd).toBe(0.012);
  });

  it("never opts into the doubled-price clickstream data unless asked", async () => {
    // The flag doubles the vendor's price. A default of `true` would be a silent 2× on every
    // call, so the absence of the opt-in is the thing to pin.
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [] }]),
    );

    await fetchCategoriesForDomain({
      target: "dataforseo.com",
      locationCode: 2840,
      languageCode: "en",
      limit: 10,
    });

    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      include_clickstream_data: false,
    });
  });
});

describe("fetchKeywordsForCategories", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls the documented path and sends the intersection flag explicitly", async () => {
    // The vendor defaults `category_intersection` to **true**, meaning "keywords in ALL named
    // categories". A caller passing three unrelated categories expects their union, so the flag
    // is part of the request rather than something the vendor decides.
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [{ keyword: "desktop dell optiplex" }] }]),
    );

    const { data } = await fetchKeywordsForCategories({
      categoryCodes: [12191, 12193],
      locationCode: 2840,
      languageCode: "en",
      categoryIntersection: false,
      limit: 10,
    });

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/dataforseo_labs/google/keywords_for_categories/live",
    );
    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      category_codes: [12191, 12193],
      category_intersection: false,
      include_clickstream_data: false,
    });
    expect(data[0]?.keyword).toBe("desktop dell optiplex");
  });

  it("refuses more than 20 categories before making a paid call", async () => {
    // The endpoint's cap is 20. Truncating to 20 would answer a different question than the one
    // asked, and the caller would have no way to see that it had. The assertion that **no
    // request was sent** is the half that matters, because a refusal after a billed call is a
    // refusal that cost money.
    await expect(
      fetchKeywordsForCategories({
        categoryCodes: Array.from({ length: 21 }, (_, index) => 10000 + index),
        locationCode: 2840,
        languageCode: "en",
        categoryIntersection: false,
        limit: 10,
      }),
    ).rejects.toThrow("between 1 and 20 categories");
    expect(fetch).not.toHaveBeenCalled();
  });
});
