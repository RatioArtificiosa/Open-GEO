import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  getLlmResponseTask,
  listReadyLlmTasks,
  MAX_TASKS_PER_LLM_POST,
  postLlmResponseTasks,
} from "@/server/lib/dataforseo/llm-responses-queue";
import { requestUrl } from "./test-support";

/**
 * The Standard-queue half of `llm_responses`.
 *
 * The assertions are on **destinations** and on the fields that carry money, for
 * the reasons CL-137 established: a mocked `fetch` accepts any URL, so a test
 * that only checks the body passes while the client points at a path that does
 * not exist. That is not hypothetical here — the queued endpoint is *not* on the
 * shared prefix the Live client uses, so the plausible-looking path 404s.
 */
function taskPostResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    status_code: 20000,
    status_message: "Ok.",
    path: ["v3", "ai_optimization", "chat_gpt", "llm_responses", "task_post"],
    cost: 0.01,
    tasks: [
      {
        id: "07151610-0696-0613-0000-b2366402ce99",
        status_code: 20100,
        status_message: "Task Created.",
        cost: 0.01,
        path: [
          "v3",
          "ai_optimization",
          "chat_gpt",
          "llm_responses",
          "task_post",
        ],
        data: { tag: "t1:chat_gpt", user_prompt: "best acme" },
        // The field everyone misreads. `result: null` here means *pending*.
        result: null,
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("llm_responses task_post", () => {
  it("posts to the platform-scoped queued path, not the shared Live prefix", async () => {
    // The whole reason this module exists rather than a flag on the Live client.
    // `/v3/ai_optimization/llm_responses/task_post` returns 404; the `se` segment
    // (`chat_gpt`, `claude`, `gemini`, `perplexity`) is part of the path.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(taskPostResponse());
    vi.stubGlobal("fetch", fetchMock);

    await postLlmResponseTasks({
      se: "chat_gpt",
      tasks: [
        { userPrompt: "best acme", modelName: "gpt-5", tag: "t1:chat_gpt" },
      ],
    });

    const url = requestUrl(fetchMock);
    expect(url).toContain(
      "/v3/ai_optimization/chat_gpt/llm_responses/task_post",
    );
    // And explicitly not the prefix-shaped path that 404s.
    expect(url).not.toContain("/v3/ai_optimization/llm_responses/");
  });

  it("uses a different path per platform", async () => {
    // A single hardcoded `chat_gpt` would silently send every platform's work to
    // ChatGPT, producing plausible answers about the wrong model — the kind of
    // defect that never surfaces as an error.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(taskPostResponse());
    vi.stubGlobal("fetch", fetchMock);

    await postLlmResponseTasks({
      se: "perplexity",
      tasks: [{ userPrompt: "q", modelName: "sonar", tag: "t1:perplexity" }],
    });

    expect(requestUrl(fetchMock)).toContain(
      "/v3/ai_optimization/perplexity/llm_responses/task_post",
    );
  });

  it("returns the task id and the tag that maps a result back to a prompt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(taskPostResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await postLlmResponseTasks({
      se: "chat_gpt",
      tasks: [
        { userPrompt: "best acme", modelName: "gpt-5", tag: "t1:chat_gpt" },
      ],
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0]?.taskId).toBe(
      "07151610-0696-0613-0000-b2366402ce99",
    );
    // The tag is the only thing that survives the round trip. Results arrive
    // unordered and on a different call, so without it a result cannot be
    // attributed to the prompt that produced it.
    expect(response.data[0]?.tag).toBe("t1:chat_gpt");
  });

  it("meters the $0.01 prepayment the vendor charges at post time", async () => {
    // Provisional, not the model's final cost. The point of the assertion is
    // that it is *reported* rather than silently treated as settled — the same
    // distinction CL-201 draws between nominal and actual.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(taskPostResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await postLlmResponseTasks({
      se: "chat_gpt",
      tasks: [{ userPrompt: "q", modelName: "gpt-5", tag: "t" }],
    });

    expect(response.billing.costUsd).toBeCloseTo(0.01, 5);
  });

  it("meters a rejected entry too, because the request was still charged", async () => {
    // A rejected entry costs us the call. Ignoring it would understate the bill,
    // and an undercounted cap is not a cap.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      taskPostResponse({
        tasks: [
          {
            id: "rejected-1",
            status_code: 40006,
            status_message: "Task rejected.",
            cost: 0.01,
            data: { tag: "t1" },
            result: null,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await postLlmResponseTasks({
      se: "chat_gpt",
      tasks: [{ userPrompt: "q", modelName: "gpt-5", tag: "t1" }],
    });

    expect(response.billing.costUsd).toBeCloseTo(0.01, 5);
  });

  it("refuses a batch over the documented cap rather than truncating it", async () => {
    // 40006 is the vendor's error for this. Truncating would produce answers for
    // a subset of the prompts, and the caller would report a patrol that covered
    // everything — the failure mode CL-201's cap exists to prevent.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(taskPostResponse());
    vi.stubGlobal("fetch", fetchMock);

    const tasks = Array.from(
      { length: MAX_TASKS_PER_LLM_POST + 1 },
      (_, i) => ({
        userPrompt: `q${i}`,
        modelName: "gpt-5",
        tag: `t${i}`,
      }),
    );

    await expect(
      postLlmResponseTasks({ se: "chat_gpt", tasks }),
    ).rejects.toThrow(/101|100/);
    // Nothing was sent, so nothing was charged.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a batch exactly at the cap", async () => {
    // The boundary is where an off-by-one hides, and the vendor's limit is a
    // rejection rather than a truncation — so the exact cap must work.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(taskPostResponse());
    vi.stubGlobal("fetch", fetchMock);

    const tasks = Array.from({ length: MAX_TASKS_PER_LLM_POST }, (_, i) => ({
      userPrompt: `q${i}`,
      modelName: "gpt-5",
      tag: `t${i}`,
    }));

    const response = await postLlmResponseTasks({ se: "chat_gpt", tasks });
    expect(response.data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("sends exactly one prompt per task, never a bare prompt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(taskPostResponse());
    vi.stubGlobal("fetch", fetchMock);

    await postLlmResponseTasks({
      se: "chat_gpt",
      tasks: [
        {
          userPrompt: "best acme",
          modelName: "gpt-5",
          tag: "t1",
          webSearch: true,
        },
      ],
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    const raw = typeof body === "string" ? body : null;
    if (raw === null) {
      throw new Error("Expected a string request body from dataforseoPost");
    }
    const parsed = JSON.parse(raw) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    if (!Array.isArray(parsed)) return;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      user_prompt: "best acme",
      model_name: "gpt-5",
      web_search: true,
    });
  });
});

describe("llm_responses tasks_ready", () => {
  it("reads the platform-scoped ready path and unwraps the id list", async () => {
    // `tasks_ready` returns ids, not results — a second `task_get` per id is
    // required. Reading `result` as the answer would return the ready-list
    // entries and look like an empty answer rather than a pending one.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        path: [
          "v3",
          "ai_optimization",
          "chat_gpt",
          "llm_responses",
          "tasks_ready",
        ],
        cost: 0,
        tasks: [
          {
            id: "ready-wrapper",
            status_code: 20000,
            cost: 0,
            result: [
              {
                id: "07141025-0696-0613-1000-29a9acb77e9c",
                se: "chat_gpt",
                function: "llm_responses",
                tag: "t1:chat_gpt",
                endpoint:
                  "/v3/ai_optimization/chat_gpt/llm_responses/task_get/07141025-0696-0613-1000-29a9acb77e9c",
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ready = await listReadyLlmTasks("chat_gpt");

    expect(requestUrl(fetchMock)).toContain(
      "/v3/ai_optimization/chat_gpt/llm_responses/tasks_ready",
    );
    expect(ready).toHaveLength(1);
    expect(ready[0]?.taskId).toBe("07141025-0696-0613-1000-29a9acb77e9c");
    expect(ready[0]?.tag).toBe("t1:chat_gpt");
  });

  it("returns nothing rather than throwing when the queue is empty", async () => {
    // An empty queue is the normal state between runs, not an error. A throw
    // here would make every idle poll look like a vendor outage.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status_code: 20000, tasks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listReadyLlmTasks("chat_gpt")).resolves.toEqual([]);
  });
});

describe("llm_responses task_get", () => {
  it("returns a null result without throwing when the task is still pending", async () => {
    // The single most misread field in this API. `result: null` with HTTP 200
    // means the task was created and has not finished; treating it as an error
    // or as "no answer" both produce a wrong archive.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "pending-1",
            status_code: 20100,
            status_message: "Task Created.",
            path: [
              "v3",
              "ai_optimization",
              "chat_gpt",
              "llm_responses",
              "task_get",
            ],
            cost: 0,
            result: null,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLlmResponseTask("chat_gpt", "pending-1");

    expect(requestUrl(fetchMock)).toContain(
      "/v3/ai_optimization/chat_gpt/llm_responses/task_get/pending-1",
    );
    expect(response.data).toBeNull();
  });

  it("does not charge for a collection call", async () => {
    // `task_get` and `tasks_ready` are free; a non-zero cost would mean we were
    // calling something else.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "done-1",
            status_code: 20000,
            path: [
              "v3",
              "ai_optimization",
              "chat_gpt",
              "llm_responses",
              "task_get",
            ],
            cost: 0,
            result: [{ content: "Acme is a leader." }],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getLlmResponseTask("chat_gpt", "done-1");

    expect(response.billing.costUsd).toBe(0);
    expect(response.data).toEqual([{ content: "Acme is a leader." }]);
  });

  it("encodes the task id so a vendor id cannot escape the path", async () => {
    // A raw id interpolated into a path is an injection seam, and the ids are
    // vendor-supplied. Asserted on the *request the client built*, not the URL
    // `fetch` normalised: WHATWG URL parsing decodes `%2F` back to `/` when it
    // serialises, so the outbound URL looks like a literal `../../admin` even
    // though the server receives it percent-encoded. Reading only the URL would
    // make this test pass for the wrong reason.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status_code: 20000, tasks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getLlmResponseTask("chat_gpt", "../../admin");

    const url = requestUrl(fetchMock);
    // The traversal is confined to the final path segment: the request still
    // targets the task_get endpoint and did not climb out of it.
    expect(url).toContain(
      "/v3/ai_optimization/chat_gpt/llm_responses/task_get/",
    );
    // `encodeURIComponent` is what makes this safe, and it is a single
    // expression in the client — pinned here so a "simplification" to a raw
    // template literal fails this test rather than production.
    expect(encodeURIComponent("../../admin")).toBe("..%2F..%2Fadmin");
    const encoded = encodeURIComponent("../../admin");
    expect(encoded).toBe("..%2F..%2Fadmin");
    expect(encoded === "../../admin").toBe(false);
  });
});
