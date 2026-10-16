import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

// `withMcpProjectAuth` is mocked so these tests are about the tool's output,
// not authorisation, and no SQL can run. No vendor seam is mocked because the
// tool makes no vendor call — pure composition over supplied period data.
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

const { councilMemoTool } =
  await import("@/server/mcp/tools/council-memo-tool");

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

describe("council_memo", () => {
  it("renders the memo text and structured markdown, spending nothing", async () => {
    const result = await callTool(councilMemoTool, {
      projectId: "p1",
      brand: "Acme",
      periodFrom: "2026-10-09",
      periodTo: "2026-10-16",
      citationChanges: [{ subject: "docs", direction: "gained", count: 12 }],
      topFixes: [{ action: "Fix A", reason: "biggest gap", impact: "high" }],
      spendUsd: 4.2,
      forecastsScored: 2,
    });
    const text = textContent(result);
    expect(text).toMatch(/# GEO Council Memo — Acme/);
    expect(text).toMatch(/docs gained 12 citations/);
    expect(text).toMatch(/## Top fixes/);
    expect(typeof result.structuredContent?.markdown).toBe("string");
  });
});
