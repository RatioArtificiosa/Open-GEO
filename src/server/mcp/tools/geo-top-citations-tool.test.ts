import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

// `withMcpProjectAuth` is mocked so these tests are about wording, not
// authorisation, and no SQL can run: `listTargets` and `getCitationProfile` are
// the seams the assertions actually need.
vi.mock("cloudflare:workers", () => ({ env: {} }));

const listTargets = vi.fn();
const getCitationProfile = vi.fn();

vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { listTargets },
}));

vi.mock("@/server/features/geo/services/GeoService", () => ({
  GeoService: { getCitationProfile },
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

const { getGeoTopCitationsTool } =
  await import("@/server/mcp/tools/geo-top-citations-tool");

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

const TARGET = { id: "t1", domain: "acme.com", name: "Acme" };

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

describe("get_geo_top_citations", () => {
  it("states the per-platform citation leaders without ever summing them", async () => {
    // The platform card rule: mentions counts are per-platform, and a number
    // that adds chat_gpt to google_ai_overview to gemini means nothing — so the
    // wording names the rule instead of printing a total.
    listTargets.mockResolvedValue([TARGET]);
    getCitationProfile.mockResolvedValue([
      {
        platform: "chat_gpt",
        snapshotId: "s1",
        domains: [
          { domain: "reddit.com", mentions: 12, aiSearchVolume: null },
          { domain: "g2.com", mentions: 7, aiSearchVolume: null },
        ],
      },
      {
        platform: "google_ai_overview",
        snapshotId: "s1",
        domains: [
          { domain: "wikipedia.org", mentions: 9, aiSearchVolume: null },
        ],
      },
    ]);

    const text = textOf(
      await callTool(getGeoTopCitationsTool, { domain: "acme.com" }),
    );

    expect(text).toContain("reddit.com (12)");
    expect(text).not.toContain("28");
    expect(text.toLowerCase()).toContain("never summed");
  });

  it("says the archive is empty rather than inventing an empty success", async () => {
    listTargets.mockResolvedValue([TARGET]);
    getCitationProfile.mockResolvedValue([]);

    const text = textOf(
      await callTool(getGeoTopCitationsTool, { domain: "acme.com" }),
    );

    expect(text.toLowerCase()).toContain("no citation archive");
  });
});
