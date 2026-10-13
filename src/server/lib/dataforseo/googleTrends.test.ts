/**
 * Google Trends: the shared prefix, and the rules that differ from its sibling.
 *
 * The two families look alike enough that a copy is tempting, and a copy would get the character
 * rule, the item-type precondition and the type vocabulary wrong — each a **billed** rejection at
 * the vendor rather than a visible error. Every case here asserts that **no request was sent**.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleTrendsExplore } from "@/server/lib/dataforseo/googleTrends";
import { requestBody, requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const billed = {
  path: ["v3", "keywords_data", "google_trends", "explore", "live"],
  cost: 0.011,
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

describe("fetchGoogleTrendsExplore", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls google_trends under keywords_data", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [{ type: "google_trends_graph" }] }]),
    );

    const { data } = await fetchGoogleTrendsExplore({
      keywords: ["standing desk"],
      locationCode: 2840,
    });

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/keywords_data/google_trends/explore/live",
    );
    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      keywords: ["standing desk"],
      type: "web",
    });
    expect(data).toHaveLength(1);
  });

  it("refuses a keyword containing a character the vendor rejects", async () => {
    // A hyphen is the one that catches people: `e-commerce` looks like an ordinary search term and
    // is an invalid request, which the task fee applies to anyway.
    await expect(
      fetchGoogleTrendsExplore({ keywords: ["e-commerce"] }),
    ).rejects.toThrow("rejects these characters");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses related-topics or related-queries items for more than one keyword", async () => {
    await expect(
      fetchGoogleTrendsExplore({
        keywords: ["a", "b"],
        itemTypes: ["google_trends_topics_list"],
      }),
    ).rejects.toThrow("single keyword");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts related queries for exactly one keyword", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [] }]),
    );

    await fetchGoogleTrendsExplore({
      keywords: ["standing desk"],
      itemTypes: ["google_trends_queries_list"],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a request with neither keywords nor a category", async () => {
    // The reference requires one or the other, so this is a billed rejection rather than an
    // empty answer.
    await expect(fetchGoogleTrendsExplore({})).rejects.toThrow(
      "either keywords or a categoryCode",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can be driven by a category instead of keywords", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      okResponse([{ items: [] }]),
    );

    await fetchGoogleTrendsExplore({ categoryCode: 3 });

    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      category_code: 3,
    });
  });

  it("refuses a category_code of zero, which the vendor rejects and bills for", async () => {
    // **The documented rule, unguarded until 2026-10-13.** `0 == null` is
    // false, so a zero sailed past the one-of-two guard and reached the vendor
    // as a rejected task with the task fee attached. A default-valued zero is
    // the easiest version of this to ship: the capability is "open" and the
    // first request through it is a billed rejection.
    await expect(fetchGoogleTrendsExplore({ categoryCode: 0 })).rejects.toThrow(
      "greater than 0",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a negative or fractional category_code, for the same reason", async () => {
    // The categories list is a join of whole positive numbers, so anything else
    // is a caller's bug caught here rather than the vendor's rejection caught
    // on the invoice.
    for (const categoryCode of [-1, 2.5]) {
      await expect(fetchGoogleTrendsExplore({ categoryCode })).rejects.toThrow(
        "greater than 0",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses more than five keywords before making a paid call", async () => {
    await expect(
      fetchGoogleTrendsExplore({ keywords: ["a", "b", "c", "d", "e", "f"] }),
    ).rejects.toThrow("between 1 and 5 keywords");
    expect(fetch).not.toHaveBeenCalled();
  });
});
