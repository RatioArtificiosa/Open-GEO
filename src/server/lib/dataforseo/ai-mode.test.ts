import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { fetchAiModeAnswer } from "@/server/lib/dataforseo/ai-mode";

/**
 * Shaped from the real vendor example response (2026-02-24), including the
 * detail that surprises people: `references` hang off each element, and most
 * element types carry `null` for links/images/references.
 */
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: ["v3", "serp", "google", "ai_mode", "live", "advanced"],
        cost: 0.004,
        result_count: 1,
        result: [
          {
            keyword: "iphone 16 price comparison",
            type: "ai_mode",
            se_domain: "google.com",
            location_code: 1006886,
            language_code: "en",
            check_url: "https://www.google.com/search?q=iphone%2016",
            datetime: "2026-02-24 14:38:25 +00:00",
            item_types: ["ai_overview"],
            items_count: 2,
            items: [
              {
                type: "ai_overview_element",
                position: "left",
                title: null,
                text: "The iPhone 16 series starts at £599.",
                markdown: "The iPhone 16 series starts at **£599**.",
                references: [
                  {
                    type: "ai_overview_reference",
                    source: "CNET",
                    domain: "www.cnet.com",
                    url: "https://www.cnet.com/deals/iphone-16",
                    title: "iPhone 16 deals",
                    text: "Prices differ depending on storage",
                  },
                  {
                    type: "ai_overview_reference",
                    source: "MacRumors",
                    domain: "www.macrumors.com",
                    url: "https://www.macrumors.com/iphone-16-cost",
                    title: "How much does each model cost",
                    text: "iPhone 16e 128GB: $599",
                  },
                ],
              },
              {
                type: "ai_overview_element",
                position: "left",
                title: "User Sentiment",
                text: "Expert and user reviews highlight strengths.",
                links: null,
                images: null,
                references: null,
              },
            ],
            ...overrides,
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

const QUERY = {
  keyword: "iphone 16 price comparison",
  locationCode: 1006886,
  languageCode: "en",
};

describe("fetchAiModeAnswer", () => {
  it("returns the answer text and its references", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope()));
    const { data, billing } = await fetchAiModeAnswer(QUERY);

    expect(data.keyword).toBe("iphone 16 price comparison");
    expect(data.datetime).toBe("2026-02-24 14:38:25 +00:00");
    expect(data.references).toHaveLength(2);
    expect(data.references[0]?.domain).toBe("www.cnet.com");
    // The cost figure that matters: $0.004 for live/advanced.
    expect(billing.costUsd).toBe(0.004);
  });

  it("de-duplicates references that appear on more than one element", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope({
          items: [
            {
              type: "ai_overview_element",
              text: "a",
              references: [{ domain: "a.com", url: "https://a.com" }],
            },
            {
              type: "ai_overview_element",
              text: "b",
              references: [{ domain: "a.com", url: "https://a.com" }],
            },
          ],
        }),
      ),
    );
    const { data } = await fetchAiModeAnswer(QUERY);
    expect(data.references).toHaveLength(1);
  });

  it("tolerates null references, which most element types return", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope({
          items: [{ type: "ai_overview_element", text: "a", references: null }],
        }),
      ),
    );
    const { data } = await fetchAiModeAnswer(QUERY);
    expect(data.references).toEqual([]);
    expect(data.elements).toHaveLength(1);
  });

  it("returns an empty answer set as valid zero data, not an error", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope({ items: null, items_count: 0, item_types: null }),
      ),
    );
    const { data } = await fetchAiModeAnswer(QUERY);
    expect(data.elements).toEqual([]);
    expect(data.references).toEqual([]);
    expect(data.elementTypes).toEqual([]);
  });

  it("rejects an empty keyword before spending", async () => {
    await expect(
      fetchAiModeAnswer({ ...QUERY, keyword: "   " }),
    ).rejects.toThrow(/keyword is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a keyword past the documented 700-character limit", async () => {
    await expect(
      fetchAiModeAnswer({ ...QUERY, keyword: "a".repeat(701) }),
    ).rejects.toThrow(/700 characters/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a location and names the AI Mode availability caveat", async () => {
    await expect(
      fetchAiModeAnswer({ keyword: "x", languageCode: "en" }),
    ).rejects.toThrow(/not available in every country/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a payload that does not match the documented shape", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        status_code: 20000,
        tasks: [{ status_code: 20000, cost: 0, result: "not-an-object" }],
      }),
    );
    await expect(fetchAiModeAnswer(QUERY)).rejects.toThrow(
      /unexpected AI Mode payload/,
    );
  });
});
