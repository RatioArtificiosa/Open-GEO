import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  getLlmScraperTask,
  llmScraperTaskSchema,
  postLlmScraperTasks,
} from "@/server/lib/dataforseo/ai-scraper";
import { requestUrl } from "./test-support";

const TASK = {
  // Required: the queue changes the price, so the caller names it.
  priority: 1,
  keyword: "best crm",
  location_name: "United States",
  language_name: "English",
};

function envelope(result: unknown, statusCode = 20000, cost = 0.0012) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: statusCode,
        id: "task-1",
        data: { tag: "patrol" },
        path: ["v3", "ai_optimization", "chat_gpt", "llm_scraper"],
        cost,
        result: result === null ? null : [result],
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

describe("llm_scraper task submission", () => {
  it("posts to llm_scraper/task_post under the model slug", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope({ id: "task-1", tag: "patrol", cost: 0.0012 })),
    );

    const posted = await postLlmScraperTasks({
      se: "chat_gpt",
      tasks: [TASK],
    });

    const url = requestUrl(fetchMock);
    expect(url).toContain("/v3/ai_optimization/chat_gpt/llm_scraper/task_post");
    expect(url).not.toContain("llm_scraper/task_get/task");
    expect(posted.data.taskIds[0]).toBe("task-1");
    expect(posted.data.tags[0]).toBe("patrol");
  });

  it("refuses an empty batch rather than sending one, because the POST is billed", async () => {
    await expect(
      postLlmScraperTasks({ se: "chat_gpt", tasks: [] }),
    ).rejects.toThrow(/at least one task/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a keyword past the 2,000-character cap instead of truncating it", () => {
    const result = llmScraperTaskSchema.safeParse({
      location_name: "United States",
      language_name: "English",
      keyword: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe("llm_scraper task collection", () => {
  it("reads llm_scraper/task_get by encoded task id", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope({ items: [{ keyword: "best crm" }] })),
    );

    const collected = await getLlmScraperTask("chat_gpt", "task/1");
    expect(requestUrl(fetchMock)).toContain(
      "/v3/ai_optimization/chat_gpt/llm_scraper/task_get/advanced/task%2F1",
    );
    expect(collected.status).toBe("completed");
  });

  it("reports a pending task as pending rather than as a completed empty one", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope(null, 40602, 0)),
    );

    const collected = await getLlmScraperTask("chat_gpt", "task-2");
    expect(collected.status).toBe("pending");
  });
});
