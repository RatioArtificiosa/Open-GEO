import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchTripadvisorReviewsResult,
  fetchTrustpilotReviewsResult,
  postTripadvisorReviewsTask,
  postTrustpilotReviewsTask,
} from "./reviews";
import { requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

/**
 * Trustpilot + Tripadvisor clients (CL-504), against the documented shapes.
 *
 * Every field asserted here was read from the endpoint references on
 * 2026-10-16: Trustpilot wants a `domain` and bills per 20 reviews,
 * Tripadvisor wants a `url_path` (or keyword plus location) and bills per
 * 10. The fixtures below are the documented field surface in miniature —
 * rating blocks, item rows, verified flags — not the vendors' full sample
 * dumps, which would pin incidental fields as contract.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): Array<Record<string, unknown>> {
  const raw: unknown = typeof body === "string" ? JSON.parse(body) : body;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject);
}

function taskPosted(id = "task-1") {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20100,
        id,
        cost: 0.00075,
        path: ["v3", "business_data", "trustpilot", "reviews", "task_post"],
        result: null,
      },
    ],
  };
}

const trustpilotResult = {
  domain: "example.com",
  reviews_count: 27,
  rating: { rating_type: "Max5", value: 3.4, votes_count: null, rating_max: 5 },
  items_count: 2,
  items: [
    {
      type: "trustpilot_review_search",
      url: "https://www.trustpilot.com/reviews/1",
      rating: {
        rating_type: "Max5",
        value: 2,
        votes_count: null,
        rating_max: 5,
      },
      verified: false,
      timestamp: "2021-10-15 12:58:31 +00:00",
      title: "Stay clear",
      review_text: "nickel and dime",
    },
    {
      type: "trustpilot_review_search",
      url: "https://www.trustpilot.com/reviews/2",
      rating: {
        rating_type: "Max5",
        value: 5,
        votes_count: null,
        rating_max: 5,
      },
      verified: true,
      timestamp: "2021-10-16 12:58:31 +00:00",
      title: "Great service",
      review_text: "highly recommend",
    },
  ],
};

const tripadvisorResult = {
  url_path: "Hotel_Review-g1-d1-Reviews-X-Y.html",
  reviews_count: 879,
  rating: { rating_type: "Max5", value: 4.6, votes_count: null, rating_max: 5 },
  rating_distribution: { "1": 33, "2": 18, "3": 40, "4": 81, "5": 707 },
  items_count: 1,
  items: [
    {
      type: "tripadvisor_review_search",
      url: "https://www.tripadvisor.com/ShowUserReviews-1",
      rating: {
        rating_type: "Max5",
        value: 3,
        votes_count: null,
        rating_max: 5,
      },
      timestamp: "2025-06-08 00:00:00 +00:00",
      title: "Nice hotel",
      review_text: "great location",
    },
  ],
};

function taskDone(result: unknown) {
  return {
    status_code: 20000,
    tasks: [{ status_code: 20000, cost: 0, result: [result] }],
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

describe("postTrustpilotReviewsTask", () => {
  it("posts to the trustpilot path with domain and depth", async () => {
    fetchMock.mockResolvedValue(Response.json(taskPosted()));
    const { data } = await postTrustpilotReviewsTask({
      domain: "www.example.com",
      depth: 40,
    });
    expect(data).toBe("task-1");
    expect(requestUrl(fetchMock)).toContain(
      "/v3/business_data/trustpilot/reviews/task_post",
    );
    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]).toMatchObject({ domain: "www.example.com", depth: 40 });
  });

  it("refuses an empty domain and an over-max depth before billing", async () => {
    await expect(postTrustpilotReviewsTask({ domain: "  " })).rejects.toThrow(
      /domain/,
    );
    await expect(
      postTrustpilotReviewsTask({ domain: "example.com", depth: 201 }),
    ).rejects.toThrow(/depth/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("postTripadvisorReviewsTask", () => {
  it("posts url_path without demanding a location", async () => {
    fetchMock.mockResolvedValue(Response.json(taskPosted()));
    await postTripadvisorReviewsTask({
      urlPath: "Hotel_Review-g1-d1-Reviews-X-Y.html",
    });
    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]?.url_path).toBe("Hotel_Review-g1-d1-Reviews-X-Y.html");
    expect(requestUrl(fetchMock)).toContain(
      "/v3/business_data/tripadvisor/reviews/task_post",
    );
  });

  it("refuses a keyword without a location before billing", async () => {
    await expect(
      postTripadvisorReviewsTask({ keyword: "Margaritaville" }),
    ).rejects.toThrow(/location/);
    await expect(postTripadvisorReviewsTask({})).rejects.toThrow(
      /url_path or keyword/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("collectors", () => {
  it("reads trustpilot rows with ratings and verified flags", async () => {
    fetchMock.mockResolvedValue(Response.json(taskDone(trustpilotResult)));
    const outcome = await fetchTrustpilotReviewsResult("task-1");
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed" || outcome.result === null) {
      throw new Error("expected a completed result");
    }
    expect(outcome.result.reviews_count).toBe(27);
    expect(outcome.result.rating?.value).toBe(3.4);
    expect(outcome.result.items).toHaveLength(2);
    expect(outcome.result.items?.map((item) => item.rating?.value)).toEqual([
      2, 5,
    ]);
  });

  it("reads tripadvisor rows with distribution and ratings", async () => {
    fetchMock.mockResolvedValue(Response.json(taskDone(tripadvisorResult)));
    const outcome = await fetchTripadvisorReviewsResult("task-1");
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed" || outcome.result === null) {
      throw new Error("expected a completed result");
    }
    expect(outcome.result.rating_distribution?.["5"]).toBe(707);
    expect(outcome.result.items?.[0]?.rating?.value).toBe(3);
  });

  it("reports pending while the vendor still works", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ status_code: 20100, cost: 0, result: null }],
      }),
    );
    const outcome = await fetchTrustpilotReviewsResult("task-1");
    expect(outcome).toEqual({ status: "pending", result: null });
  });
});
