import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  fetchOnPageWaterfall,
  postOnPageCrawlTaskForWaterfall,
} from "@/server/lib/dataforseo/on-page-waterfall";
import { requestUrl } from "./test-support";

/** A task_post acceptance: `20100 Task Created`, not `20000 Ok`. */
function taskCreated(id: string | undefined) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20100,
        path: ["v3", "on_page", "task_post"],
        cost: 0.00045,
        ...(id === undefined ? {} : { id }),
      },
    ],
  };
}

function waterfallEnvelope(options: { cost?: number } = {}) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: ["v3", "on_page", "waterfall"],
        cost: options.cost ?? 0,
        result_count: 1,
        result: [
          {
            crawl_progress: "in_progress",
            crawl_status: {
              max_crawl_pages: 100,
              pages_in_queue: 97,
              pages_crawled: 3,
            },
            items_count: 1,
            items: [
              {
                page_url: "https://example.com/",
                time_to_interactive: 644,
                dom_complete: 644,
                connection_time: 13,
                time_to_secure_connection: 18,
                request_sent_time: 0,
                waiting_time: 42,
                download_time: 5,
                duration_time: 36,
                fetch_start: 0,
                fetch_end: 36,
                resources: [
                  {
                    resource_type: "stylesheet",
                    url: "https://example.com/app.css",
                    initiator: "(index)",
                    duration_time: 27,
                    fetch_start: 36,
                    fetch_end: 63,
                    is_render_blocking: true,
                  },
                  {
                    // A resource with no timing at all must survive as nulls, not zeroes.
                    resource_type: null,
                    url: null,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): Array<Record<string, unknown>> {
  const raw: unknown = typeof body === "string" ? JSON.parse(body) : body;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject);
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postOnPageCrawlTaskForWaterfall", () => {
  it("asks for resource loading and nothing dearer", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(taskCreated("task-1")),
    );
    await postOnPageCrawlTaskForWaterfall({
      url: "https://example.com/",
      maxCrawlPages: 100,
    });

    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    // **Both paths this module calls are pinned**, because a wrong crawl URL would pass every
    // behavioural assertion here and fail only on a billed request. That is precisely the gap
    // the endpoint-path gate reported when this file first shipped.
    expect(requestUrl(fetchMock)).toContain("/v3/on_page/task_post");
    expect(requestUrl(fetchMock)).not.toContain("/on_page/tasks_post");
    expect(body[0]?.load_resources).toBe(true);
    expect(body[0]?.max_crawl_pages).toBe(100);
    // Browser rendering is 34x the price for Core Web Vitals, which the waterfall does not
    // return; content parsing would pay for a parse nobody reads here.
    expect(body[0]).not.toHaveProperty("enable_browser_rendering");
    expect(body[0]).not.toHaveProperty("enable_content_parsing");
  });

  it("returns the task id the waterfall read needs", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(taskCreated("task-1")),
    );
    const { data } = await postOnPageCrawlTaskForWaterfall({
      url: "https://example.com/",
      maxCrawlPages: 100,
    });
    expect(data.taskId).toBe("task-1");
  });

  it("fails loudly when the post returns no id, rather than yielding an unreadable task", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(taskCreated(undefined)),
    );
    await expect(
      postOnPageCrawlTaskForWaterfall({
        url: "https://example.com/",
        maxCrawlPages: 100,
      }),
    ).rejects.toThrow(/no task id/);
  });

  it("refuses a page count the vendor would reject, before spending anything", async () => {
    await expect(
      postOnPageCrawlTaskForWaterfall({
        url: "https://example.com/",
        maxCrawlPages: 0,
      }),
    ).rejects.toThrow(/positive integer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchOnPageWaterfall", () => {
  it("reads the task path, not a live one", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(waterfallEnvelope()),
    );
    await fetchOnPageWaterfall({
      taskId: "task-1",
      url: "https://example.com/",
    });

    const url = requestUrl(fetchMock);
    expect(url).toContain("/v3/on_page/waterfall");
    // The plausible wrong path, and the one I tried first: it 404s, because a waterfall only
    // exists for a crawl that already ran.
    expect(url).not.toContain("/on_page/waterfall/live");
  });

  it("addresses the crawl by task id and page", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(waterfallEnvelope()),
    );
    await fetchOnPageWaterfall({
      taskId: "task-1",
      url: "https://example.com/",
    });
    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]).toEqual({ id: "task-1", url: "https://example.com/" });
  });

  it("reports the crawl as still running rather than as an empty result", async () => {
    // The first read of a fresh crawl is genuinely partial, and a caller that treated it as
    // final would show a waterfall for a site that has barely been looked at.
    fetchMock.mockImplementation(async () =>
      Response.json(waterfallEnvelope()),
    );
    const { data } = await fetchOnPageWaterfall({
      taskId: "task-1",
      url: "https://example.com/",
    });
    expect(data.crawlProgress).toBe("in_progress");
  });

  it("reads the page timings and the per-resource timings", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(waterfallEnvelope()),
    );
    const { data } = await fetchOnPageWaterfall({
      taskId: "task-1",
      url: "https://example.com/",
    });

    const page = data.pages[0];
    expect(page?.waitingTimeMs).toBe(42);
    expect(page?.timeToInteractiveMs).toBe(644);
    expect(page?.resources[0]).toEqual({
      resourceType: "stylesheet",
      url: "https://example.com/app.css",
      initiator: "(index)",
      durationMs: 27,
      fetchStartMs: 36,
      fetchEndMs: 63,
      isRenderBlocking: true,
    });
  });

  it("keeps a resource the vendor did not measure as null, not zero", async () => {
    // Zero milliseconds and "no timing" are different claims, and a waterfall that draws the
    // first as an instant load is worse than one that leaves a gap.
    fetchMock.mockImplementation(async () =>
      Response.json(waterfallEnvelope()),
    );
    const { data } = await fetchOnPageWaterfall({
      taskId: "task-1",
      url: "https://example.com/",
    });

    const unmeasured = data.pages[0]?.resources[1];
    expect(unmeasured?.durationMs).toBeNull();
    expect(unmeasured?.isRenderBlocking).toBeNull();
  });

  it("requires both halves of the address", async () => {
    await expect(
      fetchOnPageWaterfall({ taskId: "  ", url: "https://example.com/" }),
    ).rejects.toThrow(/task id and the page URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
