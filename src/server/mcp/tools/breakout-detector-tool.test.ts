import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

// `withMcpProjectAuth` is mocked so these tests are about the tool's output, not
// authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// The vendor seam, mocked: the account is `40104` unverified, and a breakout
// verdict is pure maths over a series — what must be pinned here is which
// element the tool reads and what it does with it, not the network.
const trendsMerged = vi.fn();
vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: () => ({ keywords: { trendsMerged } }),
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

const { breakoutDetectorTool } =
  await import("@/server/mcp/tools/breakout-detector-tool");

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

/** A merged response: the graph element the detector reads, plus a sibling it must not. */
function mergedResponse(values: number[]) {
  return [
    {
      type: "demography",
      keywords: ["ai visibility"],
      demographics: [],
    },
    {
      type: "dataforseo_trends_graph",
      keywords: ["ai visibility"],
      averages: [],
      data: values.map((value) => ({
        date_from: "2026-01-05",
        date_to: "2026-01-11",
        values: [value],
      })),
    },
  ];
}

const BREAKOUT_WINDOW = [
  ...Array.from({ length: 12 }, () => 40),
  ...Array.from({ length: 13 }, (_, i) => 40 + i * 5),
  ...Array.from({ length: 15 }, () => 104),
];

const BLIP_WINDOW = [
  ...Array.from({ length: 26 }, () => 40),
  100,
  100,
  ...Array.from({ length: 14 }, () => 40),
];

function useSeries(values: number[]) {
  trendsMerged.mockReset();
  trendsMerged.mockResolvedValue(mergedResponse(values));
}

describe("breakout_detector", () => {
  it("quotes the cost and spends nothing on a dry run", async () => {
    trendsMerged.mockClear();

    const result = await callTool(breakoutDetectorTool, {
      keywords: ["ai visibility"],
      dry_run: true,
    });

    expect(trendsMerged).not.toHaveBeenCalled();
    const text = textContent(result);
    expect(text).toMatch(/dry run/i);
    expect(text).toMatch(
      /year-over-year signal needs a window of at least a year/,
    );
  });

  it("names a steep sustained climb a candidate", async () => {
    useSeries(BREAKOUT_WINDOW);

    const result = await callTool(breakoutDetectorTool, {
      keywords: ["ai visibility"],
      timeRange: "past_5_years",
      dry_run: false,
    });

    expect(result.structuredContent?.signals).toHaveLength(1);
    expect(result.structuredContent?.signals).toMatchObject([
      {
        keyword: "ai visibility",
        isBreakoutCandidate: true,
        stillElevated: true,
      },
    ]);
    expect(textContent(result)).toMatch(/Breakout candidate: ai visibility/);
    expect(textContent(result)).toMatch(/relative to the biggest peak/);
  });

  it("refuses the spike that returned, and shows the number that refuses it", async () => {
    // The detector's whole purpose: a two-step spike to 100 is the tallest thing
    // in the window and is not a breakout. Hiding the persistence number would
    // leave a reader with a verdict and no way to check it.
    useSeries(BLIP_WINDOW);

    const result = await callTool(breakoutDetectorTool, {
      keywords: ["ai visibility"],
      dry_run: false,
    });

    expect(result.structuredContent?.signals).toMatchObject([
      { isBreakoutCandidate: false, persistenceSteps: 2 },
    ]);
    expect(textContent(result)).toMatch(/No breakout shape/);
    expect(textContent(result)).toMatch(/elevation lasted 2 steps/);
  });

  it("reports no year-over-year figure from a short window, and says why", async () => {
    useSeries(BREAKOUT_WINDOW);

    const result = await callTool(breakoutDetectorTool, {
      keywords: ["ai visibility"],
      timeRange: "past_90_days",
      dry_run: false,
    });

    expect(result.structuredContent?.signals).toMatchObject([
      { yoyChangePercent: null },
    ]);
    expect(textContent(result)).toMatch(/shorter than a year plus a quarter/);
  });
});
