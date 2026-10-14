import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  callTool,
  getCitationGap,
  latestReadinessState,
  listAnswerHistory,
  listRuns,
  listTargets,
  TARGET,
  textOf,
} from "./geo-tools-test-support";

/**
 * The citation gap, and the runs that built the archive.
 *
 * The gap is the one this product exists to surface — a page a model *read and
 * did not use* — so the words matter: the retrieval-unavailable explanation,
 * the refusal to publish an unexplained rate, and the arrival date that must
 * arrive *after* the sample size that qualifies it.
 */

const { getGeoCitationGapTool, getGeoRunsTool } =
  await import("@/server/mcp/tools/geo-diagnostic-tools");
const { getGeoAnswerHistoryTool } =
  await import("@/server/mcp/tools/geo-read-tools");

describe("get_geo_citation_gap", () => {
  beforeEach(() => {
    listTargets.mockResolvedValue([TARGET]);
    // No audit ran, which is the honest default for a young project and the
    // third of the module's three readiness states.
    latestReadinessState.mockResolvedValue("unknown");
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
      winWindow: { retrievals: 40, citations: 10 },
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
      winWindow: { retrievals: 0, citations: 0 },
    });
    const result = await callTool(getGeoCitationGapTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(textOf(result)).toMatch(/0 page\(s\) retrieved but never cited/);
  });

  it("puts the win rate beside the gap list, with its denominator", async () => {
    // CL-502's second half reaches the wire here. The list leads and the rate
    // follows with the sample size — ten gaps out of ten retrievals and ten out
    // of four hundred are different problems, and a bare list cannot say which.
    getCitationGap.mockResolvedValue({
      platform: "chat_gpt",
      retrievalAvailable: true,
      domain: "acme.com",
      gaps: [],
      winWindow: { retrievals: 40, citations: 10 },
    });
    const result = await callTool(getGeoCitationGapTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    const text = textOf(result);
    expect(text).toMatch(/Of 40 retrieved pages, 10 were cited — 25%/);
    expect(result.structuredContent?.winProbability).toMatchObject({
      baseRate: 0.25,
      retrievalsObserved: 40,
      citationsObserved: 10,
    });
    // The refusal travels too: this is a rate over a window, not a market share.
    expect(text).toMatch(/not the share of prompts/);
  });

  it("quotes the conservative end while the audit still has fixes outstanding", async () => {
    // The readiness ingredient, composed: an unquotable target is quoted the low
    // end of its own interval and the reason is named, rather than the point
    // estimate that flatters it.
    latestReadinessState.mockResolvedValue("fixes-outstanding");
    getCitationGap.mockResolvedValue({
      platform: "chat_gpt",
      retrievalAvailable: true,
      domain: "acme.com",
      gaps: [],
      winWindow: { retrievals: 40, citations: 10 },
    });
    const result = await callTool(getGeoCitationGapTool, {
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(textOf(result)).toMatch(/low end of the interval is quoted/);

    // **The bound, asserted without reading the field out of an `unknown`.**
    // `expect.closeTo` with a ceiling is not expressible, so the comparison is
    // posed the other way: the quoted value must be strictly *inside* the
    // interval below the point estimate. A cast to pull one field out of the
    // payload is what the repo's lint rules refuse, and the same claim is
    // checkable from the matcher.
    const winProbability = z.object({
      probability: z.number(),
      low: z.number().nullable(),
      baseRate: z.number().nullable(),
    });
    const parsed = winProbability.safeParse(
      result.structuredContent?.winProbability,
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.probability).toBeLessThan(
        parsed.data.baseRate ?? Number.POSITIVE_INFINITY,
      );
      expect(parsed.data.probability).toBeCloseTo(
        parsed.data.low ?? Number.POSITIVE_INFINITY,
        10,
      );
    }
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
