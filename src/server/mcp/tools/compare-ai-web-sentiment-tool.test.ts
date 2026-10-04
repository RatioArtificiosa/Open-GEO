import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";
import type * as dataforseo from "@/server/lib/dataforseo";

// `withMcpProjectAuth` is mocked so these tests are about the tool's
// output, not authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

/**
 * Both seams are the **metered client**, not the raw fetchers: this tool spends
 * real credits twice, and the client's `meter` is what performs the balance
 * check and the usage record. Mocking a fetcher instead would produce tests that
 * pass against unmetered code.
 */
const contentSummary = vi.fn();
const serpTaskForSummary = vi.fn();
const aiSummary = vi.fn();
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

const { compareSentimentTool } =
  await import("@/server/mcp/tools/compare-ai-web-sentiment-tool");

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

const WEB_SUMMARY = {
  keyword: "crm software",
  countBasis:
    "Citation counts over DataForSEO's whole index for this keyword — not a sample of pages, and not an AI engine's view.",
  positiveShare: 0.6,
  polarity: { positive: 60, negative: 30, neutral: 10 },
};

const AI_ANSWER = "Suites dominate; buyers complain about migration cost.";

function useBothSides() {
  contentSummary.mockResolvedValue(WEB_SUMMARY);
  serpTaskForSummary.mockResolvedValue({
    taskId: "task-123",
    keyword: "crm software",
  });
  aiSummary.mockResolvedValue({ summary: AI_ANSWER, links: [], itemsCount: 1 });
  createDataforseoClient.mockReturnValue({
    serp: { contentSummary, serpTaskForSummary, aiSummary },
  });
}

describe("compare_ai_web_sentiment", () => {
  beforeEach(() => {
    contentSummary.mockReset();
    serpTaskForSummary.mockReset();
    aiSummary.mockReset();
    createDataforseoClient.mockReset();
  });

  it("reports the web's measured share and quotes the AI, never one number", async () => {
    useBothSides();

    const result = await callTool(compareSentimentTool, {
      keyword: "crm software",
      dry_run: false,
    });
    const text = textOf(result);

    expect(result.structuredContent?.web).toMatchObject({ share: 0.6 });
    // The AI side has **no** share. `ai_summary` returns prose, so reporting a
    // number there would be fabricating the half we do not have.
    expect(result.structuredContent?.ai).toMatchObject({ share: null });
    expect(result.structuredContent?.comparable).toBe(false);
    expect(text).toContain(AI_ANSWER);
  });

  it("says the two sides are not measured in the same units", async () => {
    useBothSides();

    const text = textOf(
      await callTool(compareSentimentTool, {
        keyword: "crm software",
        dry_run: false,
      }),
    );

    // The refusal is the deliverable: an average here would be arithmetic on
    // incompatible denominators.
    expect(text).toMatch(/not combined|not comparable|different measurements/i);
  });

  it("posts the SERP before asking, because the summary needs a real task id", async () => {
    // The first version passed a fabricated `${keyword}-web-compare` id, which
    // is a 40501 and a billed rejection. The order is the mechanism.
    useBothSides();

    await callTool(compareSentimentTool, {
      keyword: "crm software",
      dry_run: false,
    });

    expect(serpTaskForSummary).toHaveBeenCalledTimes(1);
    expect(aiSummary).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-123" }),
    );
  });

  it("reports a failed web read as a missing side, not a failed call", async () => {
    // "We could not read it" is more useful than a refusal, and the remaining
    // half stays honest rather than reading as agreement.
    contentSummary.mockRejectedValue(new Error("DataForSEO HTTP 503"));
    serpTaskForSummary.mockResolvedValue({
      taskId: "task-1",
      keyword: "crm software",
    });
    aiSummary.mockResolvedValue({
      summary: AI_ANSWER,
      links: [],
      itemsCount: 1,
    });
    createDataforseoClient.mockReturnValue({
      serp: { contentSummary, serpTaskForSummary, aiSummary },
    });

    const result = await callTool(compareSentimentTool, {
      keyword: "crm software",
      dry_run: false,
    });

    expect(result.structuredContent?.web).toMatchObject({
      share: null,
      unavailable: true,
    });
    // The AI side still ran, so the failure is partial rather than total.
    expect(aiSummary).toHaveBeenCalledTimes(1);
    expect(result.structuredContent?.direction).toBeNull();
  });

  it("skips the AI read entirely when webOnly is set", async () => {
    useBothSides();

    await callTool(compareSentimentTool, {
      keyword: "crm software",
      webOnly: true,
      dry_run: false,
    });

    expect(contentSummary).toHaveBeenCalledTimes(1);
    // Both steps skipped, and the SERP post is a billed call — it must not be
    // made for a side the caller asked not to have.
    expect(serpTaskForSummary).not.toHaveBeenCalled();
    expect(aiSummary).not.toHaveBeenCalled();
  });

  it("quotes both billed steps in the dry run", async () => {
    const result = await callTool(compareSentimentTool, {
      keyword: "crm software",
    });
    const structured = result.structuredContent ?? {};

    expect(structured.dryRun).toBe(true);
    // ~2 for the web side plus ~12 for the SERP post and the summary.
    expect(structured.estimatedCredits).toBe(14);
    expect(createDataforseoClient).not.toHaveBeenCalled();
  });

  it("quotes only the web side when webOnly is set", async () => {
    const result = await callTool(compareSentimentTool, {
      keyword: "crm software",
      webOnly: true,
    });

    expect(result.structuredContent?.estimatedCredits).toBe(2);
  });

  it("never offers a combined figure in its own output schema", async () => {
    // The last line of defence. The service refuses to produce one and
    // sentimentComparison.test.ts proves it; if a future edit adds a blended
    // field to the wire contract, this fails before a caller can read it.
    //
    // The field *names* are asserted rather than the schema's internals, so a
    // Zod version bump cannot make this fail for a reason nobody can act on.
    const shape = compareSentimentTool.config.outputSchema.def.shape;
    const names = Object.keys(shape).join(" ");
    expect(names).not.toMatch(/blended|combined|overall|total|net/i);
    expect(names).toMatch(/comparable/);
  });
});
