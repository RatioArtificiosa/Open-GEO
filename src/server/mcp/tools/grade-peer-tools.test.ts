import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

// `withMcpProjectAuth` is mocked so these tests are about the tools' output,
// not authorisation, and no SQL can run. No vendor seam is mocked because
// neither tool makes a vendor call — pure computation over supplied inputs —
// and a mock for a call that never happens would be a test of nothing.
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

const { gradeContentTool } =
  await import("@/server/mcp/tools/grade-content-tool");
const { peerBenchmarkTool } =
  await import("@/server/mcp/tools/peer-benchmark-tool");

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

describe("grade_content", () => {
  it("reads a crawl aloud with indices, ratio, and counts", async () => {
    const result = await callTool(gradeContentTool, {
      projectId: "p1",
      onpageScore: 88,
      readability: { fleschKincaid: 62.4, smog: 9.1 },
      keywordDensityRatio: 0.0237,
      checksPassed: 12,
      checksTotal: 40,
    });
    const text = textContent(result);
    expect(text).toMatch(/On-page score 88/);
    expect(text).toMatch(/Flesch–Kincaid/);
    expect(text).toMatch(/2.37%/);
    expect(text).toMatch(/12\/40/);
    expect(result.structuredContent).toMatchObject({ score: 88 });
  });
});

describe("peer_benchmark", () => {
  it("ranks distributions and describes the audience, spending nothing", async () => {
    const result = await callTool(peerBenchmarkTool, {
      projectId: "p1",
      benchmarks: [
        {
          metric: "keyword_difficulty",
          peers: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
          subject: 55,
          subjectIncluded: false,
        },
      ],
      persona: {
        demography: [
          { label: "25–34", share: 0.45 },
          { label: "35–44", share: 0.35 },
          { label: "45+", share: 0.2 },
        ],
        funnelStage: "commercial",
        serpFeatures: ["video"],
        sampleSize: 1200,
      },
    });
    const text = textContent(result);
    expect(text).toMatch(/percentile 55/);
    expect(text).toMatch(/25–34/);
    expect(result.structuredContent).toMatchObject({
      benchmarks: [{ metric: "keyword_difficulty", percentile: 55 }],
    });
  });

  it("skips the persona when null rather than manufacturing one", async () => {
    const result = await callTool(peerBenchmarkTool, {
      projectId: "p1",
      benchmarks: [
        {
          metric: "kd",
          peers: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
          subject: 5,
          subjectIncluded: false,
        },
      ],
      persona: null,
    });
    expect(result.structuredContent).toMatchObject({ persona: null });
  });
});
