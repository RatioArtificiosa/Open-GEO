import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two live, metered GEO reads.
 *
 * These hit the vendor, so every test here is about the *request* and the
 * refusals — the places where a mistake costs money or produces a confident
 * wrong answer:
 *
 * 1. **Our platform vocabulary is not the vendor's.** We say
 *    `google_ai_overview`; the API parameter is `google`. Sending ours is a 40501
 *    on a billable request.
 * 2. **Gemini and Perplexity are refused, not faked.** They are in our product's
 *    vocabulary and absent from the `llm_mentions` family. Returning an empty
 *    chart would read as "nothing changed", which is a different claim.
 * 3. **The window is clamped to the vendor's floor.** Asking for 2024 is not an
 *    error, it is a request for data that does not exist.
 * 4. **The market comes from the target**, never from the caller.
 */

const getTargetByDomain = vi.fn();
const fetchNewLost = vi.fn<(input: unknown) => Promise<unknown>>();
const fetchTopMentioned = vi.fn<(input: unknown) => Promise<unknown>>();

vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { getTargetByDomain },
}));
vi.mock("@/server/lib/dataforseo/ai-mentions", () => ({
  LLM_MENTIONS_HISTORY_FLOOR: "2025-08-01",
  fetchLlmNewLost: (input: unknown) => fetchNewLost(input),
  fetchLlmTopMentioned: (input: unknown) => fetchTopMentioned(input),
}));

const { getNewLostSeries, getTopCitedPages } =
  await import("@/server/features/geo/services/geoLiveReads");

const TARGET = {
  id: "t1",
  domain: "acme.com",
  name: "Acme",
  locationCode: 2840,
  languageCode: "en",
};

beforeEach(() => {
  getTargetByDomain.mockReset().mockResolvedValue(TARGET);
  fetchNewLost.mockReset().mockResolvedValue({ data: [], billing: {} });
  fetchTopMentioned.mockReset().mockResolvedValue({ data: [], billing: {} });
});

describe("getNewLostSeries", () => {
  it("translates our platform name to the vendor's parameter", async () => {
    // `google_ai_overview` is what a customer sees; `google` is what the API
    // accepts. Sending ours is a billable rejection, not a free typo.
    await getNewLostSeries({
      projectId: "p1",
      domain: "acme.com",
      platform: "google_ai_overview",
    });
    expect(fetchNewLost.mock.calls[0]?.[0]).toMatchObject({
      platform: "google",
    });
  });

  it("refuses a platform the family does not serve", async () => {
    // Gemini and Perplexity exist in our vocabulary and not in this endpoint.
    // An empty chart would say "nothing changed", which is a different claim.
    await expect(
      getNewLostSeries({
        projectId: "p1",
        domain: "acme.com",
        platform: "gemini",
      }),
    ).rejects.toThrow(/only chat_gpt and google/i);
    expect(fetchNewLost).not.toHaveBeenCalled();
  });

  it("takes the market from the target, not from the caller", async () => {
    // A US-only figure handed to a London project is a different measurement
    // wearing the same label.
    getTargetByDomain.mockResolvedValue({ ...TARGET, locationCode: 2352 });
    await getNewLostSeries({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(fetchNewLost.mock.calls[0]?.[0]).toMatchObject({
      locationCode: 2352,
    });
  });

  it("clamps a window that starts before the vendor holds any history", async () => {
    // Asking for 2024 is not an error, it is a request for data that does not
    // exist — and the answer would look like "nothing appeared".
    await getNewLostSeries({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
      from: "2024-01-01",
      to: "2024-06-30",
    });
    // The call body is matched as a record rather than read field by field, so
    // the test does not depend on a cast to a shape the service owns.
    const call: unknown = fetchNewLost.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      dateFrom: "2025-08-01",
      // The upper bound is the caller's, not silently rewritten.
      dateTo: "2024-06-30",
    });
  });

  it("reports null totals for an empty window rather than zeros", async () => {
    // "No data" and "nothing appeared and nothing disappeared" are different
    // claims, and only the second is a finding.
    const series = await getNewLostSeries({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(series.totals).toBeNull();
  });

  it("totals new and lost separately, never as a net figure", async () => {
    // A net number hides a brand that lost 10 and gained 10 as "no change".
    fetchNewLost.mockResolvedValue({
      data: [
        {
          date: "2026-09-01",
          new_mentions: 3,
          lost_mentions: 10,
          new_ai_search_volume: 100,
          lost_ai_search_volume: 400,
        },
      ],
      billing: {},
    });
    const series = await getNewLostSeries({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(series.totals).toEqual({ newMentions: 3, lostMentions: 10 });
  });

  it("keeps a null counter null instead of counting it as zero", async () => {
    fetchNewLost.mockResolvedValue({
      data: [
        {
          date: "2026-09-01",
          new_mentions: null,
          lost_mentions: null,
          new_ai_search_volume: null,
          lost_ai_search_volume: null,
        },
      ],
      billing: {},
    });
    const series = await getNewLostSeries({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(series.rows[0]?.newMentions).toBeNull();
    // Zero totals for a window that exists but reported nothing is honest here;
    // what would not be honest is presenting it as a finding.
    expect(series.totals).toEqual({ newMentions: 0, lostMentions: 0 });
  });

  it("explains an unmonitored domain rather than returning an empty panel", async () => {
    getTargetByDomain.mockResolvedValue(null);
    await expect(
      getNewLostSeries({
        projectId: "p1",
        domain: "other.com",
        platform: "chat_gpt",
      }),
    ).rejects.toThrow(/not a monitored target/i);
  });
});

describe("getTopCitedPages", () => {
  it("asks for the cited set, not the retrieved one", async () => {
    // `sources` is what the model used; `search_results` is everything it
    // fetched, including pages it ignored. Telling a customer to optimise a page
    // the model discarded would be the worst kind of advice this product gives.
    await getTopCitedPages({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(fetchTopMentioned.mock.calls[0]?.[0]).toMatchObject({
      linksScope: "sources",
      kind: "pages",
    });
  });

  it("keeps the vendor's URL verbatim, tracking parameters and all", async () => {
    // The archive should hold what was actually cited. Stripping the query
    // string is a display decision, and a rewritten URL loses the evidence.
    fetchTopMentioned.mockResolvedValue({
      data: [
        {
          page: "https://acme.com/pricing?utm_source=chatgpt.com",
          domain: null,
          total: { mentions: 4, ai_search_volume: 20 },
        },
      ],
      billing: {},
    });
    const { pages } = await getTopCitedPages({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(pages[0]?.url).toContain("utm_source=chatgpt.com");
    expect(pages[0]?.mentions).toBe(4);
  });

  it("reads the domain key when the ranking is over domains", async () => {
    fetchTopMentioned.mockResolvedValue({
      data: [{ domain: "acme.com", total: { mentions: 7 } }],
      billing: {},
    });
    const { pages } = await getTopCitedPages({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
      kind: "domains",
    });
    expect(pages[0]?.url).toBe("acme.com");
  });

  it("skips a row with no key rather than rendering an empty link", async () => {
    fetchTopMentioned.mockResolvedValue({
      data: [{ page: null, total: { mentions: 1 } }],
      billing: {},
    });
    const { pages } = await getTopCitedPages({
      projectId: "p1",
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(pages).toEqual([]);
  });

  it("returns the platform we asked about, not the vendor's slug", async () => {
    // The UI keys on `google_ai_overview`; returning `google` would leave a card
    // labelled "google" on a page that speaks the other name everywhere else.
    const { platform } = await getTopCitedPages({
      projectId: "p1",
      domain: "acme.com",
      platform: "google_ai_overview",
    });
    expect(platform).toBe("google_ai_overview");
  });
});
