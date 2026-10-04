import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";
import type * as dataforseo from "@/server/lib/dataforseo";

// `withMcpProjectAuth` is mocked so these tests are about the tool's output,
// not authorisation, and no SQL can run.
vi.mock("cloudflare:workers", () => ({ env: {} }));

/**
 * All four seams are on the **metered client**, because this tool makes up to
 * three billed calls and the client's `meter` is what performs the balance
 * check and the usage record. Mocking a fetcher would produce tests that pass
 * against unmetered code — the defect CodeRabbit found in an earlier
 * milestone.
 */
const contentSearch = vi.fn();
const contentSummary = vi.fn();
const contentSentiment = vi.fn();
const contentPhraseTrends = vi.fn();
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

const { getWebCitationsTool } =
  await import("@/server/mcp/tools/get-web-citations-tool");

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

const PAGES = {
  keyword: "crm software",
  totalCount: 296,
  nextOffsetToken: null,
  orderBy: ["score,desc"],
  basis: "Pages in DataForSEO's index.",
  rows: [
    {
      url: "https://reddit.com/r/crm",
      domain: "reddit.com",
      prominence: 5900.9,
      domainRank: 493,
      urlRank: 126,
      spamScore: 0,
      country: "US",
      language: "en",
      pageTypes: ["message-boards"],
      title: "Best CRMs 2026",
      snippet: "We ranked twenty tools…",
      // **Probabilities, 0-1.**
      polarityScores: {
        positive: 0.1233,
        negative: 0.4121,
        neutral: 0.4645,
      },
      connotationScores: {
        anger: null,
        happiness: 0.0707,
        love: 0.0959,
        sadness: 0.03,
        share: null,
        fun: 0.1529,
      },
      contentQualityScore: 90,
      semanticLocation: "90",
      groupDate: "2021-09-08 20:23:59 +00:00",
    },
  ],
};

const AGGREGATE = {
  keyword: "crm software",
  totalCount: 296,
  rank: 586,
  topDomains: [],
  sentimentConnotations: { happiness: 32457 },
  /** **Counts, not probabilities.** Same field name, different unit. */
  polarity: { positive: 261_992, negative: 68_043, neutral: 108_682 },
  positiveShare: 0.5972,
  countBasis: "Citation counts over DataForSEO's whole index.",
  thresholds: { positiveConnotation: 0.4, sentimentConnotation: 0.4 },
  pageTypes: {},
  countries: {},
  languages: {},
};

function useBothSides() {
  contentSearch.mockResolvedValue(PAGES);
  contentSummary.mockResolvedValue(AGGREGATE);
  createDataforseoClient.mockReturnValue({
    serp: {
      contentSearch,
      contentSummary,
      contentSentiment,
      contentPhraseTrends,
    },
  });
}

describe("get_web_citations", () => {
  beforeEach(() => {
    for (const mock of [
      contentSearch,
      contentSummary,
      contentSentiment,
      contentPhraseTrends,
      createDataforseoClient,
    ]) {
      mock.mockReset();
    }
  });

  it("returns the citing pages with their own sentiment probabilities", async () => {
    useBothSides();

    const result = await callTool(getWebCitationsTool, {
      keyword: "crm software",
      dry_run: false,
    });
    const text = textOf(result);

    expect(text).toContain("reddit.com");
    expect(text).toContain("p+0.12");
    expect(result.structuredContent?.totalCount).toBe(296);
    expect(result.structuredContent?.pages).toHaveLength(1);
  });

  it("states that the per-page figures and the aggregate are not comparable", async () => {
    // The whole reason this tool warns: 0.41 beside 261,992 as one scale is
    // wrong by six orders of magnitude and both render as plausible.
    useBothSides();

    const text = textOf(
      await callTool(getWebCitationsTool, {
        keyword: "crm software",
        dry_run: false,
      }),
    );

    expect(text).toMatch(/not comparable/i);
    expect(text).toMatch(/a page count/i);
  });

  it("does not merge the two into a single sentiment number", async () => {
    useBothSides();

    const result = await callTool(getWebCitationsTool, {
      keyword: "crm software",
      dry_run: false,
    });
    // Matched on the **parent** rather than a narrowed local: `structuredContent`
    // is `unknown`-shaped, and `as Record<string, unknown>` would be the stand-in
    // that constrains nothing — exactly the shape of the defect this assertion
    // exists to catch in the code it is testing.
    //
    // Named for what each counts, so a reader cannot mistake one for the other.
    const serialised = JSON.stringify(result.structuredContent?.aggregate);
    expect(result.structuredContent?.aggregate).toMatchObject({
      positiveCitations: 261_992,
      negativeCitations: 68_043,
    });
    // The basis names the corpus, because these are counts over an index rather
    // than probabilities about a page.
    expect(serialised).toContain("whole index");
    // And no field that names a merged figure.
    expect(serialised).not.toMatch(/blended|combined|overall/i);
  });

  it("sorts by prominence by default, not by the vendor's anger-first default", async () => {
    useBothSides();

    await callTool(getWebCitationsTool, {
      keyword: "crm software",
      dry_run: false,
    });

    expect(contentSearch).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: ["score,desc"] }),
    );
  });

  it("offers anger-first when the caller is triaging complaints", async () => {
    useBothSides();

    await callTool(getWebCitationsTool, {
      keyword: "crm software",
      sortBy: "anger",
      dry_run: false,
    });

    expect(contentSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: ["content_info.sentiment_connotations.anger,desc"],
      }),
    );
  });

  it("says an empty result is an absence of mentions, not proof of none", async () => {
    contentSearch.mockResolvedValue({ ...PAGES, totalCount: 0, rows: [] });
    contentSummary.mockResolvedValue(AGGREGATE);
    createDataforseoClient.mockReturnValue({
      serp: {
        contentSearch,
        contentSummary,
        contentSentiment,
        contentPhraseTrends,
      },
    });

    const text = textOf(
      await callTool(getWebCitationsTool, {
        keyword: "obscure topic",
        dry_run: false,
      }),
    );

    expect(text).toMatch(/absence of mentions/i);
    expect(text).not.toMatch(/no mentions exist/i);
  });

  it("keeps emotions and trend off unless asked, because they are separate reads", async () => {
    useBothSides();

    await callTool(getWebCitationsTool, {
      keyword: "crm software",
      dry_run: false,
    });

    expect(contentSentiment).not.toHaveBeenCalled();
    expect(contentPhraseTrends).not.toHaveBeenCalled();
  });

  it("quotes the trend as an extra request when it is asked for", async () => {
    useBothSides();
    contentPhraseTrends.mockResolvedValue({
      keyword: "crm software",
      dateFrom: "2025-10-04",
      dateTo: null,
      dateGroup: "month",
      searchMode: "as_is",
      points: [
        {
          date: "2025-09-01",
          totalCount: 10,
          rank: 1,
          positiveShare: 0.5,
          polarity: { positive: 5, negative: 5, neutral: 0 },
          topDomains: [],
        },
        {
          date: "2025-10-01",
          totalCount: 20,
          rank: 1,
          positiveShare: 0.7,
          polarity: { positive: 14, negative: 6, neutral: 0 },
          topDomains: [],
        },
      ],
      direction: "rising",
      basis: "Citing pages grouped by month.",
    });

    const result = await callTool(getWebCitationsTool, {
      keyword: "crm software",
      includeTrend: true,
      dry_run: false,
    });
    const text = textOf(result);

    expect(contentPhraseTrends).toHaveBeenCalledTimes(1);
    // Worded, and the reason is stated.
    expect(text).toMatch(/rising/);
    expect(text).toMatch(/word rather than a percentage/i);
    expect(result.structuredContent?.trend).toMatchObject({
      direction: "rising",
    });
  });

  it("reports a failed page read rather than returning an empty list", async () => {
    // An empty list after a failure reads as "nobody cites this", which is the
    // confident empty answer this product refuses to give.
    contentSearch.mockRejectedValue(new Error("DataForSEO HTTP 503"));
    contentSummary.mockResolvedValue(AGGREGATE);
    createDataforseoClient.mockReturnValue({
      serp: {
        contentSearch,
        contentSummary,
        contentSentiment,
        contentPhraseTrends,
      },
    });

    const result = await callTool(getWebCitationsTool, {
      keyword: "crm software",
      dry_run: false,
    });

    expect(result.structuredContent?.failure).toMatch(/503/);
    expect(result.structuredContent?.pages).toBeUndefined();
  });

  it("quotes the list and its aggregate together in the dry run", async () => {
    const result = await callTool(getWebCitationsTool, {
      keyword: "crm software",
      includeTrend: true,
    });
    const structured = result.structuredContent ?? {};

    expect(structured.dryRun).toBe(true);
    // 2 for the pages, 2 for the aggregate, 2 for the trend.
    expect(structured.estimatedCredits).toBe(6);
    expect(createDataforseoClient).not.toHaveBeenCalled();
  });

  it("points at the AI-side tool, because this data is the web's and not the engines'", async () => {
    useBothSides();

    const text = textOf(
      await callTool(getWebCitationsTool, {
        keyword: "crm software",
        dry_run: false,
      }),
    );

    // The most useful sentence in the response: an agent handed "sentiment"
    // with no audience will happily report it as what AI engines think.
    expect(text).toMatch(/not what AI engines say/i);
    expect(text).toContain("compare_ai_web_sentiment");
  });
});
