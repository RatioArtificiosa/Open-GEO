import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "encoded-credentials"),
  getOptionalEnvValue: vi.fn(async (name: string) =>
    name === "GEO_LLM_MODEL_CATALOG_TTL_HOURS" ? "24" : undefined,
  ),
}));

import {
  getLlmModels,
  isLlmModelSupported,
  resetLlmModelCatalogCache,
  resolveLlmModel,
  supportsWebSearch,
} from "@/server/lib/dataforseo/llm-models";

const CATALOG = [
  {
    model_name: "gpt-5",
    reasoning: true,
    web_search_supported: true,
    task_post_supported: true,
  },
  {
    model_name: "gpt-4o",
    reasoning: false,
    web_search_supported: true,
    task_post_supported: true,
  },
];

function modelsResponse(models: unknown[] = CATALOG) {
  return Response.json({
    version: "v3",
    status_code: 20000,
    tasks: [
      {
        id: "t1",
        status_code: 20000,
        cost: 0,
        path: ["v3", "ai_optimization", "chat_gpt", "llm_responses", "models"],
        result: models,
      },
    ],
  });
}

beforeEach(() => {
  resetLlmModelCatalogCache();
  fetchMock.mockReset();
});

afterEach(() => {
  resetLlmModelCatalogCache();
});

describe("LLM model catalog", () => {
  it("reads the live catalog instead of trusting a hardcoded list", async () => {
    fetchMock.mockResolvedValueOnce(modelsResponse());
    const models = await getLlmModels("chat_gpt");
    expect(models.map((m) => m.modelName)).toEqual(["gpt-5", "gpt-4o"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof Request ? url.url : JSON.stringify(url)).toContain(
      "/v3/ai_optimization/chat_gpt/llm_responses/models",
    );
  });

  it("caches the catalog, so a patrol does not re-fetch per prompt", async () => {
    fetchMock.mockResolvedValueOnce(modelsResponse());
    await getLlmModels("chat_gpt");
    await getLlmModels("chat_gpt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the capability flags through", async () => {
    fetchMock.mockResolvedValueOnce(modelsResponse());
    const [first] = await getLlmModels("chat_gpt");
    expect(first).toEqual({
      modelName: "gpt-5",
      reasoning: true,
      webSearchSupported: true,
      taskPostSupported: true,
    });
  });

  it("falls back to the documented snapshot when the catalog is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const models = await getLlmModels("claude");
    expect(models.map((m) => m.modelName)).toContain("claude-sonnet-4-5");
  });

  it("falls back rather than throwing on an empty catalog", async () => {
    fetchMock.mockResolvedValueOnce(modelsResponse([]));
    const models = await getLlmModels("gemini");
    expect(models.map((m) => m.modelName)).toContain("gemini-2.5-pro");
  });

  it("ignores malformed catalog entries instead of trusting them", async () => {
    fetchMock.mockResolvedValueOnce(
      modelsResponse([...CATALOG, { nonsense: true }]),
    );
    const models = await getLlmModels("chat_gpt");
    expect(models.map((m) => m.modelName)).toEqual(["gpt-5", "gpt-4o"]);
  });

  it("confirms a model is supported by checking the live catalog", async () => {
    fetchMock.mockResolvedValueOnce(modelsResponse());
    expect(await isLlmModelSupported("chat_gpt", "gpt-5")).toBe(true);
  });

  it("rejects an unknown model before a billed task is dispatched", async () => {
    fetchMock.mockResolvedValueOnce(modelsResponse());
    // DataForSEO charges for a task that fails with "Invalid Field:
    // 'model_name'", so this rejection must happen client-side.
    await expect(resolveLlmModel("chat_gpt", "gpt-99")).rejects.toThrow(
      /Unsupported DataForSEO model_name/,
    );
  });

  it("names the available models when it rejects one", async () => {
    fetchMock.mockResolvedValueOnce(modelsResponse());
    await expect(resolveLlmModel("chat_gpt", "gpt-99")).rejects.toThrow(
      /gpt-5, gpt-4o/,
    );
  });

  it("resolves a short alias to a dated version", async () => {
    fetchMock.mockResolvedValueOnce(
      modelsResponse([
        {
          model_name: "claude-sonnet-4-5-20250929",
          web_search_supported: true,
        },
      ]),
    );
    const model = await resolveLlmModel("claude", "claude-sonnet-4-5");
    expect(model.modelName).toBe("claude-sonnet-4-5-20250929");
  });

  it("reports whether a model accepts web search", async () => {
    fetchMock.mockResolvedValueOnce(
      modelsResponse([
        { model_name: "gpt-5", web_search_supported: false },
        { model_name: "gpt-4o", web_search_supported: true },
      ]),
    );
    expect(await supportsWebSearch("chat_gpt", "gpt-5")).toBe(false);
    expect(await supportsWebSearch("chat_gpt", "gpt-4o")).toBe(true);
  });
});
