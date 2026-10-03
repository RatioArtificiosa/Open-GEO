import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";
import type * as dataforseo from "@/server/lib/dataforseo";

// `withMcpProjectAuth` is mocked so these tests are about the tool's
// output, not authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// The vendor client is the seam: `createDataforseoClient` is replaced
// so the live path resolves a shaped `target_metrics` response instead
// of hitting DataForSEO. The rest of the module (e.g. `buildLlmTarget`)
// stays real.
const createDataforseoClient = vi.fn();
vi.mock("@/server/lib/dataforseo", async (importOriginal) => {
  const actual = await importOriginal<typeof dataforseo>();
  return {
    ...actual,
    createDataforseoClient,
  };
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

const { geoBrandFramingTool } =
  await import("@/server/mcp/tools/geo-brand-framing-tool");

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
 * A `target_metrics` response: all data lives in `aggregated_metrics`,
 * and the brand-entity buckets are dimensions of it — not fields of an
 * array element, and not fields of `aggregated_metrics`'s total.
 */
function targetMetricsResponse() {
  return {
    total_count: 0,
    offset: 0,
    items_count: 0,
    aggregated_metrics: {
      platform: [],
      sources_domain: [],
      search_results_domain: [],
      brand_entities_title: [
        { key: "acme.com", mentions: 30, ai_search_volume: 900 },
        { key: "car manufacturer", mentions: 12, ai_search_volume: 300 },
      ],
      brand_entities_category: [
        { key: "Automotive", mentions: 50, ai_search_volume: 1500 },
      ],
    },
    items: [],
  };
}

/**
 * The wrong endpoint's shape: an `aggregated_metrics` **total** carries
 * only `mentions`, `ai_search_volume` and `platform` — no brand-entity
 * buckets. Offering it lets the test prove the tool does not read brand
 * entities from here, which is the failure this suite exists to catch.
 */
function aggregatedTotalResponse() {
  return {
    mentions: 42,
    ai_search_volume: 1200,
    platform: "chat_gpt",
  };
}

describe("geo_brand_framing", () => {
  it("renders the brand-entity buckets the vendor returned", async () => {
    const targetMetrics = vi.fn().mockResolvedValue(targetMetricsResponse());
    const aggregatedMetrics = vi
      .fn()
      .mockResolvedValue(aggregatedTotalResponse());
    createDataforseoClient.mockReturnValue({
      aiSearch: { targetMetrics, aggregatedMetrics },
    });

    const result = await callTool(geoBrandFramingTool, {
      domain: "acme.com",
      dry_run: false,
    });
    const text = textOf(result);

    // The buckets are rendered, not swallowed into an empty.
    expect(text).toContain("acme.com");
    expect(text).toContain("car manufacturer");
    expect(text).toContain("Automotive");
    // The silent failure this tool must never ship: a wrong endpoint
    // reads no buckets and reports "no brand entities".
    expect(text).not.toMatch(/no brand entities found/i);

    // It reads the dimensional breakdown, not the aggregated total.
    expect(targetMetrics).toHaveBeenCalledTimes(1);
    expect(aggregatedMetrics).not.toHaveBeenCalled();
  });

  it("identifies the brand's own bucket and the dominant label", async () => {
    createDataforseoClient.mockReturnValue({
      aiSearch: {
        targetMetrics: vi.fn().mockResolvedValue(targetMetricsResponse()),
        aggregatedMetrics: vi.fn().mockResolvedValue(aggregatedTotalResponse()),
      },
    });

    const result = await callTool(geoBrandFramingTool, {
      domain: "acme.com",
      dry_run: false,
    });
    const structured = result.structuredContent ?? {};

    // Own bucket matched by domain; dominant is the largest across both
    // dimensions (Automotive, 50 mentions).
    expect(structured.ownBucket).toMatchObject({
      key: "acme.com",
      mentions: 30,
    });
    expect(structured.dominantBucket).toMatchObject({ key: "Automotive" });
    expect(structured.totalMentions).toBe(92);
    expect(structured.platform).toBe("chat_gpt");
  });

  it("states the single-model caveat, since the buckets are ChatGPT-only", async () => {
    createDataforseoClient.mockReturnValue({
      aiSearch: {
        targetMetrics: vi.fn().mockResolvedValue(targetMetricsResponse()),
        aggregatedMetrics: vi.fn().mockResolvedValue(aggregatedTotalResponse()),
      },
    });

    const text = textOf(
      await callTool(geoBrandFramingTool, {
        domain: "acme.com",
        dry_run: false,
      }),
    );

    expect(text).toMatch(/ChatGPT's view only/i);
  });

  it("previews the credit cost without spending on a dry run", async () => {
    // A dry run must not touch the vendor client at all.
    const targetMetrics = vi.fn();
    createDataforseoClient.mockReturnValue({
      aiSearch: { targetMetrics },
    });

    const result = await callTool(geoBrandFramingTool, {
      domain: "acme.com",
    });
    const structured = result.structuredContent ?? {};

    expect(structured.dryRun).toBe(true);
    expect(structured.estimatedCredits).toBe(100);
    expect(textOf(result)).toMatch(/dry run/i);
    expect(targetMetrics).not.toHaveBeenCalled();
  });
});
