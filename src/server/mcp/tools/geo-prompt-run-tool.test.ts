import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";
import type * as dataforseoAi from "@/server/lib/dataforseo/ai";
import type * as dataforseoLlmModels from "@/server/lib/dataforseo/llm-models";

// `withMcpProjectAuth` is mocked so these tests are about the tool's
// output, not authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// The two vendor seams the live path calls: model resolution and the
// LLM Responses fetch. Both are replaced so the test resolves a shaped
// answer instead of hitting DataForSEO.
const fetchLlmResponse = vi.fn();
const resolveLlmModel = vi.fn();
vi.mock("@/server/lib/dataforseo/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof dataforseoAi>();
  return { ...actual, fetchLlmResponse };
});
vi.mock("@/server/lib/dataforseo/llm-models", async (importOriginal) => {
  const actual = await importOriginal<typeof dataforseoLlmModels>();
  return { ...actual, resolveLlmModel };
});

vi.mock("@/server/mcp/project-auth", () => ({
  withMcpProjectAuth:
    (
      handler: (
        args: Record<string, unknown>,
        context: Record<string, unknown>,
      ) => unknown,
    ) =>
    async (
      args: Record<string, unknown>,
      toolContext: { auth: Record<string, unknown> },
    ) =>
      handler(args, {
        auth: toolContext.auth,
        baseUrl: "https://open-geo.test",
        organizationId: "org_123",
        project: {
          id: "p1",
          name: "Acme",
          locationCode: 2840,
          languageCode: "en",
        },
        billing: { organizationId: "org_123" },
      }),
  requireProjectAccess: vi.fn(),
}));

const { geoPromptRunTool } =
  await import("@/server/mcp/tools/geo-prompt-run-tool");

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

function textOf(result: ToolResult) {
  return textContent(result);
}

async function callTool(
  tool: { handler: unknown },
  data: Record<string, unknown>,
): Promise<ToolResult> {
  // **Imported dynamically, the concrete handler type is not visible here; this widens
  // `unknown` to the one shape the MCP server guarantees.**
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const handler = tool.handler as (
    args: Record<string, unknown>,
    context: unknown,
  ) => Promise<ToolResult>;
  return handler({ projectId: "p1", ...data }, makeToolContext());
}

const MODEL = {
  modelName: "gpt-5.2",
  reasoning: false,
  webSearchSupported: true,
  taskPostSupported: true,
};

function llmResponse() {
  return {
    data: {
      answer: "OpenGeo is a generative-engine-optimization audit tool.",
      citations: [
        { url: "https://opengeo.example", title: "OpenGeo", text: null },
        { url: "https://example.com/guide", title: null, text: "A guide" },
      ],
    },
    billing: {
      path: ["v3", "llm_mentions", "response", "live"],
      costUsd: 0.0006,
    },
  };
}

describe("geo_prompt_run", () => {
  it("returns the model's answer with its citations", async () => {
    resolveLlmModel.mockResolvedValue(MODEL);
    fetchLlmResponse.mockResolvedValue(llmResponse());

    const result = await callTool(geoPromptRunTool, {
      prompt: "What is OpenGeo?",
      platform: "chat_gpt",
      modelName: "gpt-5.2",
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toContain(
      "OpenGeo is a generative-engine-optimization audit tool.",
    );
    expect(text).toContain("Citations (2)");
    expect(text).toContain("opengeo.example");

    // The resolved model is what gets sent, not the raw alias.
    expect(resolveLlmModel).toHaveBeenCalledWith("chat_gpt", "gpt-5.2");
    expect(fetchLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: "gpt-5.2" }),
    );

    const structured = result.structuredContent ?? {};
    expect(structured.answer).toBe(
      "OpenGeo is a generative-engine-optimization audit tool.",
    );
    expect(structured.citations).toHaveLength(2);
  });

  it("says there are no citations rather than inventing them", async () => {
    resolveLlmModel.mockResolvedValue(MODEL);
    fetchLlmResponse.mockResolvedValue({
      data: { answer: "No sources to cite.", citations: [] },
      billing: { path: [], costUsd: 0.0006 },
    });

    const text = textOf(
      await callTool(geoPromptRunTool, {
        prompt: "What is OpenGeo?",
        platform: "chat_gpt",
        modelName: "gpt-5.2",
        dry_run: false,
      }),
    );

    expect(text).toContain("No sources to cite.");
    expect(text).not.toMatch(/Citations \(/);
  });

  it("previews the cost without calling the vendor on a dry run", async () => {
    const result = await callTool(geoPromptRunTool, {
      prompt: "What is OpenGeo?",
      platform: "chat_gpt",
      modelName: "gpt-5.2",
    });
    const structured = result.structuredContent ?? {};

    expect(structured.dryRun).toBe(true);
    // The base fee in credits; the provider's token cost is variable and
    // is stated in the text rather than folded into a flat number.
    expect(structured.estimatedCredits).toBe(0.6);
    expect(textOf(result)).toMatch(/base fee/i);
    expect(fetchLlmResponse).not.toHaveBeenCalled();
    expect(resolveLlmModel).not.toHaveBeenCalled();
  });
});
