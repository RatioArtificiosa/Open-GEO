import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

// `withMcpProjectAuth` is mocked so these tests are about the tool's output,
// not authorisation, and no SQL can run. No vendor seam is mocked because the
// tool makes no vendor call — pure ranking over supplied candidates — and a
// mock for a call that never happens would be a test of nothing.
vi.mock("cloudflare:workers", () => ({ env: {} }));

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

const { whatToBuildTool } =
  await import("@/server/mcp/tools/what-to-build-tool");

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

async function callTool(
  tool: { handler: unknown },
  data: Record<string, unknown>,
): Promise<ToolResult> {
  // Imported dynamically, the concrete handler type is not visible here; this widens
  // `unknown` to the one shape the MCP server guarantees.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const handler = tool.handler as (
    args: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => Promise<ToolResult>;
  return handler(data, makeToolContext());
}

const candidate = {
  keyword: "example keyword",
  volume: 1000,
  keywordDifficulty: 20,
  serpCompetitors: 10,
  intent: "informational",
  aiNativeRatio: 0.5,
  rankElasticity: 0.5,
  trendFactor: 1,
  etv: 500,
  serpElements: [],
  competitorDomains: ["rival.com"],
};

describe("what_to_build", () => {
  it("ranks candidates with formats and reasons, spending nothing", async () => {
    const result = await callTool(whatToBuildTool, {
      projectId: "p1",
      candidates: [
        candidate,
        { ...candidate, keyword: "unmeasured", volume: null },
      ],
    });
    const text = textContent(result);
    expect(text).toMatch(/example keyword/);
    expect(text).toMatch(/guide/);
    expect(result.structuredContent).toMatchObject({
      build: [{ keyword: "example keyword" }],
      unpriced: [{ keyword: "unmeasured" }],
    });
  });

  it("answers empty input with empty lists, not an error", async () => {
    // Schema validation (min 1 candidate) lives at the MCP layer, not in
    // the handler — so the handler's contract for empty input is graceful
    // emptiness, tested here rather than a rejection tested nowhere real.
    const result = await callTool(whatToBuildTool, {
      projectId: "p1",
      candidates: [],
    });
    expect(result.structuredContent).toMatchObject({ build: [], unpriced: [] });
  });
});
