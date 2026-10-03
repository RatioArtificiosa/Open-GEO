import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";
import type * as dataforseo from "@/server/lib/dataforseo";

// `withMcpProjectAuth` is mocked so these tests are about the tool's
// output, not authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// The metered client is the seam: the tool reaches DataForSEO through
// `client.serp.aiMode`, which is what performs the credit check and the
// usage record. Mocking the raw fetcher instead would let the tool call
// the vendor without metering and the test would not notice.
const aiMode = vi.fn();
const createDataforseoClient = vi.fn();
vi.mock("@/server/lib/dataforseo", async (importOriginal) => {
  const actual = await importOriginal<typeof dataforseo>();
  return { ...actual, createDataforseoClient };
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

const { aiModeQueryTool } =
  await import("@/server/mcp/tools/ai-mode-query-tool");

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

/**
 * What the metered client resolves: the unwrapped answer, because
 * `meter` returns `result.data` to its caller.
 */
function aiModeAnswer() {
  return {
    keyword: "best geo tool",
    locationCode: 2840,
    languageCode: "en",
    datetime: "2026-10-03T12:00:00Z",
    checkUrl: "https://google.com/search?udm=48",
    elementTypes: ["text", "shopping"],
    elements: [
      {
        type: "text",
        position: "1",
        title: "Answer",
        text: null,
        markdown: "OpenGeo is a generative-engine-optimization tool.",
        references: [
          {
            type: "source",
            source: "reddit",
            domain: "reddit.com",
            url: "https://reddit.com/r/seo",
            title: "Reddit",
            text: null,
          },
        ],
      },
    ],
    references: [
      {
        type: "source",
        source: "reddit",
        domain: "reddit.com",
        url: "https://reddit.com/r/seo",
        title: "Reddit",
        text: null,
      },
    ],
  };
}

/** Point the metered client at the AI Mode seam before a live call. */
function useAiModeAnswer() {
  aiMode.mockResolvedValue(aiModeAnswer());
  createDataforseoClient.mockReturnValue({ serp: { aiMode } });
}

describe("ai_mode_query", () => {
  it("returns the AI Mode answer with its elements and citations", async () => {
    useAiModeAnswer();

    const result = await callTool(aiModeQueryTool, {
      keyword: "best geo tool",
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toContain("best geo tool");
    expect(text).toContain("OpenGeo is a generative-engine-optimization tool.");
    expect(text).toContain("total citations: 1");
    // An element's own references render inline; the top-level set is
    // the de-duplicated citation set the structured content carries.
    expect(text).toContain("Reddit (https://reddit.com/r/seo)");

    // Defaults come from the project context, not a hardcoded market,
    // and the call goes through the metered client rather than the raw
    // fetcher — an unmetered call would spend credits with no balance
    // check and no usage record.
    expect(aiMode).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "best geo tool",
        locationCode: 2840,
        languageCode: "en",
      }),
    );
    expect(createDataforseoClient).toHaveBeenCalled();

    const structured = result.structuredContent ?? {};
    expect(structured.keyword).toBe("best geo tool");
    expect(structured.elements).toHaveLength(1);
    expect(structured.references).toMatchObject([{ domain: "reddit.com" }]);
  });

  it("honours an explicit market override", async () => {
    useAiModeAnswer();

    await callTool(aiModeQueryTool, {
      keyword: "best geo tool",
      locationCode: 2849,
      languageCode: "es",
      dry_run: false,
    });

    expect(aiMode).toHaveBeenCalledWith(
      expect.objectContaining({
        locationCode: 2849,
        languageCode: "es",
      }),
    );
  });

  it("previews the cost without calling the vendor on a dry run", async () => {
    const result = await callTool(aiModeQueryTool, {
      keyword: "best geo tool",
    });
    const structured = result.structuredContent ?? {};

    expect(structured.dryRun).toBe(true);
    expect(structured.estimatedCredits).toBe(4);
    expect(textOf(result)).toMatch(/dry run/i);
    expect(aiMode).not.toHaveBeenCalled();
  });
});
