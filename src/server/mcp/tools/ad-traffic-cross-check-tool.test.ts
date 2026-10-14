import { describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

// `withMcpProjectAuth` is mocked so these tests are about the tool's output, not
// authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// The vendor seam, mocked: the account is `40104` unverified, and what must be
// pinned here is which fields the tool charts and what it refuses — not the
// network.
const adTrafficForecast = vi.fn();
vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: () => ({
    keywords: { adTrafficForecast },
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

const { adTrafficCrossCheckTool } =
  await import("@/server/mcp/tools/ad-traffic-cross-check-tool");

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

/** A vendor row: the three usable figures, and the two always-null ones. */
function vendorRow(keyword: string) {
  return {
    keyword,
    clicks: 12.5,
    average_cpc: 0.37,
    cost: 4.62,
    impressions: null,
    ctr: null,
  };
}

function useRows(keywords: string[]) {
  adTrafficForecast.mockReset();
  // The metered facade returns the rows **unwrapped** — it records the spend
  // itself — so the mock returns an array, not an envelope. A test that mocked
  // the envelope would let the tool compile against a shape it never receives.
  adTrafficForecast.mockResolvedValue(keywords.map(vendorRow));
}

const basis = {
  keywords: ["standing desk"],
  locationCode: 2840,
  languageCode: "en",
};

describe("ad_traffic_cross_check", () => {
  it("quotes the cost and spends nothing on a dry run", async () => {
    adTrafficForecast.mockClear();

    const result = await callTool(adTrafficCrossCheckTool, {
      ...basis,
      dry_run: true,
    });

    expect(adTrafficForecast).not.toHaveBeenCalled();
    const text = textContent(result);
    expect(text).toMatch(/dry run/i);
    expect(text).toMatch(/0\.06/);
    // The refusal is promised before the spend, so a caller learns what they
    // will not get while they can still choose not to pay for it.
    expect(text).toMatch(/deprecated fields are refused rather than charted/);
  });

  it("charts only the three usable fields by default", async () => {
    useRows(["standing desk", "standing desk mat"]);

    const result = await callTool(adTrafficCrossCheckTool, {
      ...basis,
      keywords: ["standing desk", "standing desk mat"],
      dry_run: false,
    });

    const rows = (result.structuredContent?.rows ?? []) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      keyword: "standing desk",
      values: { clicks: 12.5, average_cpc: 0.37, cost: 4.62 },
    });
    // The always-null pair is absent from the payload, not present-and-null.
    expect(Object.keys(rows[0]?.values ?? {})).toEqual([
      "clicks",
      "average_cpc",
      "cost",
    ]);
    // No refusal, because nothing deprecated was asked for.
    expect(result.structuredContent?.refusal).toBeNull();
    expect(textContent(result)).not.toMatch(/deprecated/);
  });

  it("refuses a deprecated field by name and charts the rest", async () => {
    // The whole point: an empty impressions axis reads as flat interest, and the
    // truth is that the vendor stopped reporting it. The refusal names the
    // field so a reader can act on the difference.
    useRows(["standing desk"]);

    const result = await callTool(adTrafficCrossCheckTool, {
      ...basis,
      fields: ["clicks", "impressions"],
      dry_run: false,
    });

    expect(result.structuredContent?.refusal).toContain("`impressions`");
    expect(result.structuredContent?.refusal).toMatch(
      /empty impressions chart would read as flat interest/,
    );
    const rows = (result.structuredContent?.rows ?? []) as Array<
      Record<string, unknown>
    >;
    // The usable field survives the refusal.
    expect(rows[0]).toMatchObject({ values: { clicks: 12.5 } });
  });

  it("returns nothing measurable when every usable field is null", async () => {
    // 0-is-not-null: a keyword the vendor did not price is absent, and a zero
    // here would read as "expected to earn nothing".
    adTrafficForecast.mockReset();
    adTrafficForecast.mockResolvedValue([
      {
        keyword: "obscure term",
        clicks: null,
        average_cpc: null,
        cost: null,
        impressions: null,
        ctr: null,
      },
    ]);

    const result = await callTool(adTrafficCrossCheckTool, {
      ...basis,
      keywords: ["obscure term"],
      dry_run: false,
    });

    const rows = (result.structuredContent?.rows ?? []) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]).toEqual({ keyword: "obscure term", values: {} });
    expect(textContent(result)).toMatch(/nothing measurable returned/);
  });

  it("states what the cross-check is not", async () => {
    // A paid plan's expected return beside an organic number is a sanity check,
    // not a second opinion — and a reader who takes it as one acts on it.
    useRows(["standing desk"]);

    const result = await callTool(adTrafficCrossCheckTool, {
      ...basis,
      dry_run: false,
    });

    expect(textContent(result)).toMatch(
      /not a forecast.*cannot corroborate an organic number/is,
    );
  });
});
