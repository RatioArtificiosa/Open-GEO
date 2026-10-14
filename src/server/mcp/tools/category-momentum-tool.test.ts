import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

// `withMcpProjectAuth` is mocked so these tests are about the tool's output, not
// authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// The vendor seam. Mocked because the live API is unreachable (the account is
// `40104` unverified, every daily rate limit zero) and because the shape the
// mock returns — a graph item with an empty `keywords` array — is the shape the
// category change is asserted to produce, which is exactly what should be
// pinned here rather than assumed.
const googleTrendsExplore = vi.fn();
vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: () => ({
    keywords: { googleTrendsExplore },
  }),
}));

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

const { categoryMomentumTool } =
  await import("@/server/mcp/tools/category-momentum-tool");

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

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
 * A rising category window, in the shape a category-only request returns: one
 * graph item whose `keywords` array is **empty** — the series is positional, and
 * that is the whole reason `readCategoryTrend` exists rather than the
 * keyword-keyed `readTrendSeries`.
 */
function categoryGraph(values: number[]) {
  return [
    {
      type: "google_trends_graph",
      keywords: [],
      data: values.map((value) => ({
        date_from: "2026-01-01",
        date_to: "2026-01-07",
        values: [value],
        missing_data: false,
      })),
    },
  ];
}

const RISING = Array.from({ length: 20 }, (_, i) => 40 + i * 2);

describe("category_momentum", () => {
  it("quotes the cost and spends nothing on a dry run", async () => {
    googleTrendsExplore.mockClear();

    const result = await callTool(categoryMomentumTool, {
      categoryCode: 16,
      dry_run: true,
    });

    // Default-dry-run is the spending contract: the cost is stated, and no
    // vendor call was made — a read that reached the API on a dry run would be
    // spend nobody quoted.
    expect(googleTrendsExplore).not.toHaveBeenCalled();
    const text = textContent(result);
    expect(text).toMatch(/dry run/i);
    expect(text).toMatch(/0\.0027/);
  });

  it("asks the vendor for a category with no keywords, which is the change's shape", async () => {
    googleTrendsExplore.mockReset();
    googleTrendsExplore.mockResolvedValue(categoryGraph(RISING));

    await callTool(categoryMomentumTool, { categoryCode: 16, dry_run: false });

    // **The keywords field must stay absent.** A caller that sent an empty
    // keywords array alongside the category would change the request the vendor
    // bills for, and the empty array is the default-parameter shape the client
    // already refuses.
    //
    // Asserted as the whole recorded object rather than by casting it to read
    // one key: `toStrictEqual` fails on an extra key *and* on a changed one, so
    // a `keywords: []` arriving later breaks this line and nothing has to be
    // re-read to find out why.
    expect(googleTrendsExplore).toHaveBeenCalledTimes(1);
    expect(googleTrendsExplore.mock.calls[0]?.[0]).toStrictEqual({
      categoryCode: 16,
      type: undefined,
      timeRange: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      // The project's own market, not the global request the product refuses.
      locationCode: 2840,
      languageCode: undefined,
    });
  });

  it("returns the verdict with both signals and the caveat", async () => {
    googleTrendsExplore.mockReset();
    googleTrendsExplore.mockResolvedValue(categoryGraph(RISING));

    const result = await callTool(categoryMomentumTool, {
      categoryCode: 16,
      dry_run: false,
    });

    expect(result.structuredContent).toMatchObject({
      categoryCode: 16,
      direction: "accelerating",
      basis: "measured",
      pointsMeasured: 20,
    });
    // The caveat is in the prose, not only the payload: the prose is what an
    // agent repeats to a user.
    const text = textContent(result);
    expect(text).toMatch(/relative to the biggest peak/);
    expect(text).toMatch(/Accelerating:/);
  });

  it("reads the positional series, not a keyword-keyed one", async () => {
    // The response carries no keywords, so a reader that keyed on them would
    // return an empty series and the tool would report "no measured points" —
    // silence where a verdict belongs. This pins the extraction that keeps that
    // from happening.
    googleTrendsExplore.mockReset();
    googleTrendsExplore.mockResolvedValue(categoryGraph(RISING));

    const result = await callTool(categoryMomentumTool, {
      categoryCode: 16,
      dry_run: false,
    });

    expect(result.structuredContent?.pointsMeasured).toBe(20);
  });

  it("refuses a direction from a too-short window rather than reporting flat", async () => {
    googleTrendsExplore.mockReset();
    googleTrendsExplore.mockResolvedValue(categoryGraph([10, 20, 30]));

    const result = await callTool(categoryMomentumTool, {
      categoryCode: 16,
      dry_run: false,
    });

    expect(result.structuredContent).toMatchObject({
      direction: null,
      basis: "too-little-history",
    });
    expect(textContent(result)).toMatch(/floor for a direction/);
  });
});
