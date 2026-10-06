import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  fetchSearchIntent,
  MAX_SEARCH_INTENT_KEYWORDS,
  normaliseSearchIntentKeyword,
  validateSearchIntentBatch,
} from "@/server/lib/dataforseo/search-intent";
import { requestUrl } from "./test-support";

/** The documented response, trimmed to the fields the client reads. */
function envelope(items: unknown[], cost = 0.01248) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: ["v3", "dataforseo_labs", "google", "search_intent", "live"],
        cost,
        result_count: 1,
        result: [{ items_count: items.length, items }],
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
  // A fresh Response per call: a Response body can only be read once.
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("search-intent normalisation", () => {
  it("lowercases, matching what the vendor does server-side", () => {
    // The service lowercases every keyword before returning it, so normalising here
    // is what keeps the response's `keyword` a safe join key against the request.
    expect(normaliseSearchIntentKeyword("  GEO Optimization  ")).toBe(
      "geo optimization",
    );
  });

  it("refuses to shorten an over-long keyword, because the limit is undocumented", () => {
    // The distinctive rule of this client. This endpoint documents a 1,000-keyword
    // cap and **no character limit**, so there is nothing to truncate to: shortening
    // silently would change the keyword, and the only alternative — sending it — is a
    // billed rejection the caller never sees.
    const long = "a".repeat(400);
    expect(normaliseSearchIntentKeyword(long)).toHaveLength(400);
    expect(() => validateSearchIntentBatch([long])).toThrow(
      /longer than 250 characters/,
    );
  });

  it("refuses an empty batch rather than sending a guaranteed rejection", () => {
    expect(() => validateSearchIntentBatch([])).toThrow(/At least one keyword/);
  });

  it("refuses more than the documented thousand", () => {
    const many = Array.from(
      { length: MAX_SEARCH_INTENT_KEYWORDS + 1 },
      (_, index) => `k${index}`,
    );
    expect(() => validateSearchIntentBatch(many)).toThrow(/at most 1000/);
  });

  it("drops duplicates, so the same question is not billed twice", () => {
    expect(validateSearchIntentBatch([" GEO ", "geo", "Seo"])).toEqual([
      "geo",
      "seo",
    ]);
  });
});

describe("fetchSearchIntent", () => {
  it("calls the documented path and not a plausible wrong one", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchSearchIntent({ keywords: ["geo"] });

    const url = requestUrl(fetchMock);
    expect(url).toContain("/v3/dataforseo_labs/google/search_intent/live");
    // Named explicitly: `labs/google/search_intent` under a different segment reads
    // naturally and would 404 on a billed call.
    expect(url).not.toContain("dataforseo_labs/search_intent");
  });

  it("sends no market parameter, because the endpoint takes neither", async () => {
    // **The claim most worth pinning.** Every sibling client sends a location and a
    // language; this one must not. A task carrying an unknown field is rejected, and
    // the vendor bills a rejected task.
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchSearchIntent({ keywords: ["geo"] });

    const body = parseBody(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body[0]?.keywords).toEqual(["geo"]);
    expect(body[0]).not.toHaveProperty("location_code");
    expect(body[0]).not.toHaveProperty("language_code");
  });

  it("forwards a tag when given and omits it otherwise", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchSearchIntent({ keywords: ["geo"], tag: "run-42" });
    expect(parseBody(fetchMock.mock.calls[0]?.[1]?.body)[0]?.tag).toBe(
      "run-42",
    );

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => Response.json(envelope([])));
    await fetchSearchIntent({ keywords: ["geo"] });
    expect(parseBody(fetchMock.mock.calls[0]?.[1]?.body)[0]).not.toHaveProperty(
      "tag",
    );
  });

  it("reads the documented payload, including the second-best intent", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          {
            keyword: "login page",
            keyword_intent: { label: "navigational", probability: 0.9999 },
            secondary_keyword_intents: null,
          },
          {
            keyword: "transmitter",
            keyword_intent: { label: "transactional", probability: 0.5211 },
            // The field that makes a borderline keyword usable: this says "could be
            // either", which a single label throws away.
            secondary_keyword_intents: [
              { label: "informational", probability: 0.3911 },
            ],
          },
        ]),
      ),
    );

    const { data } = await fetchSearchIntent({
      keywords: ["login page", "transmitter"],
    });

    expect(data.items[0]).toEqual({
      keyword: "login page",
      intent: "navigational",
      probability: 0.9999,
      // `null` means "no second intent worth reporting", not "unknown".
      secondaryIntents: [],
    });
    expect(data.items[1]?.secondaryIntents).toEqual([
      { intent: "informational", probability: 0.3911 },
    ]);
  });

  it("keeps a missing intent as null rather than guessing one", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope([{ keyword: "geo", keyword_intent: null }])),
    );
    const { data } = await fetchSearchIntent({ keywords: ["geo"] });
    expect(data.items[0]?.intent).toBeNull();
    expect(data.items[0]?.probability).toBeNull();
  });

  it("degrades an unrecognised label to `unknown` instead of discarding a paid response", async () => {
    // The request succeeded and was billed. Failing the whole parse over one word we
    // had not seen would throw away every other keyword in the batch.
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          {
            keyword: "geo",
            keyword_intent: { label: "promotional", probability: 0.4 },
          },
          {
            keyword: "seo",
            keyword_intent: { label: "informational", probability: 0.9 },
          },
        ]),
      ),
    );
    const { data } = await fetchSearchIntent({ keywords: ["geo", "seo"] });
    expect(data.items[0]?.intent).toBe("unknown");
    // And the neighbour is untouched — the point of degrading rather than throwing.
    expect(data.items[1]?.intent).toBe("informational");
  });

  it("surfaces the task cost as the receipt", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(envelope([], 0.01248)),
    );
    const { billing } = await fetchSearchIntent({ keywords: ["geo"] });
    expect(billing).toBeDefined();
  });

  it("does not reach the network when the batch is refused", async () => {
    await expect(fetchSearchIntent({ keywords: [] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
