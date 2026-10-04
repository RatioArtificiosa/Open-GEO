import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";
import type * as dataforseo from "@/server/lib/dataforseo";

// `withMcpProjectAuth` is mocked so these tests are about the tool's
// output, not authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// **The metered client is the seam, and this file's reason for existing.**
// serp_ask makes two billed calls; both go through `client.serp`, which is what
// performs the credit check and the usage record. Mocking the raw fetchers
// instead would produce tests that PASS against unmetered code — which is the
// defect CodeRabbit found in the previous milestone's tools.
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

const { serpAskTool } = await import("@/server/mcp/tools/serp-ask-tool");

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

const QUESTION = "which tools do agencies use for AI visibility?";

/** What the metered client resolves — unwrapped, because `meter` returns `.data`. */
function useVendorResult(
  summary = "Agencies mostly use suite tools. [Reddit](https://reddit.com/r/seo) agrees.",
  links: Array<{ title: string; url: string }> = [
    { title: "Reddit", url: "https://reddit.com/r/seo" },
  ],
) {
  serpTaskForSummary.mockResolvedValue({
    taskId: "task-123",
    keyword: "best geo tool",
  });
  aiSummary.mockResolvedValue({ summary, links, itemsCount: 1 });
  createDataforseoClient.mockReturnValue({
    serp: { serpTaskForSummary, aiSummary },
  });
}

describe("serp_ask", () => {
  it("posts the SERP, then asks it, through the metered client", async () => {
    useVendorResult();

    const result = await callTool(serpAskTool, {
      keyword: "best geo tool",
      prompt: QUESTION,
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toContain("Agencies mostly use suite tools");

    // The order matters: the summary is only callable with the id the post
    // returned, so passing the id between them is the whole mechanism.
    expect(serpTaskForSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "best geo tool",
        locationCode: 2840,
        languageCode: "en",
      }),
    );
    expect(aiSummary).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-123", prompt: QUESTION }),
    );
    expect(createDataforseoClient).toHaveBeenCalled();
  });

  it("quotes both billed steps, because the crawl is charged whether or not anyone asks", async () => {
    // A preview quoting only the 10-credit summary would understate the real
    // price by a fifth.
    const result = await callTool(serpAskTool, {
      keyword: "best geo tool",
      prompt: QUESTION,
    });
    const structured = result.structuredContent ?? {};

    expect(structured.dryRun).toBe(true);
    expect(structured.estimatedCredits).toBe(12);
    expect(textOf(result)).toMatch(
      /2 for the SERP crawl and 10 for the summary/,
    );
    expect(serpTaskForSummary).not.toHaveBeenCalled();
    expect(aiSummary).not.toHaveBeenCalled();
  });

  it("names the page-crawl cost separately, because it is not in the 10 credits", async () => {
    useVendorResult();

    const result = await callTool(serpAskTool, {
      keyword: "best geo tool",
      prompt: QUESTION,
      fetchContent: true,
      dry_run: false,
    });

    // The flag reaches the vendor...
    expect(aiSummary).toHaveBeenCalledWith(
      expect.objectContaining({ fetchContent: true }),
    );
    // ...and the preview text still refuses to fold it into the 12.
    const preview = await callTool(serpAskTool, {
      keyword: "best geo tool",
      prompt: QUESTION,
      fetchContent: true,
    });
    expect(textOf(preview)).toMatch(/not included in the 10 credits/);
    expect(result.structuredContent).toBeDefined();
  });

  it("says what the answer actually is, because one model reading is not a fact", async () => {
    // The load-bearing sentence. DataForSEO does not say which model produced
    // the summary, so nothing here can be verified — and an agent that quotes
    // it as a finding is quoting an opinion. Wording is what gets repeated.
    useVendorResult();

    const text = textOf(
      await callTool(serpAskTool, {
        keyword: "best geo tool",
        prompt: QUESTION,
        dry_run: false,
      }),
    );

    expect(text).toMatch(/one model's reading of one SERP/i);
    expect(text).toMatch(/does not say which model produced it/i);
    expect(text).toMatch(/not a ranking/i);
  });

  it("states that the model also saw the answer box, not only organic results", async () => {
    // support_extra defaults to true, so the summary is NOT organic-only — and
    // a reader who assumes it was is reasoning about a different input than the
    // one the model actually had.
    useVendorResult();

    const text = textOf(
      await callTool(serpAskTool, {
        keyword: "best geo tool",
        prompt: QUESTION,
        dry_run: false,
      }),
    );

    expect(text).toMatch(/answer box, knowledge graph and featured snippet/i);
  });

  it("says the model saw organic results only when support_extra is off", async () => {
    useVendorResult();

    const result = await callTool(serpAskTool, {
      keyword: "best geo tool",
      prompt: QUESTION,
      supportExtra: false,
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toMatch(/organic results only/i);
    expect(aiSummary).toHaveBeenCalledWith(
      expect.objectContaining({ supportExtra: false }),
    );
    expect(result.structuredContent?.supportExtra).toBe(false);
  });

  it("reports an uncited summary as unsupported rather than as a clean answer", async () => {
    // "It cited nothing" and "we could not reach it" are different states, and
    // only the first is honest here.
    useVendorResult("Agencies use suites.", []);

    const result = await callTool(serpAskTool, {
      keyword: "best geo tool",
      prompt: QUESTION,
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toMatch(/cited nothing/i);
    expect(text).toMatch(/not a failure to fetch/i);
    expect(result.structuredContent?.uncited).toBe(true);
    expect(result.structuredContent?.links).toEqual([]);
  });

  it("returns the cited links separately, so what the model used is checkable", async () => {
    useVendorResult();

    const result = await callTool(serpAskTool, {
      keyword: "best geo tool",
      prompt: QUESTION,
      dry_run: false,
    });

    expect(result.structuredContent?.links).toMatchObject([
      { title: "Reddit", url: "https://reddit.com/r/seo" },
    ]);
    expect(result.structuredContent?.uncited).toBe(false);
  });

  it("is not marked read-only, because it spends two billed calls", async () => {
    expect(serpAskTool.config.annotations.readOnlyHint).toBe(false);
    expect(serpAskTool.config.annotations.destructiveHint).toBe(false);
  });
});
