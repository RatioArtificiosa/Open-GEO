import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  fetchOnPageContentParsing,
  postOnPageTaskForContentParsing,
} from "@/server/lib/dataforseo/on-page-content-parsing";
import { requestBody, requestUrl } from "./test-support";

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Response body can only be read once, so each call gets a fresh one. */
function envelope(body: unknown, httpStatus = 200): Response {
  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { "Content-Type": "application/json" },
  });
}

const TASK_CREATED = {
  status_code: 20000,
  status_message: "Ok.",
  time: 0.1,
  cost: 0.00015,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [
    {
      id: "07131248-1535-0216-1000-17384017ad04",
      status_code: 20100,
      status_message: "Task Created.",
      time: 0.1,
      cost: 0.00015,
      result_count: 0,
      path: ["v3", "on_page", "task_post"],
      result: null,
    },
  ],
};

const PARSED = {
  status_code: 20000,
  status_message: "Ok.",
  time: 0.16,
  cost: 0.000125,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [
    {
      id: "07131248-1535-0216-1000-17384017ad04",
      status_code: 20000,
      status_message: "Ok.",
      cost: 0.000125,
      result_count: 1,
      path: ["v3", "on_page", "content_parsing"],
      result: [
        {
          crawl_progress: "finished",
          items_count: 1,
          items: [
            {
              type: "content_parsing_element",
              status_code: 200,
              page_content: {
                primary_content: [
                  {
                    text: "DataForSEO parses the page.",
                    url: null,
                    urls: [
                      {
                        url: "https://example.com/docs",
                        anchor_text: "the docs",
                      },
                      {
                        url: "https://example.com/docs",
                        anchor_text: "the docs again",
                      },
                    ],
                  },
                  { text: "Second paragraph.", url: null, urls: null },
                ],
                secondary_content: null,
                table_content: null,
                main_topic: [
                  {
                    h_title: "The main heading",
                    main_title: "The main heading",
                    author: "Anatolii",
                    language: "en",
                    level: "1",
                  },
                  {
                    h_title: "A subsection",
                    main_title: "The main heading",
                    author: null,
                    language: null,
                    level: "10",
                  },
                ],
                page_as_markdown: "# The main heading",
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("postOnPageTaskForContentParsing", () => {
  it("posts to the documented task_post path", async () => {
    fetchMock.mockResolvedValueOnce(envelope(TASK_CREATED));

    await postOnPageTaskForContentParsing({ url: "https://example.com/page" });

    expect(requestUrl(fetchMock)).toContain("/v3/on_page/task_post");
  });

  it("always asks for content parsing, because the id is useless without it", async () => {
    fetchMock.mockResolvedValueOnce(envelope(TASK_CREATED));

    await postOnPageTaskForContentParsing({ url: "https://example.com/page" });

    // The whole pair depends on this flag. It defaults to false at the vendor, so
    // a caller who omits it gets a valid id and a read that cannot succeed.
    expect(requestBody(fetchMock)[0]).toMatchObject({
      url: "https://example.com/page",
      enable_content_parsing: true,
    });
  });

  it("returns the task id the read half needs", async () => {
    fetchMock.mockResolvedValueOnce(envelope(TASK_CREATED));

    const { data } = await postOnPageTaskForContentParsing({
      url: "https://example.com/page",
    });

    expect(data.taskId).toBe("07131248-1535-0216-1000-17384017ad04");
  });

  it("surfaces the task's own cost, not the price book's estimate", async () => {
    fetchMock.mockResolvedValueOnce(envelope(TASK_CREATED));

    const { billing } = await postOnPageTaskForContentParsing({
      url: "https://example.com/page",
    });

    expect(billing.costUsd).toBe(0.00015);
    expect(billing.path).toEqual(["v3", "on_page", "task_post"]);
  });

  it("refuses a blank url rather than sending a guaranteed rejection", async () => {
    await expect(
      postOnPageTaskForContentParsing({ url: "   " }),
    ).rejects.toThrow(/url is required/);
    // No money spent proving something we could know locally.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the task when the envelope is OK but the entry was refused", async () => {
    // 40501 arrives inside a 20000 envelope. Accepting the id would hand back a
    // task that does not exist and spend a second charge discovering it on the read.
    //
    // **Asserted on the message text, not the numeric code.** `assertOk` surfaces
    // the vendor's `status_message` and does not splice `status_code` into it, so
    // a `/40501/` assertion would be pinning a string this helper does not build.
    // The field name is the part that survives into a support ticket, so it is the
    // part worth pinning.
    fetchMock.mockResolvedValueOnce(
      envelope({
        ...TASK_CREATED,
        tasks: [
          {
            ...TASK_CREATED.tasks[0],
            status_code: 40501,
            status_message: "Invalid Field: enable_content_parsing.",
            result: [{ status_code: 40501 }],
          },
        ],
      }),
    );

    await expect(
      postOnPageTaskForContentParsing({ url: "https://example.com/page" }),
    ).rejects.toThrow(/Invalid Field: enable_content_parsing/);
  });

  it("fails loudly when the post returns no id, rather than handing on an empty one", async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({
        ...TASK_CREATED,
        tasks: [{ ...TASK_CREATED.tasks[0], id: undefined }],
      }),
    );

    await expect(
      postOnPageTaskForContentParsing({ url: "https://example.com/page" }),
    ).rejects.toThrow(/no task id/);
  });

  it("does not retry an HTTP 5xx, because the provider may already have charged it", async () => {
    fetchMock.mockResolvedValueOnce(envelope({}, 503));

    await expect(
      postOnPageTaskForContentParsing({ url: "https://example.com/page" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("fetchOnPageContentParsing", () => {
  it("posts to the documented content_parsing path", async () => {
    fetchMock.mockResolvedValueOnce(envelope(PARSED));

    await fetchOnPageContentParsing({ taskId: "task-1" });

    expect(requestUrl(fetchMock)).toContain("/v3/on_page/content_parsing");
  });

  it("refuses an empty task id before spending a second charge", async () => {
    await expect(fetchOnPageContentParsing({ taskId: " " })).rejects.toThrow(
      /task_id is required/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the heading structure, coercing the vendor's string level to a number", async () => {
    fetchMock.mockResolvedValueOnce(envelope(PARSED));

    const { data } = await fetchOnPageContentParsing({ taskId: "task-1" });

    // The fixture sends "1" and "10". As strings "10" sorts before "2", so a
    // consumer comparing levels as-is gets a page whose hierarchy looks inverted.
    expect(data.headings).toEqual([
      {
        title: "The main heading",
        level: 1,
        author: "Anatolii",
        language: "en",
      },
      { title: "A subsection", level: 10, author: null, language: null },
    ]);
  });

  it("joins primary content and dedupes links, keeping the first anchor", async () => {
    fetchMock.mockResolvedValueOnce(envelope(PARSED));

    const { data } = await fetchOnPageContentParsing({ taskId: "task-1" });

    expect(data.primaryText).toBe(
      "DataForSEO parses the page.\nSecond paragraph.",
    );
    expect(data.links).toEqual([
      { url: "https://example.com/docs", anchor: "the docs" },
    ]);
  });

  it("reports an empty structure rather than failing when the page had no content", async () => {
    // A real response for a thin page: the elements are null, not absent. Reading
    // that as an error would make "this page is empty" indistinguishable from
    // "our parse broke", which are opposite findings.
    fetchMock.mockResolvedValueOnce(
      envelope({
        ...PARSED,
        tasks: [
          {
            ...PARSED.tasks[0],
            result: [
              {
                crawl_progress: "finished",
                items_count: 1,
                items: [{ page_content: {} }],
              },
            ],
          },
        ],
      }),
    );

    const { data } = await fetchOnPageContentParsing({ taskId: "task-1" });

    expect(data.headings).toEqual([]);
    expect(data.primaryText).toBe("");
    expect(data.links).toEqual([]);
    expect(data.markdown).toBeNull();
  });

  it("does not request markdown unless asked, because the field is large", async () => {
    fetchMock.mockResolvedValueOnce(envelope(PARSED));

    await fetchOnPageContentParsing({ taskId: "task-1" });

    expect(requestBody(fetchMock)[0]).toMatchObject({ markdown_view: false });

    fetchMock.mockResolvedValueOnce(envelope(PARSED));
    await fetchOnPageContentParsing({ taskId: "task-1", markdownView: true });
    expect(requestBody(fetchMock, 1)[0]).toMatchObject({ markdown_view: true });
  });

  it("surfaces the read's own cost, which is separate from the crawl that created it", async () => {
    fetchMock.mockResolvedValueOnce(envelope(PARSED));

    const { billing } = await fetchOnPageContentParsing({ taskId: "task-1" });

    // Two charges exist for one parse: the post and this read. Collapsing them is
    // how a read gets mistaken for a free collection and goes unmetered.
    expect(billing.costUsd).toBe(0.000125);
    expect(billing.path).toEqual(["v3", "on_page", "content_parsing"]);
  });

  it("rejects a payload whose shape it does not recognise", async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({
        ...PARSED,
        tasks: [{ ...PARSED.tasks[0], result: [{ items: "not-an-array" }] }],
      }),
    );

    await expect(
      fetchOnPageContentParsing({ taskId: "task-1" }),
    ).rejects.toThrow(/unexpected payload/);
  });

  it("rejects a task the vendor refused, rather than returning an empty page", async () => {
    // 40400 is "task not found" — the shape a 30-day-expired or mistyped id gives.
    // Returning empty headings here would read as "the page had no structure",
    // which is a finding a customer would act on and which is entirely false.
    fetchMock.mockResolvedValueOnce(
      envelope({
        ...PARSED,
        tasks: [
          {
            ...PARSED.tasks[0],
            status_code: 40400,
            status_message: "Task not found.",
            result: [],
          },
        ],
      }),
    );

    await expect(
      fetchOnPageContentParsing({ taskId: "expired" }),
    ).rejects.toThrow(/Task not found/);
  });
});
