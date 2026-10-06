import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  fetchClickstreamVolumes,
  MIN_CLICKSTREAM_KEYWORD_CHARS,
  normaliseClickstreamKeyword,
  validateClickstreamKeywords,
} from "@/server/lib/dataforseo/clickstream";
import { keywordsPerTaskFor } from "@/shared/volume-routing";
import { requestUrl } from "./test-support";

function envelope(items: unknown[]) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: [
          "v3",
          "keywords_data",
          "clickstream_data",
          "global_search_volume",
          "live",
        ],
        cost: 0.18,
        result_count: 1,
        result: items,
      },
    ],
  };
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
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clickstream keyword validation", () => {
  it("lowercases, matching what the vendor does server-side", () => {
    expect(normaliseClickstreamKeyword("  Plumber Near Me  ")).toBe(
      "plumber near me",
    );
  });

  it("drops duplicates, so the same keyword is not billed twice", () => {
    expect(validateClickstreamKeywords([" plumber ", "Plumber"])).toEqual([
      "plumber",
    ]);
  });

  it("refuses a keyword shorter than the documented floor instead of dropping it", () => {
    // Dropping it would leave a gap in the reconciliation that reads as "no measurement
    // exists", which is a different answer from "we never asked".
    expect(() => validateClickstreamKeywords(["plumber", "of"])).toThrow(
      /shorter than 3 characters/,
    );
    expect(MIN_CLICKSTREAM_KEYWORD_CHARS).toBe(3);
  });

  it("refuses an empty batch and a batch over the documented cap", () => {
    expect(() => validateClickstreamKeywords([])).toThrow(
      /At least one keyword/,
    );
    const cap = keywordsPerTaskFor("clickstream_global");
    const tooMany = Array.from({ length: cap + 1 }, (_, i) => `kw${i}`);
    expect(() => validateClickstreamKeywords(tooMany)).toThrow(
      new RegExp(`at most ${cap}`),
    );
  });

  it("takes its cap from the routing table rather than keeping a second copy", () => {
    // If the cap moves in `volume-routing`, this client moves with it, and the boundary
    // just above the cap keeps passing.
    const cap = keywordsPerTaskFor("clickstream_global");
    const atCap = Array.from({ length: cap }, (_, i) => `kw${i}`);
    expect(validateClickstreamKeywords(atCap)).toHaveLength(cap);
  });
});

describe("fetchClickstreamVolumes", () => {
  it("calls the documented path and not a plausible wrong one", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchClickstreamVolumes({ keywords: ["plumber"] });

    const url = requestUrl(fetchMock);
    expect(url).toContain(
      "/v3/keywords_data/clickstream_data/global_search_volume/live",
    );
    expect(url).not.toContain("clickstream_data/search_volume/live");
  });

  it("sends no location or language, because the measurement is global", async () => {
    // **The claim worth pinning.** Every sibling keyword client sends a market. This one
    // must not: the field is not in the schema, and a task carrying it is rejected and
    // billed. Its result is global, which is why the caller must read the country split.
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchClickstreamVolumes({ keywords: ["plumber"] });

    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]?.keywords).toEqual(["plumber"]);
    expect(body[0]).not.toHaveProperty("location_code");
    expect(body[0]).not.toHaveProperty("language_code");
  });

  it("reads the global figure and the per-country split", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          {
            keyword: "plumber",
            search_volume: 1_000_000,
            country_distribution: [
              {
                country_iso_code: "US",
                search_volume: 200_000,
                percentage: 20,
              },
              // The vendor emits a null country bucket; it is not a bug and must survive.
              { country_iso_code: null, search_volume: 5_000, percentage: 0.5 },
            ],
          },
        ]),
      ),
    );

    const { data } = await fetchClickstreamVolumes({ keywords: ["plumber"] });

    expect(data[0]?.globalVolume).toBe(1_000_000);
    expect(data[0]?.countryDistribution).toEqual([
      { countryIsoCode: "US", searchVolume: 200_000, percentage: 20 },
      { countryIsoCode: null, searchVolume: 5_000, percentage: 0.5 },
    ]);
  });

  it("keeps a missing volume as null rather than zero", async () => {
    // Zero means "nobody searches this"; null means "no measurement". A reconciliation
    // that reads one as the other invents a finding.
    fetchMock.mockImplementation(async () =>
      Response.json(envelope([{ keyword: "plumber", search_volume: null }])),
    );

    const { data } = await fetchClickstreamVolumes({ keywords: ["plumber"] });

    expect(data[0]?.globalVolume).toBeNull();
    expect(data[0]?.countryDistribution).toEqual([]);
  });

  it("surfaces the task cost as the receipt", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope([{ keyword: "plumber", search_volume: 10 }])),
    );
    const { billing } = await fetchClickstreamVolumes({
      keywords: ["plumber"],
    });
    expect(billing).toBeDefined();
  });

  it("does not reach the network when the batch is refused", async () => {
    await expect(
      fetchClickstreamVolumes({ keywords: ["a"] }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
