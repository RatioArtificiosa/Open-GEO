import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

/**
 * `report_publish` is the one tool in this product that puts a customer's data
 * on the public internet, so these tests are almost entirely about **the
 * boundary**: what happens on a bare call, on a dry run, and on an explicit
 * confirmation.
 *
 * The service is mocked because it owns the hosted-only guard and the token
 * mint, both already tested in `ReportService.test.ts`. What is tested here is
 * the tool's own contribution: that asking for a report never shares one.
 */

vi.mock("cloudflare:workers", () => ({ env: {} }));

const shareReport = vi.fn();
const unshareReport = vi.fn();
const getReport = vi.fn();
vi.mock("@/server/features/reports/services/ReportService", () => ({
  ReportService: { shareReport, unshareReport, getReport },
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

const { reportPublishTool } =
  await import("@/server/mcp/tools/report-publish-tool");

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

const PRIVATE_REPORT = {
  id: "r1",
  title: "Acme GEO audit",
  skill: "geo-audit",
  shareToken: null,
  sharedAt: null,
};

const SHARED_REPORT = {
  ...PRIVATE_REPORT,
  shareToken: "a".repeat(32),
  sharedAt: "2026-10-03T10:00:00.000Z",
};

function usePrivate() {
  getReport.mockResolvedValue(PRIVATE_REPORT);
}
function useShared() {
  getReport.mockResolvedValue(SHARED_REPORT);
}

describe("report_publish", () => {
  it("shares nothing when asked to publish without confirming", async () => {
    // The single most important behaviour in the file. A user asking an agent
    // for their report must never end up with a world-readable link as a side
    // effect.
    usePrivate();

    const result = await callTool(reportPublishTool, {
      reportId: "r1",
      publish: true,
    });
    const text = textOf(result);

    // `publish: true` alone is not enough — `dry_run: false` is the second half.
    expect(shareReport).not.toHaveBeenCalled();
    expect(text).toContain("Nothing has been shared");
    expect(text).toMatch(/anyone can read without logging in/i);
  });

  it("tells the agent to ask the user first, because seeing a report is not publishing it", async () => {
    usePrivate();

    const text = textOf(
      await callTool(reportPublishTool, { reportId: "r1", publish: true }),
    );

    // The refusal has to carry the instruction, not just the no.
    expect(text).toMatch(/ask the user whether they want this report public/i);
  });

  it("shares only when both publish and dry_run:false are given", async () => {
    shareReport.mockResolvedValue(SHARED_REPORT);
    usePrivate();

    const result = await callTool(reportPublishTool, {
      reportId: "r1",
      publish: true,
      dry_run: false,
    });
    const text = textOf(result);

    expect(shareReport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", reportId: "r1" }),
    );
    // The URL uses the shared route, and the token is in it.
    expect(text).toContain("https://open-geo.test/s/" + "a".repeat(32));
    expect(result.structuredContent?.shared).toBe(true);
  });

  it("says the link is public and unauthenticated, because the token is in the URL", async () => {
    shareReport.mockResolvedValue(SHARED_REPORT);
    usePrivate();

    const text = textOf(
      await callTool(reportPublishTool, {
        reportId: "r1",
        publish: true,
        dry_run: false,
      }),
    );

    // A published link handed to a user with no warning about it is the harm.
    expect(text).toMatch(/without logging in/i);
    expect(text).toMatch(/treat it as a secret/i);
    expect(text).toMatch(/revoke: true/i);
  });

  it("revokes without needing a confirmation, because revoking only reduces exposure", async () => {
    unshareReport.mockResolvedValue(PRIVATE_REPORT);
    useShared();

    const result = await callTool(reportPublishTool, {
      reportId: "r1",
      revoke: true,
    });

    expect(unshareReport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", reportId: "r1" }),
    );
    expect(shareReport).not.toHaveBeenCalled();
    expect(result.structuredContent?.shared).toBe(false);
    expect(result.structuredContent?.shareUrl).toBeNull();
  });

  it("reports an already-private report as unchanged rather than as a revocation", async () => {
    unshareReport.mockResolvedValue(PRIVATE_REPORT);
    usePrivate();

    const result = await callTool(reportPublishTool, {
      reportId: "r1",
      revoke: true,
    });

    expect(result.structuredContent?.unchanged).toBe(true);
    expect(textOf(result)).toMatch(/private again/i);
  });

  it("says an already-shared report is already shared, instead of implying it was just published", async () => {
    useShared();

    const text = textOf(
      await callTool(reportPublishTool, { reportId: "r1", publish: true }),
    );

    // Idempotency is the service's job; the wording is the tool's. Calling this
    // on a shared report must not read as a fresh publication.
    expect(text).toMatch(/ALREADY shared/i);
    expect(text).toMatch(/revoke: true/i);
  });

  it("is marked open-world and destructive, because it creates a bearer credential", () => {
    // The annotations are what make a host ask the user before allowing the
    // call. An annotation claiming "safe" on a tool that publishes a customer
    // audit is the wrong default, and this pins it.
    expect(reportPublishTool.config.annotations.openWorldHint).toBe(true);
    expect(reportPublishTool.config.annotations.destructiveHint).toBe(true);
    expect(reportPublishTool.config.annotations.readOnlyHint).toBe(false);
  });
});
