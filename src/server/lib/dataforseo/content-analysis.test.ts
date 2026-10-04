import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  PHRASE_TRENDS_HISTORY_FLOOR,
  fetchContentAnalysisSummary,
  fetchPhraseTrends,
} from "@/server/lib/dataforseo/content-analysis";
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

/** The documented trends example, two date buckets, trimmed. */
function trendsEnvelope() {
  return {
    status_code: 20000,
    tasks: [
      {
        id: "t-1",
        status_code: 20000,
        path: ["v3", "content_analysis", "phrase_trends", "live"],
        cost: 0.02009,
        result_count: 2,
        result: [
          {
            type: "content_analysis_trends",
            date: "2026-08-01",
            total_count: 1159252,
            rank: 590,
            top_domains: [{ domain: "xsplit.com", count: 53678 }],
            sentiment_connotations: { happiness: 32457, fun: 1212 },
            connotation_types: {
              positive: 390289,
              negative: 135916,
              neutral: 589516,
            },
            page_types: { blogs: 622032 },
            countries: { US: 86504 },
            languages: { en: 712751 },
          },
          {
            type: "content_analysis_trends",
            date: "2026-09-01",
            total_count: 1430023,
            rank: 613,
            top_domains: [{ domain: "vdsitsolutions.com", count: 341567 }],
            sentiment_connotations: { happiness: 36007, fun: 971 },
            connotation_types: {
              positive: 735206,
              negative: 175341,
              neutral: 468693,
            },
            page_types: { blogs: 809466 },
            countries: { BE: 344693 },
            languages: { en: 963542 },
          },
        ],
      },
    ],
  };
}

describe("fetchPhraseTrends", () => {
  const base = { keyword: "logitech", dateFrom: "2026-08-01" };

  it("posts to phrase_trends/live, with the path pinned", async () => {
    // Same reason as `summary`: a plausible wrong path here is
    // `content_analysis_trends/live`, which reads like the response's `type`.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(trendsEnvelope())));

    await fetchPhraseTrends(base);

    expect(requestUrl(fetchMock)).toContain(
      "/v3/content_analysis/phrase_trends/live",
    );
    expect(requestBody(fetchMock)[0]).toMatchObject({
      keyword: "logitech",
      date_from: "2026-08-01",
      date_group: "month",
    });
  });

  it("requires date_from, because the vendor treats it as a billed rejection", async () => {
    await expect(
      fetchPhraseTrends({ keyword: "logitech", dateFrom: "" }),
    ).rejects.toThrow(/date_from is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a range starting before the vendor's history", async () => {
    // Without this the request succeeds and returns an **empty series**, which
    // reads as "nothing was ever said about this topic" rather than "we hold
    // no data that far back". Those are different answers and only the second
    // is true.
    await expect(
      fetchPhraseTrends({
        keyword: "logitech",
        dateFrom: "2020-01-01",
      }),
    ).rejects.toThrow(new RegExp(PHRASE_TRENDS_HISTORY_FLOOR));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed date_to, because that is a billed rejection", async () => {
    // `dateFrom` was validated and `dateTo` was not — the same defect twice: a
    // bad date reaching a paid endpoint costs money to learn something
    // knowable locally.
    await expect(
      fetchPhraseTrends({ ...base, dateTo: "01/09/2026" }),
    ).rejects.toThrow(/date_to must be YYYY-MM-DD/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a date_to before date_from, which is a range that cannot exist", async () => {
    // It would succeed at the provider and return an empty series, which reads
    // as "nothing was ever said about this topic" rather than "that range is
    // backwards".
    await expect(
      fetchPhraseTrends({ ...base, dateTo: "2026-01-01" }),
    ).rejects.toThrow(/earlier than date_from/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalises date_to once, so the request and the record cannot disagree", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(trendsEnvelope())));

    const { data } = await fetchPhraseTrends({
      ...base,
      dateTo: "  2026-09-01  ",
    });

    expect(requestBody(fetchMock)[0]).toMatchObject({ date_to: "2026-09-01" });
    expect(data.dateTo).toBe("2026-09-01");
  });

  it("omits date_to entirely when none is supplied, rather than sending an empty one", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(trendsEnvelope())));

    const { data } = await fetchPhraseTrends(base);

    // The vendor defaults `date_to` to today, so sending nothing is correct —
    // and `data.dateTo` stays null rather than claiming a range we did not set.
    expect(requestBody(fetchMock)[0]).not.toHaveProperty("date_to");
    expect(data.dateTo).toBeNull();
  });

  it("sends internal_list_limit explicitly, because this endpoint's default is 1", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(trendsEnvelope())));

    await fetchPhraseTrends(base);

    expect(requestBody(fetchMock)[0]).toMatchObject({
      internal_list_limit: 10,
    });
  });

  it("words the direction rather than reporting a percentage", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(trendsEnvelope())));

    const { data } = await fetchPhraseTrends(base);

    // `total_count` swings by 23% between these two buckets, so a change in
    // *share* is not a change in *volume* — and a ratio of two ratios whose
    // denominators moved is not a finding.
    expect(data.direction).toBe("rising");
    expect(JSON.stringify(data)).not.toMatch(/"(change|delta|growthPct)"/i);
  });

  it("says the series is the open web, never an AI reading", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(trendsEnvelope())));

    const { data } = await fetchPhraseTrends(base);

    expect(data.basis).toMatch(/open web/i);
    expect(data.basis).toMatch(/not an AI engine/i);
  });

  it("returns a null direction when there is only one usable bucket", async () => {
    // One point is a measurement, not a direction.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              path: ["v3", "content_analysis", "phrase_trends", "live"],
              cost: 0.02,
              result: [
                {
                  date: "2026-08-01",
                  total_count: 10,
                  connotation_types: {
                    positive: 5,
                    negative: 3,
                    neutral: 2,
                  },
                },
              ],
            },
          ],
        }),
      ),
    );

    const { data } = await fetchPhraseTrends(base);

    expect(data.points).toHaveLength(1);
    expect(data.direction).toBeNull();
  });

  it("returns an empty series rather than inventing a direction when nothing came back", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              path: ["v3", "content_analysis", "phrase_trends", "live"],
              cost: 0.02,
              result: [],
            },
          ],
        }),
      ),
    );

    const { data } = await fetchPhraseTrends(base);

    expect(data.points).toEqual([]);
    expect(data.direction).toBeNull();
  });
});
