import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

/**
 * The GEO tools' honesty contract.
 *
 * These tools read the archive, so they cost nothing — which means the only way
 * they can mislead a paying user is by saying something false. So the tests are
 * about the words, not the plumbing: no combined platform number, no
 * unexplained empty gap, and no implying a capability the vendor does not have.
 */

// `withMcpProjectAuth` performs a real project-membership lookup before the
// handler runs. Mocking the auth wrapper (rather than the database) is what makes
// these tests about the tool's wording rather than about authorisation, and it
// guarantees no SQL can execute.
vi.mock("cloudflare:workers", () => ({ env: {} }));

const listTargets = vi.fn();
const getVisibility = vi.fn();
const getCitationGap = vi.fn();
const listAnswerHistory = vi.fn();
const listRuns = vi.fn();
const forecastForStoredSeries = vi.fn();

/**
 * The forecast reader reaches `@/db`, so it is mocked like `GeoService` above:
 * these suites are about the *wording* a tool hands an agent, and a tool that
 * cannot say what it does not know is the thing being tested.
 */
vi.mock("@/server/features/geo/services/visibilityForecastReads", () => ({
  forecastForStoredSeries,
}));

vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { listTargets },
}));
vi.mock("@/server/features/geo/services/GeoService", () => ({
  GeoService: {
    getVisibility,
    getCitationGap,
    listAnswerHistory,
    listRuns,
  },
}));
// `withMcpProjectAuth` does two things: run the membership check, and hand the
// handler a *context* built from it (auth, project, billing). The mock performs
// the second job with real values and skips the first, so these tests are about
// the tool's wording rather than about authorisation — and no SQL can run.
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

const {
  getGeoAnswerHistoryTool,
  getGeoVisibilityForecastTool,
  getGeoVisibilityTool,
  listGeoTargetsTool,
} = await import("@/server/mcp/tools/geo-read-tools");
const { getGeoCitationGapTool, getGeoRunsTool } =
  await import("@/server/mcp/tools/geo-diagnostic-tools");
const { getGeoTopCitationsTool } =
  await import("@/server/mcp/tools/geo-top-citations-tool");

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

const TARGET = { id: "t1", domain: "acme.com", name: "Acme" };

/**
 * Read the human-facing text out of an MCP response.
 *
 * The tools put their whole point in prose — the "must not be summed" warning,
 * the retrieval-unavailable explanation — so the assertions are about wording,
 * which is the one thing an agent will actually repeat to a user.
 */
function textOf(result: ToolResult) {
  return textContent(result);
}

/**
 * Call a tool the way the MCP server does: validated args in, a full tool
 * context in. The auth wrapper (mocked above) supplies the project-scoped context
 * the handler expects, including `baseUrl`, which `buildProjectMeta` needs to
 * build the dashboard link it returns in `meta`.
 */
async function callTool<TTool extends { handler: unknown }>(
  tool: TTool,
  data: Record<string, unknown>,
): Promise<ToolResult> {
  // Generic rather than one fixed handler type: each tool's handler takes its own
  // validated args, and pinning a single shared signature would force a cast at
  // every call site. The tools are loaded dynamically above, so their inferred
  // types flow through untouched.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool graph is loaded dynamically, so its concrete handler type is not visible here; this widens `unknown` to the one shape the MCP server guarantees
  const handler = tool.handler as (
    args: Record<string, unknown>,
    context: unknown,
  ) => Promise<ToolResult>;
  // The handler reads its fields straight off `args`; `projectId` is injected by
  // the auth wrapper in production and supplied here.
  return handler({ projectId: "p1", ...data }, makeToolContext());
}

describe("list_geo_targets", () => {
  it("tells the user how to start when nothing is monitored", async () => {
    listTargets.mockResolvedValue([]);
    const result = await callTool(listGeoTargetsTool, { projectId: "p1" });
    expect(textOf(result)).toMatch(/no brands are being monitored/i);
  });

  it("names the market for each target, since it is part of the identity", async () => {
    listTargets.mockResolvedValue([
      { ...TARGET, locationCode: 2840, languageCode: "en" },
    ]);
    const result = await callTool(listGeoTargetsTool, { projectId: "p1" });
    expect(textOf(result)).toMatch(/2840\/en/);
  });
});

describe("get_geo_visibility", () => {
  beforeEach(() => {
    listTargets.mockResolvedValue([TARGET]);
  });

  it("reports each platform separately and says they must not be summed", async () => {
    getVisibility.mockResolvedValue({
      target: TARGET,
      since: "2026-08-30T00:00:00.000Z",
      perPlatform: [
        { platform: "chat_gpt", mentions: 12, recent: [] },
        { platform: "google_ai_overview", mentions: 40, recent: [] },
      ],
    });
    const result = await callTool(getGeoVisibilityTool, {
      projectId: "p1",
      domain: "acme.com",
    });
    const text = textOf(result);
    // The 198x trap: these two numbers are not the same unit.
    expect(text).toMatch(/not summed across platforms/i);
    expect(result.structuredContent?.perPlatform).toHaveLength(2);
  });

  it("explains an unmonitored domain instead of failing opaquely", async () => {
    listTargets.mockResolvedValue([]);
    const result = await callTool(getGeoVisibilityTool, {
      projectId: "p1",
      domain: "other.com",
    });
    expect(textOf(result)).toMatch(/not a monitored target/i);
  });

  it("accepts a pasted URL, since that is what people type", async () => {
    listTargets.mockResolvedValue([TARGET]);
    getVisibility.mockResolvedValue({
      target: TARGET,
      since: "2026-08-30T00:00:00.000Z",
      perPlatform: [],
    });
    const result = await callTool(getGeoVisibilityTool, {
      projectId: "p1",
      domain: "https://www.acme.com/pricing",
    });
    // It resolved to the target rather than reporting "not monitored".
    expect(textOf(result)).not.toMatch(/not a monitored target/i);
  });
});

describe("get_geo_citation_gap", () => {
  beforeEach(() => {
    listTargets.mockResolvedValue([TARGET]);
  });

  it("states the platform's retrieval limit instead of returning an empty success", async () => {
    // The most important sentence in this file. Google AI Overviews returns
    // citations but not retrievals; a confident empty list would tell the user
    // their pages were never retrieved, which we simply do not know.
    getCitationGap.mockResolvedValue({
      platform: "google_ai_overview",
      retrievalAvailable: false,
      reason:
        "DataForSEO returns citations for google_ai_overview but not the pages it retrieved.",
      gaps: [],
    });
    const result = await callTool(getGeoCitationGapTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "google_ai_overview",
    });
    const text = textOf(result);
    expect(text).toMatch(/unavailable/i);
    expect(text).toMatch(/but not the pages it retrieved/i);
    expect(result.structuredContent?.retrievalAvailable).toBe(false);
  });

  it("names the fix when a page was retrieved and not cited", async () => {
    getCitationGap.mockResolvedValue({
      platform: "chat_gpt",
      retrievalAvailable: true,
      domain: "acme.com",
      gaps: [{ url: "https://acme.com/pricing", rank: 2 }],
    });
    const result = await callTool(getGeoCitationGapTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    const text = textOf(result);
    expect(text).toMatch(/acme\.com\/pricing/);
    // A retrieved-but-uncited page is a directness problem, not a volume one.
    expect(text).toMatch(/directness problem, not a volume problem/i);
  });

  it("reports zero gaps as zero, not as a failure", async () => {
    getCitationGap.mockResolvedValue({
      platform: "chat_gpt",
      retrievalAvailable: true,
      domain: "acme.com",
      gaps: [],
    });
    const result = await callTool(getGeoCitationGapTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(textOf(result)).toMatch(/0 page\(s\) retrieved but never cited/);
  });
});

describe("get_geo_answer_history", () => {
  it("says there is nothing to diff until a second capture exists", async () => {
    listTargets.mockResolvedValue([TARGET]);
    listAnswerHistory.mockResolvedValue([
      {
        id: "a1",
        answeredAt: "2026-09-01",
        prompt: "best geo tool",
        answerText: null,
        modelName: null,
      },
    ]);
    const result = await callTool(getGeoAnswerHistoryTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
      prompt: "best geo tool",
    });
    expect(textOf(result)).toMatch(/nothing to diff yet/i);
  });

  it("does not present a missing answer body as a real answer", async () => {
    // llm_mentions returns citations but no answer text. Rendering that as an
    // empty answer would claim the model said nothing.
    listTargets.mockResolvedValue([TARGET]);
    listAnswerHistory.mockResolvedValue([
      {
        id: "a1",
        answeredAt: "2026-09-01",
        prompt: "best geo tool",
        answerText: null,
        modelName: null,
      },
    ]);
    const result = await callTool(getGeoAnswerHistoryTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
      prompt: "best geo tool",
    });
    expect(textOf(result)).toMatch(/no answer body recorded/i);
  });
});

describe("get_geo_runs", () => {
  it("explains an empty archive rather than showing an empty table", async () => {
    listRuns.mockResolvedValue([]);
    const result = await callTool(getGeoRunsTool, { projectId: "p1" });
    expect(textOf(result)).toMatch(/no monitoring runs recorded yet/i);
  });

  it("shows who triggered each run", async () => {
    listRuns.mockResolvedValue([
      {
        id: "s1",
        startedAt: "2026-09-28T03:17:00.000Z",
        completedAt: "2026-09-28T03:18:00.000Z",
        status: "complete",
        createdBy: "schedule",
      },
    ]);
    const result = await callTool(getGeoRunsTool, { projectId: "p1" });
    expect(textOf(result)).toMatch(/by schedule/);
  });
});

/**
 * A forecast payload shaped like the reader's, with the rate measurable.
 *
 * At module scope rather than inside the `describe`: `consistent-function-scoping`
 * is right that it captures nothing from there, and a fixture declared inside a
 * describe reads as though it did.
 */
function measurableForecast(overrides?: {
  rate?: number | null;
  basedOn?: number;
  skipped?: { unknownDenominator: number; noText: number; noAnswers: number };
  note?: string | null;
  /** Null means the look-back window covered every run. */
  totalRunsInProject?: number | null;
}): unknown {
  const rate = overrides?.rate === undefined ? 0.25 : overrides.rate;
  const basedOn = overrides?.basedOn ?? 8;
  // The window reads one "run" per observation here, so `considered` lines up with
  // the array length rather than being a second number to keep in step.
  const observations = Array.from({ length: basedOn === 0 ? 1 : basedOn });
  return {
    series: {
      domain: "acme.com",
      platform: "chat_gpt",
      observations,
      windowed: {
        considered: observations.length,
        totalRunsInProject: overrides?.totalRunsInProject ?? null,
      },
      skipped: overrides?.skipped ?? {
        unknownDenominator: 0,
        noText: 0,
        noAnswers: 0,
      },
      note: overrides?.note ?? null,
    },
    forecast: {
      current: [
        {
          platform: "chat_gpt",
          rate,
          low: rate === null ? null : 0.06,
          high: rate === null ? null : 0.61,
          basedOn,
          confidence: basedOn === 0 ? "none" : "low",
        },
      ],
      direction: { perWeek: null, confidence: "none", basedOnWeeks: 0 },
      doesNotClaim: "This is not a market share.",
    },
  };
}

describe("get_geo_visibility_forecast", () => {
  beforeEach(() => {
    forecastForStoredSeries.mockReset();
  });

  it("leads with the sample size, not the percentage", async () => {
    // **The whole point of the tool.** An agent reading only the first line must
    // not come away with "25%". 4 of 8 prompts and 4 of 400 are the same sentence
    // and different facts, and a percentage alone invites quoting the flattering
    // half of that.
    forecastForStoredSeries.mockResolvedValue(measurableForecast());
    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    const text = textOf(result);
    expect(text).toMatch(/Based on 8 prompts/);
    // Order asserted, not just presence: the count has to come first, or a
    // reader who stops early is misled about what the number means.
    expect(text.indexOf("Based on 8 prompts")).toBeLessThan(
      text.indexOf("25%"),
    );
    // And the interval is present, because at n=8 the spread *is* the measurement.
    expect(text).toMatch(/Between 6% and 61%/);
  });

  it("says it cannot give a rate when no run recorded a denominator", async () => {
    // The common case: the Live path cannot know how many prompts the vendor
    // asked. This must be a sentence, not an error and not a bare null — an agent
    // that sees a failure will retry, and one that sees a number will use it.
    forecastForStoredSeries.mockResolvedValue(
      measurableForecast({
        rate: null,
        basedOn: 0,
        skipped: { unknownDenominator: 4, noText: 0, noAnswers: 0 },
        note: "No run has recorded how many prompts it asked, so there is nothing to forecast.",
      }),
    );

    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    const text = textOf(result);
    expect(text).toMatch(/no rate to give/i);
    // It must not have produced a percentage either.
    expect(text).not.toMatch(/\d+%/);
    // And it explains the excluded runs, which is what a reader asks next.
    expect(text).toMatch(/4 run\(s\) are not included/);
  });

  it("states the look-back window, so an agent does not read a limit as a history", async () => {
    // The forecast reads a bounded window. An agent told "forecasted from 8 of 8
    // runs" reasonably concludes the brand has eight runs of history — when it has
    // two hundred, and the window simply stopped reading. Acting on that
    // ("visibility has been flat for eight runs") is a conclusion drawn from a
    // limit, so the count has to be in the payload as a number.
    forecastForStoredSeries.mockResolvedValue(
      measurableForecast({ totalRunsInProject: 40 }),
    );
    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(textOf(result)).toMatch(
      /read the 8 most recent run\(s\); 32 older run\(s\) were not read/,
    );
  });

  it("says nothing about a window when it covered the whole archive", async () => {
    // The common case for a young project. A window clause here would be noise,
    // and noise in a tool description is what makes agents skip reading it.
    forecastForStoredSeries.mockResolvedValue(measurableForecast());
    const result = await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(textOf(result)).not.toMatch(/look-back window/i);
  });

  it("reads through the authorized project rather than a target id", async () => {
    // The tool takes a domain and resolves the target server-side. It must not
    // look the target up itself and pass an id, because that would be a second
    // identity the auth wrapper cannot see.
    forecastForStoredSeries.mockResolvedValue(measurableForecast());
    await callTool(getGeoVisibilityForecastTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(forecastForStoredSeries).toHaveBeenCalledWith({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(listTargets).not.toHaveBeenCalled();
  });
});

describe("tool annotations", () => {
  it("marks every GEO tool read-only, because they only read the archive", () => {
    // None of these spend vendor credits, so an agent should never hesitate to
    // call them. A wrong readOnlyHint makes agents prompt for confirmation.
    for (const tool of [
      listGeoTargetsTool,
      getGeoVisibilityTool,
      getGeoVisibilityForecastTool,
      getGeoCitationGapTool,
      getGeoAnswerHistoryTool,
      getGeoRunsTool,
      getGeoTopCitationsTool,
    ]) {
      expect(tool.config.annotations.readOnlyHint).toBe(true);
      expect(tool.config.annotations.destructiveHint).toBe(false);
    }
  });
});
