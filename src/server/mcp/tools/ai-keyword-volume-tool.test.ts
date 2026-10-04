import { describe, expect, it, vi } from "vitest";
// **Imported so the assertions can derive the expected figures.** The old test
// hard-coded `4` credits and `/\$0\.002/`, which is how the copy and the
// calculation came to disagree: both were once right, and nothing connected them.
import { AI_KEYWORD_UNIT_COST_USD } from "@/shared/dataforseo-pricing";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";
import type * as dataforseo from "@/server/lib/dataforseo";

// `withMcpProjectAuth` is mocked so these tests are about the tool's
// output, not authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

// The metered client is the seam: the tool reaches DataForSEO through
// `client.aiSearch.keywordVolume`, which is what performs the credit
// check and the usage record. Mocking the raw fetcher instead would let
// the tool spend per-keyword credits unmetered and the test would not
// notice — which is the defect this suite exists to hold shut.
const keywordVolume = vi.fn();
const createDataforseoClient = vi.fn();
vi.mock("@/server/lib/dataforseo", async (importOriginal) => {
  const actual = await importOriginal<typeof dataforseo>();
  return { ...actual, createDataforseoClient };
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

const { aiKeywordVolumeTool } =
  await import("@/server/mcp/tools/ai-keyword-volume-tool");

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

/** What the metered client resolves: the unwrapped result. */
function vendorResult() {
  return {
    locationCode: 2840,
    languageCode: "en",
    items: [
      {
        keyword: "generative engine optimization",
        ai_search_volume: 1200,
        ai_monthly_searches: [
          { year: 2026, month: 8, ai_search_volume: 900 },
          { year: 2026, month: 9, ai_search_volume: 1200 },
        ],
      },
      {
        keyword: "ai seo audit",
        ai_search_volume: null,
        ai_monthly_searches: null,
      },
    ],
  };
}

function useVendorResult() {
  keywordVolume.mockResolvedValue(vendorResult());
  createDataforseoClient.mockReturnValue({
    aiSearch: { keywordVolume },
  });
}

describe("ai_keyword_volume", () => {
  it("returns each keyword's AI demand, and renders a measured zero as a number", async () => {
    useVendorResult();

    const result = await callTool(aiKeywordVolumeTool, {
      keywords: ["generative engine optimization", "ai seo audit"],
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toContain("generative engine optimization");
    expect(text).toContain("1200");
    // A keyword with no recorded AI demand is a measured zero-or-absent, and
    // the table renders it as "—" rather than dropping the row or inventing
    // a number.
    expect(text).toContain("ai seo audit");

    const structured = result.structuredContent ?? {};
    expect(structured.keywordCount).toBe(2);
    expect(structured.locationCode).toBe(2840);
    expect(structured.languageCode).toBe("en");
    expect(structured.rows).toMatchObject([
      { keyword: "generative engine optimization", aiSearchVolume: 1200 },
      { keyword: "ai seo audit", aiSearchVolume: null },
    ]);
  });

  it("names the unit in the text, because the same field name means two things", async () => {
    // The load-bearing sentence. `ai_search_volume` from this endpoint is a
    // People-Also-Ask-derived model, NOT comparable with Google search volume
    // or with the same-named field from llm_mentions — we measured one keyword
    // 198x apart across two of them. An agent that quotes a ratio built on
    // this number is wrong, and wording is what an agent repeats to a user.
    useVendorResult();

    const text = textOf(
      await callTool(aiKeywordVolumeTool, {
        keywords: ["generative engine optimization"],
        dry_run: false,
      }),
    );

    expect(text).toMatch(/People-Also-Ask-derived model/i);
    expect(text).toMatch(/not comparable with Google search volume/i);
    expect(text).toMatch(/198x apart/);
  });

  it("omits the monthly series unless it is asked for", async () => {
    useVendorResult();

    const result = await callTool(aiKeywordVolumeTool, {
      keywords: ["generative engine optimization"],
      dry_run: false,
    });
    // Default false: the 12-row array is most of the bytes and nothing at
    // the call site is known to need it.
    expect(result.structuredContent?.rows).toMatchObject([
      { keyword: "generative engine optimization", monthlyTrend: [] },
      { keyword: "ai seo audit", monthlyTrend: [] },
    ]);
  });

  it("returns the 12-month series when it is asked for", async () => {
    useVendorResult();

    const result = await callTool(aiKeywordVolumeTool, {
      keywords: ["generative engine optimization"],
      includeMonthlyTrend: true,
      dry_run: false,
    });

    expect(result.structuredContent?.rows).toMatchObject([
      {
        keyword: "generative engine optimization",
        monthlyTrend: [
          { year: 2026, month: 8, volume: 900 },
          { year: 2026, month: 9, volume: 1200 },
        ],
      },
      { keyword: "ai seo audit", monthlyTrend: [] },
    ]);
  });

  it("says an empty response is absent data, not zero AI demand", async () => {
    keywordVolume.mockResolvedValue({
      locationCode: 2840,
      languageCode: "en",
      items: [],
    });
    createDataforseoClient.mockReturnValue({
      aiSearch: { keywordVolume },
    });

    const text = textOf(
      await callTool(aiKeywordVolumeTool, {
        keywords: ["a topic nobody asks an LLM about"],
        dry_run: false,
      }),
    );

    // The sentence has to name the distinction, not merely avoid the words:
    // "no rows" and "no AI demand" are different findings, and the second one
    // is a claim the tool cannot make.
    expect(text).toMatch(/absence of data/i);
    expect(text).toMatch(/not evidence that these topics have no AI demand/i);
    expect(text).not.toMatch(/^AI demand for 0 keyword\(s\).*no AI demand$/m);
  });

  it("resolves the market from the project rather than a hardcoded one", async () => {
    useVendorResult();

    await callTool(aiKeywordVolumeTool, {
      keywords: ["generative engine optimization"],
      dry_run: false,
    });

    // Both codes are REQUIRED by this endpoint, so they must come from
    // somewhere real rather than a constant in the tool.
    expect(keywordVolume).toHaveBeenCalledWith(
      expect.objectContaining({ locationCode: 2840, languageCode: "en" }),
    );
  });

  it("quotes the dry run per keyword and never calls the vendor", async () => {
    const result = await callTool(aiKeywordVolumeTool, {
      // Three of these are the same keyword after the fetcher's own
      // normalisation, so the estimate must not quote for five rows.
      keywords: ["geo tools", "Geo Tools", " geo tools ", "generative seo"],
    });
    const structured = result.structuredContent ?? {};

    expect(structured.dryRun).toBe(true);
    expect(structured.keywordCount).toBe(2);

    // **Derived from the constant rather than typed.** Two keywords at
    // `unitCost x 1000` credits each. The old `toBe(4)` was right for the old
    // price and would have kept passing while the number the customer reads
    // changed.
    const unitCredits = AI_KEYWORD_UNIT_COST_USD * 1000;
    expect(structured.estimatedCredits).toBeCloseTo(unitCredits * 2, 6);

    // **The copy must agree with the constant it is derived from.** This is the
    // assertion that would have caught the original drift: the prose quoted
    // `$0.002` as a literal while the calculation used the constant, so the two
    // said different things for as long as the price was wrong. It now builds the
    // expected string from the same number the credits came from.
    // **Asserted as a sentence an agent would need, not as the implementation's
    // own string.** The previous version built its expectation the way the code
    // did, so it agreed with the code when the code dropped the currency — a
    // test derived from the thing it tests cannot catch that thing being wrong.
    expect(textOf(result)).toContain(
      `USD ${AI_KEYWORD_UNIT_COST_USD} per keyword`,
    );
    // And explicitly: a bare figure with no unit is not a price.
    expect(textOf(result)).not.toMatch(/\(\d+\.\d+ per keyword/);
    expect(keywordVolume).not.toHaveBeenCalled();
    expect(createDataforseoClient).not.toHaveBeenCalled();
  });
});
