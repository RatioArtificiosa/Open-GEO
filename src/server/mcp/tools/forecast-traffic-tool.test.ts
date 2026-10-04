import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

// `withMcpProjectAuth` is mocked so these tests are about the tool's
// output, not authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// Two seams, and which one matters is the point of this file: the tool must
// read the STORED series (no vendor call, no credits) rather than fetching a
// live one, and it must go through the service that derives the market from
// the target. Mocking the service is what lets a test assert that the archive
// was the source.
const getEtvSeries = vi.fn();
const listTargets = vi.fn();
vi.mock("@/server/features/geo/services/geoSeriesReads", () => ({
  getEtvSeries,
}));
vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { listTargets },
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

const { forecastTrafficTool } =
  await import("@/server/mcp/tools/forecast-traffic-tool");

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

const TARGET = { id: "t1", domain: "acme.com", name: "Acme" };

/** Daily ETV points, so the tool has to bucket them into weeks itself. */
function dailySeries(
  days: number,
  etv: (day: number) => number,
): Array<{ date: string; etv: number; formulaVersion: string }> {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return {
      date: d.toISOString().slice(0, 10),
      etv: etv(i),
      formulaVersion: "legacy",
    };
  });
}

function useSeries(
  points: Array<{ date: string; etv: number | null; formulaVersion: string }>,
) {
  listTargets.mockResolvedValue([TARGET]);
  getEtvSeries.mockResolvedValue({
    domain: "acme.com",
    endpoint: "domain_rank_overview",
    points,
    formulaVersions: ["legacy"],
  });
}

describe("forecast_traffic", () => {
  it("reads the stored series and projects it, spending no vendor credits", async () => {
    // 14 weeks of rising traffic. The point of this assertion is the SOURCE:
    // the tool must read the archive, because a forecast that spent vendor
    // credits to read history we already hold would be a cost bug.
    useSeries(dailySeries(98, (day) => 100 + day));

    const result = await callTool(forecastTrafficTool, {
      domain: "acme.com",
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toContain("acme.com");
    expect(getEtvSeries).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        domain: "acme.com",
        endpoint: "domain_rank_overview",
      }),
    );

    const structured = result.structuredContent ?? {};
    // 13 weekly points, which is the 90-day band the product advertises.
    expect(structured.points).toHaveLength(13);
    expect(structured.historyWeeks).toBe(14);
  });

  it("never mixes ETV endpoints, because they measure different populations", async () => {
    useSeries(dailySeries(98, () => 100));

    await callTool(forecastTrafficTool, {
      domain: "acme.com",
      endpoint: "ranked_keywords",
      dry_run: false,
    });

    expect(getEtvSeries).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "ranked_keywords" }),
    );
  });

  it("flags a window crossing the ETV formula change instead of drawing one line", async () => {
    // The refusal that matters most: there is no published conversion between
    // the two formulas, so a smooth line across the boundary is the more
    // convincing chart and the less true one.
    //
    // **The clock is frozen**, because the tool reads `new Date()`. Left on the
    // real clock this test would keep passing until 2026-11-01 and then start
    // failing for a reason that has nothing to do with the code — a test whose
    // verdict changes with the calendar is a test with an expiry date nobody
    // wrote down. Four weeks after the cutover the real window no longer spans
    // it and the assertion becomes permanently red.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-03T09:00:00Z"));
      useSeries(dailySeries(98, (day) => 100 + day));

      const result = await callTool(forecastTrafficTool, {
        domain: "acme.com",
        dry_run: false,
      });
      const text = textOf(result);

      expect(result.structuredContent?.basis).toMatchObject({
        cutoverDate: "2026-11-01",
        crossesCutover: true,
      });
      // The warning must be in the prose, not only the payload — the prose is
      // what an agent repeats to a user. Asserted against the WARNING line
      // specifically: `summary` also mentions comparability, so a looser match
      // would pass with the WARNING removed (and it did, on the first run).
      expect(text).toContain("WARNING:");
      expect(text).toMatch(/WARNING:.*no published conversion/is);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a forecast that no longer crosses the cutover once the date passes", async () => {
    // The other side of the same boundary, and the reason the first test needs
    // a frozen clock: after 2026-11-01 a 13-week window does NOT span the
    // change, so there must be no warning to read. A tool that always emitted
    // the cutover warning would look careful forever and be wrong after the
    // date it names.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-12-01T09:00:00Z"));
      useSeries(dailySeries(98, (day) => 100 + day));

      const result = await callTool(forecastTrafficTool, {
        domain: "acme.com",
        dry_run: false,
      });

      expect(result.structuredContent?.basis).toMatchObject({
        crossesCutover: false,
      });
      expect(textOf(result)).not.toContain("WARNING:");
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the series' own formula version rather than assuming one", async () => {
    useSeries(dailySeries(98, () => 100));
    getEtvSeries.mockResolvedValue({
      domain: "acme.com",
      endpoint: "domain_rank_overview",
      points: dailySeries(98, () => 100),
      formulaVersions: ["new"],
    });

    const result = await callTool(forecastTrafficTool, {
      domain: "acme.com",
      dry_run: false,
    });

    expect(result.structuredContent?.basis).toMatchObject({
      formulaVersion: "new",
    });
  });

  it("says there is no forecast rather than projecting zero traffic", async () => {
    // Two measured weeks cannot support a slope. The answer must be a refusal
    // that names the absence — "no forecast" and "zero traffic" are entirely
    // different claims, and only the second is false.
    useSeries(dailySeries(10, () => 100));

    const result = await callTool(forecastTrafficTool, {
      domain: "acme.com",
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toMatch(/No forecast/i);
    expect(text).not.toMatch(/expected 0/i);
  });

  it("explains an unmonitored domain in one sentence", async () => {
    listTargets.mockResolvedValue([]);

    const result = await callTool(forecastTrafficTool, {
      domain: "other.com",
      dry_run: false,
    });

    expect(textOf(result)).toMatch(/not a monitored target/i);
    expect(getEtvSeries).not.toHaveBeenCalled();
  });

  it("previews without reading the archive", async () => {
    const result = await callTool(forecastTrafficTool, {
      domain: "acme.com",
    });
    const structured = result.structuredContent ?? {};

    expect(structured.dryRun).toBe(true);
    expect(textOf(result)).toMatch(/spends no DataForSEO credits/i);
    expect(getEtvSeries).not.toHaveBeenCalled();
  });

  it("is marked read-only, because it reads the archive and spends nothing", () => {
    // A wrong readOnlyHint makes an agent ask the user to confirm a call that
    // cannot cost anything or change anything.
    expect(forecastTrafficTool.config.annotations.readOnlyHint).toBe(true);
    expect(forecastTrafficTool.config.annotations.destructiveHint).toBe(false);
  });
});
