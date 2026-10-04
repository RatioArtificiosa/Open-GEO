import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  AI_SUMMARY_PROMPT_MAX,
  fetchAiSummary,
  postSerpTaskForSummary,
} from "@/server/lib/dataforseo/ai-summary";
import { requestBody, requestUrl } from "./test-support";

function summaryEnvelope(summary: string | null, cost = 0.01) {
  return {
    status_code: 20000,
    tasks: [
      {
        id: "07031743-1535-0559-0000-6e58e03c9a8a",
        status_code: 20000,
        path: ["v3", "serp", "ai_summary"],
        cost,
        result_count: 1,
        result: [
          {
            items_count: 1,
            items: [{ summary }],
          },
        ],
      },
    ],
  };
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  // A fresh Response per call: a Response body can only be read once.
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postSerpTaskForSummary", () => {
  it("posts to the SERP task_post endpoint and returns the task id", async () => {
    // **The whole reason this function exists.** `ai_summary` cannot be called
    // without an id from a prior SERP POST, and DataForSEO keeps that id valid
    // for 30 days — so the id has to be captured at post time or not at all.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              id: "07031739-1535-0139-0000-9d1e639a5b7d",
              status_code: 20100,
              path: ["v3", "serp", "google", "organic", "task_post"],
              cost: 0.002,
            },
          ],
        }),
      ),
    );

    const { data, billing } = await postSerpTaskForSummary({
      keyword: "best geo tool",
      locationCode: 2840,
      languageCode: "en",
    });

    expect(data.taskId).toBe("07031739-1535-0139-0000-9d1e639a5b7d");
    expect(data.keyword).toBe("best geo tool");
    expect(billing.costUsd).toBe(0.002);

    // **The URL is asserted, not just the body** — this directory's own
    // history is 14 green tests over a client pointing at a path that does not
    // exist, so the destination is the thing worth pinning.
    expect(requestUrl(fetchMock)).toContain(
      "/v3/serp/google/organic/task_post",
    );
    expect(requestBody(fetchMock)[0]).toMatchObject({
      keyword: "best geo tool",
      location_code: 2840,
      language_code: "en",
    });
  });

  it("posts depth 10, because the extra pages are billed whether or not anyone asks", async () => {
    // The task here exists only to obtain an id. Every page beyond the first is
    // billed at post time and may never be read, so depth is pinned to one page.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              id: "task-1",
              status_code: 20100,
              path: ["v3", "serp", "google", "organic", "task_post"],
              cost: 0.002,
            },
          ],
        }),
      ),
    );

    await postSerpTaskForSummary({
      keyword: "best geo tool",
      locationCode: 2840,
      languageCode: "en",
    });

    expect(requestUrl(fetchMock)).toContain(
      "/v3/serp/google/organic/task_post",
    );
    expect(requestBody(fetchMock)[0]).toMatchObject({ depth: 10 });
  });

  it("rejects the task when the envelope is OK but the entry was refused", async () => {
    // **The finding CodeRabbit made.** A request-level 20000 says nothing about
    // the task: a 40501 "Invalid Field" arrives *inside* a 20000 envelope, and
    // the post is billed either way. Accepting the id here would hand back a
    // task that does not exist and spend 10 more credits finding out.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              id: "07031739-1535-0139-0000-9d1e639a5b7d",
              status_code: 40501,
              status_message: "Invalid Field: check the request data.",
              path: ["v3", "serp", "google", "organic", "task_post"],
              cost: 0.002,
            },
          ],
        }),
      ),
    );

    await expect(
      postSerpTaskForSummary({
        keyword: "best geo tool",
        locationCode: 2840,
        languageCode: "en",
      }),
    ).rejects.toThrow(/40501[\s\S]*Invalid Field/);
  });

  it("fails loudly when the post returns no id, rather than handing on an empty one", async () => {
    // A post with no id produced no task, so there is nothing to ask. Passing an
    // empty id downstream would turn this into a 40501 on the *next* billed call.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              status_code: 20100,
              path: ["v3", "serp", "google", "organic", "task_post"],
              cost: 0.002,
            },
          ],
        }),
      ),
    );

    await expect(
      postSerpTaskForSummary({
        keyword: "best geo tool",
        locationCode: 2840,
        languageCode: "en",
      }),
    ).rejects.toThrow(/no task id/);
  });
});

describe("fetchAiSummary", () => {
  const base = {
    taskId: "07031739-1535-0139-0000-9d1e639a5b7d",
    prompt: "which tools do agencies use for AI visibility?",
  };

  it("posts to serp/ai_summary and returns the model's prose", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          summaryEnvelope("Agencies mostly use suite tools, with OpenGeo new."),
        ),
      ),
    );

    const { data, billing } = await fetchAiSummary(base);

    expect(data.summary).toContain("Agencies mostly use suite tools");
    expect(billing.costUsd).toBe(0.01);

    expect(requestUrl(fetchMock)).toContain("/v3/serp/ai_summary");
    expect(requestBody(fetchMock)[0]).toMatchObject({
      task_id: base.taskId,
      prompt: base.prompt,
    });
  });

  it("refuses an over-long prompt before spending, because a rejection is billed", async () => {
    // DataForSEO charges for the task that fails, so a length check that only
    // ran server-side would cost a cent to learn something we already know.
    await expect(
      fetchAiSummary({
        ...base,
        prompt: "x".repeat(AI_SUMMARY_PROMPT_MAX + 1),
      }),
    ).rejects.toThrow(/2000 characters or fewer/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a blank prompt and an empty task id rather than sending either", async () => {
    await expect(fetchAiSummary({ ...base, prompt: "   " })).rejects.toThrow(
      /prompt is required/,
    );
    await expect(fetchAiSummary({ ...base, taskId: "  " })).rejects.toThrow(
      /task_id is required/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves fetch_content off by default, because it bills page fetches beyond the $0.01", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(summaryEnvelope("A summary."))),
    );

    await fetchAiSummary(base);

    expect(requestBody(fetchMock)[0]).toMatchObject({
      fetch_content: false,
    });
  });

  it("extracts the cited links the model placed in its prose", async () => {
    // The vendor appends `[title](url)` markdown when include_links is true.
    // Recovering them gives a caller something citable, and the prose keeps
    // them too — where the model chose to put a citation is part of the answer.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          summaryEnvelope(
            "Agencies use suites. [Reddit](https://reddit.com/r/seo) agrees. [G2](https://g2.com/categories) too.",
          ),
        ),
      ),
    );

    const { data } = await fetchAiSummary(base);

    expect(data.links).toEqual([
      { title: "Reddit", url: "https://reddit.com/r/seo" },
      { title: "G2", url: "https://g2.com/categories" },
    ]);
    // The prose is untouched — the model placed those citations, not us.
    expect(data.summary).toContain("[Reddit](https://reddit.com/r/seo)");
  });

  it("reports an uncited summary as citing nothing, not as a parse failure", async () => {
    // "No links" and "we failed to parse" are different states and only the
    // first is honest here.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(summaryEnvelope("No sources were used."))),
    );

    const { data } = await fetchAiSummary(base);

    expect(data.summary).toBe("No sources were used.");
    expect(data.links).toEqual([]);
  });

  it("survives a summary the vendor returned as null", async () => {
    // An absent summary is an absence, not a crash — and reporting it as an
    // empty string is what keeps a caller from rendering a quotation.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(summaryEnvelope(null))),
    );

    const { data } = await fetchAiSummary(base);

    expect(data.summary).toBe("");
    expect(data.links).toEqual([]);
  });

  it("de-duplicates a URL the model cited twice", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          summaryEnvelope(
            "One source. [Reddit](https://reddit.com/r/seo) Also [r/SEO](https://reddit.com/r/seo) again.",
          ),
        ),
      ),
    );

    const { data } = await fetchAiSummary(base);

    expect(data.links).toHaveLength(1);
    expect(data.links[0]).toMatchObject({ url: "https://reddit.com/r/seo" });
  });
});
