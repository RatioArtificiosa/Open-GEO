import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { fetchContentAnalysisSummary } from "@/server/lib/dataforseo/content-analysis";
import { requestBody, requestUrl } from "./test-support";

/** The documented example response, trimmed to the fields we read. */
function envelope() {
  return {
    status_code: 20000,
    tasks: [
      {
        id: "09131956-0696-0464-0000-25b5cb2c0157",
        status_code: 20000,
        path: ["v3", "content_analysis", "summary", "live"],
        // **The documented live example reports 0.02003, not the price book's
        // 0.024.** Billing reads the task's own `cost`, so the price book is
        // only ever an estimate and this test pins what is actually returned.
        cost: 0.02003,
        result_count: 1,
        result: [
          {
            type: "content_analysis_summary",
            total_count: 959052,
            rank: 586,
            top_domains: [
              { domain: "nerdpart.com", count: 31783 },
              { domain: "clubic.com", count: 12576 },
            ],
            sentiment_connotations: {
              anger: 0,
              happiness: 22868,
              love: 175266,
              sadness: 12076,
              fun: 1309,
            },
            connotation_types: {
              positive: 261992,
              negative: 68043,
              neutral: 108682,
            },
            page_types: { blogs: 60789, news: 270865 },
            countries: { US: 88807, UA: 58655 },
            languages: { en: 351137 },
          },
        ],
      },
    ],
  };
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchContentAnalysisSummary", () => {
  it("posts to content_analysis/summary/live, with the path pinned", async () => {
    // **The URL is the assertion this directory exists for.** `ai-keywords`
    // shipped 14 green tests over a client pointing at a path that does not
    // exist, because the tests only checked the request body. Here the path is
    // wrong in a plausible way — `content_analysis_summary/live` and
    // `/v3/content_analysis/summary/live` are both easy to get backwards.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(envelope())));

    await fetchContentAnalysisSummary({ keyword: "logitech" });

    expect(requestUrl(fetchMock)).toContain(
      "/v3/content_analysis/summary/live",
    );
    expect(requestBody(fetchMock)[0]).toMatchObject({ keyword: "logitech" });
  });

  it("reports the positive share over the classified total, and names the denominator", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(envelope())));

    const { data } = await fetchContentAnalysisSummary({ keyword: "logitech" });

    // 261992 / (261992 + 68043 + 108682) = 0.59718
    expect(data.polarity).toEqual({
      positive: 261992,
      negative: 68043,
      neutral: 108682,
    });
    expect(data.positiveShare).toBeCloseTo(0.5972, 4);
    // The share is arithmetic we can defend; its denominator is not a sample
    // anyone chose, and the caller needs to know that before quoting it.
    expect(data.countBasis).toMatch(/not a sample/i);
    expect(data.countBasis).toMatch(/not an AI engine/i);
  });

  it("sends internal_list_limit explicitly, because this endpoint's default is 1", async () => {
    // Same documented inconsistency as llm_mentions: the default here is 1, so
    // a caller who does not ask gets one domain and reads it as a leaderboard.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(envelope())));

    await fetchContentAnalysisSummary({ keyword: "logitech" });

    expect(requestBody(fetchMock)[0]).toMatchObject({
      internal_list_limit: 10,
    });
  });

  it("returns the thresholds it sent, because they change what the counts mean", async () => {
    // Both connotation thresholds default to 0.4 and *remove rows from the
    // response*, so a summary fetched with a different threshold answers a
    // different question rather than being a filtered view of the same one.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(envelope())));

    const { data } = await fetchContentAnalysisSummary({
      keyword: "logitech",
      positiveConnotationThreshold: 0.7,
    });

    expect(data.thresholds.positiveConnotation).toBe(0.7);
    expect(data.thresholds.sentimentConnotation).toBe(0.4);
    expect(requestBody(fetchMock)[0]).toMatchObject({
      positive_connotation_threshold: 0.7,
    });
  });

  it("keeps a zero sentiment label but drops an absent one", async () => {
    // The documented response omits labels it has no count for. Reporting those
    // as zero would turn "we have no measurement" into "measured as none".
    fetchMock.mockResolvedValue(new Response(JSON.stringify(envelope())));

    const { data } = await fetchContentAnalysisSummary({ keyword: "logitech" });

    // `anger: 0` was in the response, so it is a real zero.
    expect(data.sentimentConnotations.anger).toBe(0);
    // `share` was not in the response, so it is absent rather than zero.
    expect("share" in data.sentimentConnotations).toBe(false);
  });

  it("returns a null share rather than zero when nothing was classified", async () => {
    // "No pages were classified" and "no pages were positive" are different
    // claims, and only the second is a sentiment finding.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              path: ["v3", "content_analysis", "summary", "live"],
              cost: 0.02,
              result: [
                {
                  type: "content_analysis_summary",
                  total_count: 0,
                  top_domains: [],
                },
              ],
            },
          ],
        }),
      ),
    );

    const { data } = await fetchContentAnalysisSummary({ keyword: "obscure" });

    expect(data.polarity).toEqual({ positive: 0, negative: 0, neutral: 0 });
    expect(data.positiveShare).toBeNull();
    expect(data.totalCount).toBe(0);
  });

  it("drops a top domain with no count rather than reporting it as zero", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              path: ["v3", "content_analysis", "summary", "live"],
              cost: 0.02,
              result: [
                {
                  total_count: 10,
                  top_domains: [
                    { domain: "example.com", count: 5 },
                    { domain: "broken.example", count: null },
                    { domain: null, count: 3 },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    const { data } = await fetchContentAnalysisSummary({ keyword: "logitech" });

    expect(data.topDomains).toEqual([{ domain: "example.com", count: 5 }]);
  });

  it("refuses a blank keyword rather than sending a guaranteed rejection", async () => {
    await expect(
      fetchContentAnalysisSummary({ keyword: "   " }),
    ).rejects.toThrow(/keyword is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the task's own cost, not the price book's estimate", async () => {
    // The price book says $0.024; the documented live response says 0.02003.
    // Billing reads the task's own cost, and this pins that the raw figure is
    // what reaches the metering layer.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(envelope())));

    const { billing } = await fetchContentAnalysisSummary({
      keyword: "logitech",
    });

    expect(billing.costUsd).toBe(0.02003);
  });
});
