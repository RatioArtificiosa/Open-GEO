import { sortBy } from "remeda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  DISABLED_RETRY_AFTER_MS,
  fetchHiddenFamilyLive,
  HIDDEN_FAMILY_PATHS,
  type HiddenFamilyPath,
  hiddenFamilyDisabledReason,
  quoteHiddenFamilyCall,
  resetHiddenFamilyDisabled,
} from "@/server/lib/dataforseo/hidden-families";
import { AppError } from "@/server/lib/errors";
import { requestUrl } from "./test-support";

/**
 * The hidden-family client, breaker, and dry-run quote (C1/C6).
 *
 * Every 50304 body below is shaped like a recorded probe response
 * (`docs/research/route-probes-2026-10-13/`): the envelope-level reddit shape
 * with `tasks: null`, and the task-level content-generation shape with an
 * envelope of 20000 carrying a refused entry. A probe that cannot fail is not
 * measuring anything, so both shapes are exercised — the envelope case is the
 * one `assertOk` alone reports as broken rather than disabled.
 */

const REDDIT_PATH = "/v3/business_data/social_media/reddit/live";
const GENERATE_PATH = "/v3/content_generation/generate/live";
const ASIN_PATH = "/v3/merchant/amazon/asin/live";

function envelope50304() {
  return {
    version: "0.1.20260917",
    status_code: 50304,
    status_message:
      "This function temporarily unavailable. Please contact support for more information.",
    cost: 0,
    tasks_count: 0,
    tasks_error: 0,
    tasks: null,
  };
}

function task50304() {
  return {
    status_code: 20000,
    status_message: "Ok.",
    cost: 0,
    tasks_count: 1,
    tasks_error: 1,
    tasks: [
      {
        id: "10131656-2682-0499-2000-318149abc64e",
        status_code: 50304,
        status_message:
          "This function temporarily unavailable. Please contact support for more information.",
        cost: 0,
        result_count: 0,
        path: ["v3", "content_generation", "generate", "live"],
        data: { api: "content_generation", function: "generate" },
        result: null,
      },
    ],
  };
}

function successEnvelope() {
  return {
    status_code: 20000,
    status_message: "Ok.",
    cost: 0.005,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: "task-1",
        status_code: 20000,
        cost: 0.005,
        result_count: 1,
        path: ["v3", "merchant", "amazon", "asin", "live"],
        data: { asin: "B0EXAMPLE" },
        result: [{ asin: "B0EXAMPLE", title: "Example" }],
      },
    ],
  };
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

/** Narrow a caught failure to the product error without an assertion. */
function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  throw new Error(`expected an AppError, got ${String(error)}`);
}

beforeEach(() => {
  resetHiddenFamilyDisabled();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchHiddenFamilyLive", () => {
  it("posts to the exact typed path, because a typo here bills a 404", async () => {
    fetchMock.mockImplementation(async () => Response.json(successEnvelope()));
    await fetchHiddenFamilyLive(ASIN_PATH, [{ asin: "B0EXAMPLE" }]);
    expect(requestUrl(fetchMock)).toContain(ASIN_PATH);
  });

  it("surfaces an envelope-level 50304 as disabled, never as broken", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope50304()));
    const error = asAppError(
      await fetchHiddenFamilyLive(REDDIT_PATH, [{}]).catch((e: unknown) => e),
    );
    expect(error.code).toBe("UPSTREAM_FEATURE_DISABLED");
    expect(error.message).toMatch(/disabled/);
    expect(error.message).toMatch(/not.*retri/i);
    expect(hiddenFamilyDisabledReason(REDDIT_PATH)).not.toBeNull();
  });

  it("surfaces a task-level 50304 as disabled too", async () => {
    fetchMock.mockImplementation(async () => Response.json(task50304()));
    const error = asAppError(
      await fetchHiddenFamilyLive(GENERATE_PATH, [{ text: "hello" }]).catch(
        (e: unknown) => e,
      ),
    );
    expect(error.code).toBe("UPSTREAM_FEATURE_DISABLED");
    expect(hiddenFamilyDisabledReason(GENERATE_PATH)).not.toBeNull();
  });

  it("refuses a marked path before the network, so the breaker is not decoration", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope50304()));
    await fetchHiddenFamilyLive(REDDIT_PATH, [{}]).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      fetchHiddenFamilyLive(REDDIT_PATH, [{}]),
    ).rejects.toMatchObject({ code: "UPSTREAM_FEATURE_DISABLED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries a 50304, even when it arrives as HTTP 503", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(envelope50304()), { status: 503 }),
    );
    await expect(
      fetchHiddenFamilyLive(REDDIT_PATH, [{}]),
    ).rejects.toMatchObject({ code: "UPSTREAM_FEATURE_DISABLED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the mark when the same path succeeds", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope50304()));
    await fetchHiddenFamilyLive(REDDIT_PATH, [{}], 1_000).catch(
      () => undefined,
    );
    expect(hiddenFamilyDisabledReason(REDDIT_PATH, 1_000)).not.toBeNull();
    fetchMock.mockImplementation(async () => Response.json(successEnvelope()));
    // A different path was never marked; the reddit mark stands until reddit
    // itself succeeds, which is what keeps one family's outage from clearing
    // another's.
    await fetchHiddenFamilyLive(ASIN_PATH, [{ asin: "B0EXAMPLE" }], 2_000);
    expect(hiddenFamilyDisabledReason(ASIN_PATH, 2_000)).toBeNull();
    expect(hiddenFamilyDisabledReason(REDDIT_PATH, 2_000)).not.toBeNull();
    // Past the retry interval the breaker re-probes reddit itself; the
    // vendor answers this time, so the mark clears and the family recovers.
    await fetchHiddenFamilyLive(
      REDDIT_PATH,
      [{}],
      1_000 + DISABLED_RETRY_AFTER_MS,
    );
    expect(
      hiddenFamilyDisabledReason(REDDIT_PATH, 1_000 + DISABLED_RETRY_AFTER_MS),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("re-probes after a day and re-marks on another 50304", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope50304()));
    await fetchHiddenFamilyLive(REDDIT_PATH, [{}], 1_000).catch(
      () => undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Within the day the breaker holds without fetching.
    await expect(
      fetchHiddenFamilyLive(REDDIT_PATH, [{}], 2_000),
    ).rejects.toMatchObject({ code: "UPSTREAM_FEATURE_DISABLED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Past the day it probes once more; the vendor still refuses, so the mark
    // renews rather than clearing.
    await expect(
      fetchHiddenFamilyLive(REDDIT_PATH, [{}], 1_000 + DISABLED_RETRY_AFTER_MS),
    ).rejects.toMatchObject({ code: "UPSTREAM_FEATURE_DISABLED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      hiddenFamilyDisabledReason(REDDIT_PATH, 1_000 + DISABLED_RETRY_AFTER_MS),
    ).not.toBeNull();
  });
});

describe("quoteHiddenFamilyCall", () => {
  it("quotes a documented price with no network behind it", () => {
    const quote = quoteHiddenFamilyCall(ASIN_PATH);
    expect(quote.usd).toBe(0.005);
    expect(quote.priceSource).toBe("DFS_COMMERCE.amazonAsins.live");
    expect(quote.unit).toBe("request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prices per task with the unit stated, so a multi-task read cannot hide", () => {
    const quote = quoteHiddenFamilyCall(
      "/v3/business_data/google/reviews/task_post",
      10,
    );
    expect(quote.usd).toBeCloseTo(0.0075, 10);
    expect(quote.unit).toBe("10 reviews");
  });

  it("refuses an undocumented price by name rather than guessing one", () => {
    expect(() => quoteHiddenFamilyCall(GENERATE_PATH)).toThrowError(
      /No documented price for \/v3\/content_generation\/generate\/live/,
    );
    expect(() => quoteHiddenFamilyCall(REDDIT_PATH)).toThrowError(
      /No documented price/,
    );
  });

  it("pins every hidden-family path to its destination", async () => {
    // The endpoint-path gate reads these literals out of this file: a path
    // the client sends but no test names is a billed 404 waiting to happen.
    // The list is compared against the client's own table in both
    // directions, so a path added on either side without the other fails.
    const pinned: HiddenFamilyPath[] = [
      "/v3/content_generation/generate_text/live",
      "/v3/content_generation/generate/live",
      "/v3/content_generation/paraphrase/live",
      "/v3/content_generation/check_grammar/live",
      "/v3/content_generation/generate_sub_topics/live",
      "/v3/content_generation/generate_meta_tags/live",
      "/v3/business_data/social_media/reddit/live",
      "/v3/business_data/social_media/facebook/live",
      "/v3/business_data/social_media/pinterest/live",
      "/v3/serp/bing/local_pack/live/regular",
      "/v3/business_data/google/reviews/task_post",
      "/v3/business_data/tripadvisor/reviews/task_post",
      "/v3/business_data/trustpilot/reviews/task_post",
      "/v3/merchant/amazon/asin/live",
      "/v3/merchant/amazon/products/live",
      "/v3/merchant/amazon/sellers/live",
      "/v3/app_data/apple/app_searches/task_post",
      "/v3/app_data/apple/app_reviews/task_post",
      "/v3/app_data/google/app_searches/task_post",
      "/v3/app_data/google/app_reviews/task_post",
      "/v3/app_data/apple/app_listings/search/live",
      "/v3/app_data/google/app_listings/search/live",
    ];
    const tabled = Object.values(HIDDEN_FAMILY_PATHS).flat();
    expect(sortBy(pinned, (path) => path)).toEqual(
      sortBy(tabled, (path) => path),
    );
    for (const path of pinned) {
      fetchMock.mockImplementation(async () =>
        Response.json(successEnvelope()),
      );
      fetchMock.mockClear();
      await fetchHiddenFamilyLive(path, [{}]);
      expect(requestUrl(fetchMock)).toContain(path);
    }
  });
});
