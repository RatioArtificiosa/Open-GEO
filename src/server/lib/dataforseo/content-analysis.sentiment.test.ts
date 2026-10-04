import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { fetchSentimentAnalysis } from "@/server/lib/dataforseo/content-analysis-sentiment";
import { requestBody, requestUrl } from "./test-support";

/**
 * `content_analysis/sentiment_analysis`.
 *
 * The interesting assertions are all about **what must not be done with this
 * data**, because the payload invites three separate mistakes: adding the
 * buckets together, reading a polarity as an emotion, and reading a null
 * page type as a missing measurement.
 *
 * Split from `content-analysis.test.ts` for the 400-line rule, one endpoint
 * per file.
 */

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One bucket, as the vendor sends it inside a distribution. */
function sentimentBucket(
  totalCount: number,
  overrides?: {
    connotations?: Record<string, number>;
    polarity?: { positive: number; negative: number; neutral: number };
    pageTypes?: Record<string, number | null>;
  },
) {
  return {
    total_count: totalCount,
    rank: 616,
    top_domains: [{ domain: "vdsitsolutions.com", count: 384346 }],
    sentiment_connotations: overrides?.connotations ?? {
      anger: 67,
      happiness: 151_184,
      fun: 4_955,
    },
    connotation_types: overrides?.polarity ?? {
      positive: 2_286_584,
      negative: 198_296,
      neutral: 785_304,
    },
    // **`organization: null` is the documented shape** — "no citations in that
    // page type", not "we did not measure it".
    page_types: overrides?.pageTypes ?? { blogs: 100, organization: null },
    countries: { BE: 390_724 },
  };
}

/** The documented sample's two distributions, trimmed. */
function sentimentEnvelope() {
  return {
    status_code: 20000,
    tasks: [
      {
        id: "t-1",
        status_code: 20000,
        path: ["v3", "content_analysis", "sentiment_analysis", "live"],
        cost: 0.02003,
        result_count: 1,
        result: [
          {
            type: "content_analysis_sentiment_analysis",
            positive_connotation_distribution: {
              positive: sentimentBucket(2_986_476),
              // **The finding this endpoint exists to show:** the negative
              // bucket holds 87,373 happiness-coded cites. Articles *about*
              // negativity, not negative articles.
              negative: sentimentBucket(1_683_708, {
                connotations: {
                  anger: 147,
                  happiness: 87_373,
                  sadness: 708,
                  fun: 4_890,
                },
                polarity: {
                  positive: 246_750,
                  negative: 1_176_349,
                  neutral: 252_617,
                },
              }),
              neutral: sentimentBucket(2_854_419),
            },
            sentiment_connotation_distribution: {
              anger: sentimentBucket(650, { pageTypes: { blogs: 125 } }),
              happiness: sentimentBucket(393_934),
              love: sentimentBucket(21_252),
              sadness: sentimentBucket(2_306),
              share: sentimentBucket(459_440),
              fun: sentimentBucket(19_412),
            },
          },
        ],
      },
    ],
  };
}

describe("fetchSentimentAnalysis", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(sentimentEnvelope())),
    );
  });

  it("posts to sentiment_analysis/live, with the path pinned", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(sentimentEnvelope())),
    );

    await fetchSentimentAnalysis({ keyword: "logitech" });

    expect(requestUrl(fetchMock)).toContain(
      "/v3/content_analysis/sentiment_analysis/live",
    );
    expect(requestBody(fetchMock)[0]).toMatchObject({ keyword: "logitech" });
  });

  it("keeps the two distributions apart, because polarity and emotion are different cuts", async () => {
    const { data } = await fetchSentimentAnalysis({ keyword: "logitech" });

    // The same corpus cut two ways. Collapsed into one "sentiment" number, a
    // topic could be overwhelmingly happiness-coded and simultaneously
    // negative-coded, and one of those facts would vanish.
    expect(data.byPolarity.positive?.totalCount).toBe(2_986_476);
    expect(data.byConnotation.happiness?.totalCount).toBe(393_934);
    expect(data.byConnotation.anger?.totalCount).toBe(650);
  });

  it("exposes the connotations inside a polarity bucket, so negative is not angry", async () => {
    const { data } = await fetchSentimentAnalysis({ keyword: "logitech" });
    const negative = data.byPolarity.negative;

    // A UI that read `byPolarity.negative.totalCount` as "articles that are
    // negative" would report a brand as widely hated on the strength of
    // articles written *about* other people's complaints.
    expect(negative?.totalCount).toBe(1_683_708);
    expect(negative?.connotations.happiness).toBe(87_373);
    // And the polarity mix *within* the bucket, which is a third number again.
    expect(negative?.polarityWithinBucket.negative).toBe(1_176_349);
  });

  it("preserves a null page type, which is a measurement and not an absence", async () => {
    const { data } = await fetchSentimentAnalysis({ keyword: "logitech" });
    const pageTypes = data.byPolarity.positive?.pageTypes;

    // `"organization": null` means "no citations of that page type". Dropping
    // it would make "blogs dominate this topic" and "this topic is only
    // discussed in forums" render identically.
    expect(pageTypes?.blogs).toBe(100);
    expect(pageTypes).toHaveProperty("organization");
    expect(pageTypes?.organization).toBeNull();
  });

  it("still omits a page type the vendor did not send at all", async () => {
    const { data } = await fetchSentimentAnalysis({ keyword: "logitech" });

    // The other half of the distinction: null is present-and-zero, absent is
    // not-in-the-payload.
    expect(data.byPolarity.positive?.pageTypes).not.toHaveProperty("news");
  });

  it("reports dominance as a label, because the buckets overlap and cannot be divided", async () => {
    const { data } = await fetchSentimentAnalysis({ keyword: "logitech" });

    // 2,986,476 / 1,683,708 / 2,854,419 overlap — a page can carry several
    // connotations — so no share of their sum is a sentiment score.
    expect(data.dominantPolarity).toBe("positive");

    // **Checked on the polarity record, not the whole payload.** A first
    // version asserted `not.toMatch(/"(share|score|percent)"/i)` over the
    // serialised result and failed on `"share"` inside `byConnotation` —
    // which is a vendor *connotation name*, the emotion of wanting to share
    // something. A guard that trips on the product's own vocabulary is a
    // guard that gets disabled.
    const polarity: Record<string, Record<string, unknown>> = data.byPolarity;
    const fieldNames = [
      ...Object.keys(polarity),
      ...Object.values(polarity).map((bucket) => Object.keys(bucket)),
    ].flat();
    expect(
      fieldNames.filter((name) => /share|score|percent/i.test(name)),
    ).toEqual([]);
  });

  it("says the buckets overlap and were not summed", async () => {
    const { data } = await fetchSentimentAnalysis({ keyword: "logitech" });

    expect(data.basis).toMatch(/overlap/i);
    expect(data.basis).toMatch(/never summed/i);
    expect(data.basis).toMatch(/not an AI engine/i);
  });

  it("returns a null dominance when fewer than two buckets carry a count", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              path: ["v3", "content_analysis", "sentiment_analysis", "live"],
              cost: 0.02,
              result: [
                {
                  positive_connotation_distribution: {
                    positive: sentimentBucket(5),
                  },
                  sentiment_connotation_distribution: {},
                },
              ],
            },
          ],
        }),
      ),
    );

    const { data } = await fetchSentimentAnalysis({ keyword: "obscure" });

    expect(data.dominantPolarity).toBeNull();
  });

  it("sends both thresholds explicitly, because they remove rows rather than filter them", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(sentimentEnvelope())),
    );

    await fetchSentimentAnalysis({
      keyword: "logitech",
      positiveConnotationThreshold: 0.7,
      sentimentsConnotationThreshold: 0.5,
    });

    expect(requestBody(fetchMock)[0]).toMatchObject({
      internal_list_limit: 10,
      positive_connotation_threshold: 0.7,
      sentiments_connotation_threshold: 0.5,
    });
  });

  it("refuses a blank keyword rather than sending a guaranteed rejection", async () => {
    await expect(fetchSentimentAnalysis({ keyword: "   " })).rejects.toThrow(
      /keyword is required/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
