import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  fetchAiKeywordVolume,
  normaliseAiKeyword,
  validateAiKeywordBatch,
} from "@/server/lib/dataforseo/ai-keywords";
import { requestUrl } from "./test-support";

function envelope(items: unknown[]) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: ["v3", "ai_optimization", "ai_keyword_data"],
        cost: 0.002,
        result_count: 1,
        result: [
          {
            location_code: 2840,
            language_code: "en",
            items_count: items.length,
            items,
          },
        ],
      },
    ],
  };
}

/** Narrow a request body without an unsafe assertion. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): Array<Record<string, unknown>> {
  const raw: unknown = typeof body === "string" ? JSON.parse(body) : body;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject);
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  // A fresh Response per call: a Response body can only be read once.
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI keyword normalisation", () => {
  it("lowercases, matching what DataForSEO returns, so the join key is safe", () => {
    expect(normaliseAiKeyword("  GEO Optimization  ")).toBe("geo optimization");
  });

  it("truncates to the documented 250-character limit", () => {
    expect(normaliseAiKeyword("a".repeat(400))).toHaveLength(250);
  });

  it("rejects an empty batch rather than sending a guaranteed rejection", () => {
    expect(() => validateAiKeywordBatch([])).toThrow(/At least one keyword/);
  });

  it("rejects more than 1000 keywords and says to split the batch", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `kw ${i}`);
    expect(() => validateAiKeywordBatch(many)).toThrow(/at most 1000/);
  });

  it("de-duplicates, so a repeated keyword is not paid for twice", () => {
    expect(validateAiKeywordBatch(["GEO", "geo", " GEO "])).toEqual(["geo"]);
  });
});

describe("fetchAiKeywordVolume", () => {
  it("posts to keywords_search_volume with an underscore, not a slash", async () => {
    // The one test that would have caught the wrong path the client shipped
    // with. Every other test in this file checked the request *body*; none
    // checked the *destination*, so a URL that does not exist passed 14/14.
    // Verified against the live documentation, which reads
    // `/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live`, and
    // corroborated by the response's own `path` array in the documented example.
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchAiKeywordVolume({
      keywords: ["geo"],
      locationCode: 2840,
      languageCode: "en",
    });
    const url = requestUrl(fetchMock);
    expect(url).toContain(
      "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
    );
    // Named explicitly, because the plausible-looking wrong form is the whole
    // point: `keywords/search_volume` reads naturally and 404s on a billed call.
    expect(url).not.toContain("ai_keyword_data/keywords/search_volume");
  });

  it("requires both a location and a language", async () => {
    await expect(
      fetchAiKeywordVolume({ keywords: ["geo"], languageCode: "en" }),
    ).rejects.toThrow(/requires both a location and a language/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a missing language as well as a missing location", async () => {
    await expect(
      fetchAiKeywordVolume({ keywords: ["geo"], locationCode: 2840 }),
    ).rejects.toThrow(/requires both a location and a language/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends normalised keywords with both codes", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchAiKeywordVolume({
      keywords: [" GEO ", "geo"],
      locationCode: 2840,
      languageCode: "en",
    });
    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]?.keywords).toEqual(["geo"]);
    expect(body[0]?.location_code).toBe(2840);
    expect(body[0]?.language_code).toBe("en");
  });

  it("parses the documented payload shape", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          {
            keyword: "iphone",
            ai_search_volume: 407838,
            ai_monthly_searches: [
              { year: 2025, month: 5, ai_search_volume: 407838 },
              { year: 2025, month: 4, ai_search_volume: 413611 },
            ],
          },
        ]),
      ),
    );
    const { data, billing } = await fetchAiKeywordVolume({
      keywords: ["iphone"],
      locationCode: 2840,
      languageCode: "en",
    });
    expect(data.locationCode).toBe(2840);
    expect(data.items[0]?.keyword).toBe("iphone");
    expect(data.items[0]?.ai_search_volume).toBe(407838);
    expect(data.items[0]?.ai_monthly_searches).toHaveLength(2);
    expect(billing.costUsd).toBe(0.002);
  });

  it("preserves a zero month rather than dropping or nulling it", async () => {
    // A zero means "no recorded AI demand that month", which is data. Losing it
    // would silently turn a real dip into a gap.
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          {
            keyword: "geo",
            ai_search_volume: 0,
            ai_monthly_searches: [
              { year: 2025, month: 5, ai_search_volume: 0 },
              { year: 2025, month: 4, ai_search_volume: 1200 },
            ],
          },
        ]),
      ),
    );
    const { data } = await fetchAiKeywordVolume({
      keywords: ["geo"],
      locationCode: 2840,
      languageCode: "en",
    });
    expect(data.items[0]?.ai_monthly_searches?.[0]?.ai_search_volume).toBe(0);
    expect(data.items[0]?.ai_search_volume).toBe(0);
  });

  it("keeps a null volume distinct from a zero", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope([{ keyword: "unknown", ai_search_volume: null }])),
    );
    const { data } = await fetchAiKeywordVolume({
      keywords: ["unknown"],
      locationCode: 2840,
      languageCode: "en",
    });
    expect(data.items[0]?.ai_search_volume).toBeNull();
  });

  it("returns an empty item list as a valid zero-data result", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    const { data } = await fetchAiKeywordVolume({
      keywords: ["nothing"],
      locationCode: 2840,
      languageCode: "en",
    });
    expect(data.items).toEqual([]);
  });

  it("rejects a payload that does not match the documented shape", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            cost: 0,
            result: "not-an-object",
          },
        ],
      }),
    );
    await expect(
      fetchAiKeywordVolume({
        keywords: ["geo"],
        locationCode: 2840,
        languageCode: "en",
      }),
    ).rejects.toThrow(/unexpected AI keyword volume payload/);
  });

  it("forwards the tag so a call can be traced back to a request", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchAiKeywordVolume({
      keywords: ["geo"],
      locationCode: 2840,
      languageCode: "en",
      tag: "opengeo-daily-42",
    });
    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]?.tag).toBe("opengeo-daily-42");
  });
});
