import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  fetchBulkKeywordDifficulty,
  MAX_BULK_DIFFICULTY_KEYWORDS,
  normaliseBulkDifficultyKeyword,
  validateBulkDifficultyBatch,
} from "@/server/lib/dataforseo/bulk-difficulty";
import { requestUrl } from "./test-support";

/** The documented response, trimmed to the fields the client reads. */
function envelope(items: unknown[], cost = 0.0103) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: [
          "v3",
          "dataforseo_labs",
          "google",
          "bulk_keyword_difficulty",
          "live",
        ],
        cost,
        result_count: 1,
        result: [{ items_count: items.length, items }],
      },
    ],
  };
}

function difficultyItem(keyword: string, keyword_difficulty: number | null) {
  return { se_type: "google", keyword, keyword_difficulty };
}

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

describe("bulk-difficulty normalisation", () => {
  it("lowercases, matching what the vendor does server-side", () => {
    expect(normaliseBulkDifficultyKeyword("  Best CRM  ")).toBe("best crm");
  });

  it("refuses to shorten an over-long keyword, because the limit is undocumented", () => {
    // Same position as search-intent: the endpoint documents a 1,000-keyword
    // cap and no character limit, so shortening would change the join key.
    const long = "a".repeat(400);
    expect(normaliseBulkDifficultyKeyword(long)).toHaveLength(400);
    expect(() => validateBulkDifficultyBatch([long])).toThrow(
      /longer than 250 characters/,
    );
  });

  it("refuses an empty batch rather than sending a guaranteed rejection", () => {
    expect(() => validateBulkDifficultyBatch([])).toThrow(
      /At least one keyword/,
    );
  });

  it("refuses more than the documented thousand", () => {
    const many = Array.from(
      { length: MAX_BULK_DIFFICULTY_KEYWORDS + 1 },
      (_, index) => `k${index}`,
    );
    expect(() => validateBulkDifficultyBatch(many)).toThrow(/at most 1000/);
  });

  it("drops duplicates, so the same keyword is not billed twice", () => {
    expect(validateBulkDifficultyBatch([" CRM ", "crm", "Seo"])).toEqual([
      "crm",
      "seo",
    ]);
  });
});

describe("fetchBulkKeywordDifficulty", () => {
  it("calls the documented path and not a plausible wrong one", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchBulkKeywordDifficulty({
      keywords: ["crm"],
      locationCode: 2840,
      languageCode: "en",
    });

    const url = requestUrl(fetchMock);
    expect(url).toContain(
      "/v3/dataforseo_labs/google/bulk_keyword_difficulty/live",
    );
    // Named explicitly: `labs/google/keyword_difficulty` drops the `bulk_`
    // the family requires, and would 404 on a billed request.
    expect(url).not.toContain("labs/google/keyword_difficulty/live");
  });

  it("sends codes, and names instead when codes are absent", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchBulkKeywordDifficulty({
      keywords: ["crm"],
      locationName: "United States",
      languageName: "English",
    });

    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]?.location_name).toBe("United States");
    expect(body[0]?.language_name).toBe("English");
    expect(body[0]).not.toHaveProperty("location_code");
    expect(body[0]).not.toHaveProperty("language_code");
  });

  it("refuses a market-less request before the vendor bills it", async () => {
    // Location and language are each a required pair on this endpoint — the
    // opposite of search_intent, where either one is a billed rejection.
    await expect(
      fetchBulkKeywordDifficulty({ keywords: ["crm"] }),
    ).rejects.toThrow(/location_code or location_name/);
    await expect(
      fetchBulkKeywordDifficulty({ keywords: ["crm"], locationCode: 2840 }),
    ).rejects.toThrow(/language_code or language_name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads difficulty per keyword from the documented items", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          difficultyItem("car dealer los angeles", 50),
          difficultyItem("dentist new york", 50),
          difficultyItem("pizza brooklyn", 44),
        ]),
      ),
    );

    const { data } = await fetchBulkKeywordDifficulty({
      keywords: [
        "car dealer los angeles",
        "dentist new york",
        "pizza brooklyn",
      ],
      locationCode: 2840,
      languageCode: "en",
    });

    expect(data.items).toEqual([
      { keyword: "car dealer los angeles", keywordDifficulty: 50 },
      { keyword: "dentist new york", keywordDifficulty: 50 },
      { keyword: "pizza brooklyn", keywordDifficulty: 44 },
    ]);
  });

  it("keeps a missing difficulty as null rather than guessing one", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope([{ keyword: "crm", keyword_difficulty: null }])),
    );

    const { data } = await fetchBulkKeywordDifficulty({
      keywords: ["crm"],
      locationCode: 2840,
      languageCode: "en",
    });
    expect(data.items[0]?.keywordDifficulty).toBeNull();
  });

  it("surfaces the task cost as the receipt", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope([], 0.0103)),
    );

    const { billing } = await fetchBulkKeywordDifficulty({
      keywords: ["crm"],
      locationCode: 2840,
      languageCode: "en",
    });
    expect(billing).toBeDefined();
  });

  it("nulls out-of-range and non-number difficulties without failing the batch", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          { se_type: "google", keyword: "good", keyword_difficulty: 50 },
          { se_type: "google", keyword: "too-high", keyword_difficulty: 101 },
          { se_type: "google", keyword: "negative", keyword_difficulty: -1 },
          { se_type: "google", keyword: "stringy", keyword_difficulty: "high" },
          { se_type: "google", keyword: "missing" },
        ]),
      ),
    );

    const { data } = await fetchBulkKeywordDifficulty({
      keywords: ["good", "too-high", "negative", "stringy", "missing"],
      locationCode: 2840,
      languageCode: "en",
    });

    // One anomalous row must never discard a paid batch: unusable values read
    // as null (unmeasured, never zero) and the good row survives untouched.
    expect(data.items).toEqual([
      { keyword: "good", keywordDifficulty: 50 },
      { keyword: "too-high", keywordDifficulty: null },
      { keyword: "negative", keywordDifficulty: null },
      { keyword: "stringy", keywordDifficulty: null },
      { keyword: "missing", keywordDifficulty: null },
    ]);
  });

  it("survives malformed and whitespace-only rows without losing the batch", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          null,
          "not-an-object",
          42,
          { se_type: "google", keyword: "   ", keyword_difficulty: 90 },
          difficultyItem("crm", 44),
        ]),
      ),
    );

    const { data } = await fetchBulkKeywordDifficulty({
      keywords: ["crm"],
      locationCode: 2840,
      languageCode: "en",
    });

    // Null, scalar, and whitespace-keyword rows drop alone; the paid batch
    // survives with its joinable row intact.
    expect(data.items).toEqual([{ keyword: "crm", keywordDifficulty: 44 }]);
  });

  it("drops a row without a usable keyword and keeps the rest", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          { se_type: "google", keyword: 123, keyword_difficulty: 50 },
          difficultyItem("crm", 44),
        ]),
      ),
    );

    const { data } = await fetchBulkKeywordDifficulty({
      keywords: ["crm"],
      locationCode: 2840,
      languageCode: "en",
    });

    // The numeric keyword cannot join to anything the caller sent, so its row
    // goes alone — the batch survives.
    expect(data.items).toEqual([{ keyword: "crm", keywordDifficulty: 44 }]);
  });

  it("refuses a tag longer than the documented 255 characters", async () => {
    await expect(
      fetchBulkKeywordDifficulty({
        keywords: ["crm"],
        locationCode: 2840,
        languageCode: "en",
        tag: "t".repeat(256),
      }),
    ).rejects.toThrow(/at most 255 characters/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the code when both code and name are given", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchBulkKeywordDifficulty({
      keywords: ["crm"],
      locationCode: 2840,
      locationName: "United States",
      languageCode: "en",
      languageName: "English",
    });

    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]?.location_code).toBe(2840);
    expect(body[0]).not.toHaveProperty("location_name");
    expect(body[0]?.language_code).toBe("en");
    expect(body[0]).not.toHaveProperty("language_name");
  });

  it("refuses non-string keywords as a validation error, not a TypeError", async () => {
    await expect(
      fetchBulkKeywordDifficulty({
        // A JS caller outside the type boundary; the refusal must name it.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- deliberate JS-boundary probe: the refusal under test only triggers outside the type system
        keywords: ["crm", 42 as unknown as string],
        locationCode: 2840,
        languageCode: "en",
      }),
    ).rejects.toThrow(/were not strings/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not reach the network when the batch is refused", async () => {
    await expect(
      fetchBulkKeywordDifficulty({ keywords: [] }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
