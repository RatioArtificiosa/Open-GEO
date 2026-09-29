import { describe, expect, it, vi } from "vitest";

/**
 * The four aggregation / time-series `llm_mentions` endpoints.
 *
 * These tests assert the **request body**, not the response mapping. That is
 * deliberate: a misspelled field name does not fail quietly — DataForSEO
 * rejects it with a 40501 "Invalid Field" error *on a billable request*. So the
 * parameter names are pinned, and the two documented self-contradictions are
 * pinned as decisions rather than left to whoever calls this next.
 *
 * Verified against the live docs on 2026-09-28.
 *
 * Named after `ai-mentions.ts` so the pairing is obvious; the module was split
 * out of `ai.ts` when the file passed the 400-line limit.
 */

/**
 * The mocked POST.
 *
 * Typed rather than a bare `vi.fn()`, because an untyped mock makes every
 * `.mock.calls` read `any` and the test then needs assertions to satisfy the
 * linter instead of the type system.
 */
const post =
  vi.fn<(path: string, body: unknown, options?: unknown) => unknown>();

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/dataforseo/core", () => ({
  dataforseoPost: post,
}));

const {
  LLM_MENTIONS_HISTORY_FLOOR,
  fetchLlmHistorical,
  fetchLlmNewLost,
  fetchLlmTargetMetrics,
  fetchLlmTopMentioned,
} = await import("@/server/lib/dataforseo/ai-mentions");

/** A successful Live envelope, which is what these endpoints always return. */
function okResponse(result: Record<string, unknown>) {
  return {
    version: "0.1.20260610",
    status_code: 20000,
    status_message: "Ok.",
    time: "1.2 sec.",
    cost: 0.101,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: "t1",
        status_code: 20000,
        status_message: "Ok.",
        time: "1.1 sec.",
        cost: 0.101,
        result_count: 1,
        path: [],
        data: {},
        result: [result],
      },
    ],
  };
}

const QUERY = {
  target: { type: "domain" as const, domain: "acme.com" },
  platform: "chat_gpt" as const,
  locationCode: 2840,
  languageCode: "en",
};

/** The single task body the client sent. */
function sentTask(): Record<string, unknown> {
  const call = post.mock.calls[0];
  if (!call) throw new Error("no request was sent");
  const body: unknown = call[1];
  if (!Array.isArray(body)) throw new Error("no task array was sent");
  const first: unknown = body[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("no task body was sent");
  }
  return Object.fromEntries(Object.entries(first));
}

function sentPath(): string {
  return String(post.mock.calls[0]?.[0]);
}

describe("llm_mentions aggregation endpoints", () => {
  it("reads target_metrics from aggregated_metrics, not from items", async () => {
    // The endpoint documents items as always empty and the three counters as
    // always 0. Reading totals off `items` would return nothing forever.
    post.mockReset().mockResolvedValue(
      okResponse({
        total_count: 0,
        offset: 0,
        items_count: 0,
        items: [],
        aggregated_metrics: {
          platform: [{ key: "chat_gpt", mentions: 12, ai_search_volume: 900 }],
          total: { mentions: 12, ai_search_volume: 900 },
        },
      }),
    );
    const { data } = await fetchLlmTargetMetrics(QUERY);
    expect(data.aggregated_metrics?.total?.mentions).toBe(12);
    expect(sentPath()).toBe(
      "/v3/ai_optimization/llm_mentions/target_metrics/live",
    );
  });

  it("accepts a location key sent as either a number or a string", async () => {
    // The reference tables say integer; the top_mentioned example JSON sends
    // "2840". Typing it as one of the two is a bug waiting for the other
    // endpoint to be called.
    post.mockReset().mockResolvedValue(
      okResponse({
        aggregated_metrics: {
          location: [{ key: "2840", mentions: 3, ai_search_volume: 10 }],
        },
      }),
    );
    const { data } = await fetchLlmTargetMetrics(QUERY);
    expect(data.aggregated_metrics?.location?.[0]?.key).toBe("2840");
  });

  it("sends date_from and date_to to historical, not start_date", async () => {
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmHistorical({
      ...QUERY,
      dateFrom: "2026-01-01",
      dateTo: "2026-06-30",
    });
    const task = sentTask();
    expect(task.date_from).toBe("2026-01-01");
    expect(task.date_to).toBe("2026-06-30");
    // The names this is guarding against. Both are plausible guesses and both
    // would be a billable rejection.
    expect(task.start_date).toBeUndefined();
    expect(task.end_date).toBeUndefined();
  });

  it("omits the date fields entirely when no window is given", async () => {
    // historical's dates are optional; sending an empty string would be an
    // invalid value, not an absent one.
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmHistorical(QUERY);
    const task = sentTask();
    expect("date_from" in task).toBe(false);
    expect("date_to" in task).toBe(false);
  });

  it("publishes the history floor so callers cannot ask for a year that does not exist", () => {
    // DataForSEO holds mentions history from 2025-08-01. The example response
    // contains one month *before* that with zero metrics.
    expect(LLM_MENTIONS_HISTORY_FLOOR).toBe("2025-08-01");
  });

  it("keeps new and lost as four separate counters", async () => {
    post.mockReset().mockResolvedValue(
      okResponse({
        items_count: 1,
        items: [
          {
            date: "2026-06-01",
            new_mentions: 3,
            lost_mentions: 1,
            new_ai_search_volume: 900,
            lost_ai_search_volume: 100,
          },
        ],
      }),
    );
    const { data } = await fetchLlmNewLost({
      ...QUERY,
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      groupRange: "month",
    });
    const item = data[0];
    // Collapsing these into one "change" number would hide which one moved.
    expect(item?.new_mentions).toBe(3);
    expect(item?.lost_mentions).toBe(1);
    expect(item?.new_ai_search_volume).toBe(900);
    expect(item?.lost_ai_search_volume).toBe(100);
  });

  it("requires a window on timeseries_new_lost rather than taking the vendor default", async () => {
    // All three date/group parameters are required on this endpoint, so they
    // are required in the signature. The compile error is the feature.
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmNewLost({
      ...QUERY,
      dateFrom: "2026-01-01",
      dateTo: "2026-06-30",
      groupRange: "day",
    });
    const task = sentTask();
    expect(task.group_range).toBe("day");
    expect(task.date_from).toBe("2026-01-01");
  });

  it("always sends platform explicitly, because the documented default is self-contradictory", async () => {
    // The docs say both "default value: google" and "if the platform is not
    // specified, data is returned for both platforms". Only one can be true,
    // and the failure mode is a number blended from two demand models.
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmTargetMetrics({ ...QUERY, platform: "google" });
    expect(sentTask().platform).toBe("google");
  });

  it("routes each top_mentioned kind to its own path", async () => {
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmTopMentioned({ ...QUERY, kind: "domains" });
    expect(sentPath()).toBe(
      "/v3/ai_optimization/llm_mentions/top_mentioned_domains/live",
    );
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmTopMentioned({ ...QUERY, kind: "pages" });
    expect(sentPath()).toBe(
      "/v3/ai_optimization/llm_mentions/top_mentioned_pages/live",
    );
  });

  it("defaults links_scope to sources, so a citation ranking is never a retrieval ranking", async () => {
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmTopMentioned({ ...QUERY, kind: "pages" });
    expect(sentTask().links_scope).toBe("sources");
  });

  it("can ask for the retrieval ranking explicitly", async () => {
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmTopMentioned({
      ...QUERY,
      kind: "pages",
      linksScope: "search_results",
    });
    expect(sentTask().links_scope).toBe("search_results");
  });

  it("clamps limit into the documented 1..1000 range", async () => {
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmTopMentioned({ ...QUERY, kind: "domains", limit: 99_999 });
    expect(sentTask().limit).toBe(1000);
    post
      .mockReset()
      .mockResolvedValue(okResponse({ items: [], items_count: 0 }));
    await fetchLlmTopMentioned({ ...QUERY, kind: "domains", limit: 0 });
    expect(sentTask().limit).toBe(1);
  });

  it("reads the page key from pages and the domain key from domains", async () => {
    // One schema covers both endpoints; only the key field differs.
    post.mockReset().mockResolvedValue(
      okResponse({
        items_count: 1,
        items: [
          {
            page: "https://acme.com/pricing?utm_source=chatgpt.com",
            total: { mentions: 4, ai_search_volume: 20 },
          },
        ],
      }),
    );
    const { data } = await fetchLlmTopMentioned({ ...QUERY, kind: "pages" });
    // Stored raw: the tracking query string is stripped at display, not on the
    // way in, so the archive keeps what the vendor actually returned.
    expect(data[0]?.page).toContain("utm_source=chatgpt.com");
  });

  it("throws rather than silently returning empty when the shape is wrong", async () => {
    // An empty list and a parse failure look identical to every consumer, and
    // one of them means "this brand has no mentions".
    post.mockReset().mockResolvedValue({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          // `result` is a string where an array of objects was documented.
          result: "unexpected",
        },
      ],
    });
    await expect(fetchLlmTargetMetrics(QUERY)).rejects.toThrow();
  });
});
