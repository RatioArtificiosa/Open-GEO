import { describe, expect, it, vi } from "vitest";
import {
  AD_TRAFFIC_FIELDS,
  DEPRECATED_AD_TRAFFIC_FIELDS,
  adTrafficChartRule,
  adTrafficRefusalWarning,
  isDeprecatedAdTrafficField,
} from "@/shared/ad-traffic-fields";
import { requestUrl } from "./test-support";
import {
  fetchAdTrafficForecast,
  readAdTrafficForecast,
  type AdTrafficRow,
} from "./adTraffic";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

/**
 * The guardrail, and the published-nothing chart it exists to prevent.
 *
 * `impressions` and `ctr` are deprecated upstream and always null, so the only
 * correct chart from this endpoint has no impressions axis. These tests pin the
 * refusal that keeps a caller from publishing one — and the case where the rule
 * stays silent, because a warning on every answer is a warning nobody reads.
 */

describe("the ad-traffic guardrail", () => {
  it("names the deprecated fields, and only those", () => {
    expect([...DEPRECATED_AD_TRAFFIC_FIELDS]).toEqual(["impressions", "ctr"]);
    expect(AD_TRAFFIC_FIELDS).toContain("clicks");
    expect(AD_TRAFFIC_FIELDS).not.toContain("position");
  });

  it("refuses a deprecated field and says which one", () => {
    const rule = adTrafficChartRule(["clicks", "impressions", "ctr"]);
    expect(rule.chartable).toEqual(["clicks"]);
    expect(rule.refused).toEqual(["impressions", "ctr"]);
    expect(rule.hasRefusal).toBe(true);
    // Named, not "some fields": a reader who cannot see which field was refused
    // cannot act on it.
    expect(adTrafficRefusalWarning(rule)).toContain("`impressions`");
    expect(adTrafficRefusalWarning(rule)).toContain("`ctr`");
  });

  it("stays silent when nothing deprecated was asked for", () => {
    // The rule must not cry wolf on every response.
    const rule = adTrafficChartRule(["clicks", "cost"]);
    expect(rule.hasRefusal).toBe(false);
    expect(adTrafficRefusalWarning(rule)).toBeNull();
  });

  it("explains why an empty impressions chart is worse than none", () => {
    const warning = adTrafficRefusalWarning(
      adTrafficChartRule(["impressions"]),
    );
    // The whole product claim: an empty axis reads as flat interest, and the
    // truth is that the vendor stopped reporting it.
    expect(warning).toMatch(
      /empty impressions chart would read as flat interest/,
    );
  });
});

describe("readAdTrafficForecast", () => {
  // **Typed by the vendor's row contract rather than inferred.** The `as const`
  // narrows every literal, and an annotation on top of it keeps the fixture
  // honest about which fields the vendor sends — including the two that are
  // always null. If the contract drops `impressions`, this fixture fails to
  // compile, which is the point.
  const rows: AdTrafficRow[] = [
    {
      keyword: "standing desk",
      clicks: 12.5,
      average_cpc: 0.37,
      cost: 4.62,
      impressions: null,
      ctr: null,
    },
  ];

  it("returns only the requested usable fields", () => {
    // The rule's chartable list is what the read returns — a full row with the
    // deprecated pair hidden inside it would leave the pair one property read
    // away from a chart.
    const forecast = readAdTrafficForecast(rows, ["cost"]);
    expect(forecast.rows[0]).toEqual({
      keyword: "standing desk",
      values: { cost: 4.62 },
    });
    expect(forecast.refusal).toBeNull();
  });

  it("carries the refusal with the data, so a chart cannot miss it", () => {
    const forecast = readAdTrafficForecast(rows, [
      "clicks",
      "impressions",
      "ctr",
    ]);
    expect(forecast.rows[0]).toEqual({
      keyword: "standing desk",
      values: { clicks: 12.5 },
    });
    expect(forecast.refusal).toContain("`impressions`");
    expect(forecast.refusal).toContain("`ctr`");
  });

  it("omits a null usable value rather than reporting zero", () => {
    // 0-is-not-null: a field the vendor did not report is absent, and a zero
    // here would read as "the keyword is expected to earn nothing".
    const forecast = readAdTrafficForecast(
      [
        {
          keyword: "x",
          clicks: null,
          average_cpc: null,
          cost: null,
          impressions: null,
          ctr: null,
        },
      ],
      ["clicks", "cost"],
    );
    expect(forecast.rows[0]).toEqual({ keyword: "x", values: {} });
  });

  it("reads an empty row set as an empty forecast, not a failure", () => {
    const forecast = readAdTrafficForecast([], ["clicks"]);
    expect(forecast.rows).toEqual([]);
    expect(forecast.refusal).toBeNull();
  });
});

/**
 * The path, asserted the way the other clients assert it.
 *
 * `ad_traffic_by_keywords` sits under `keywords_data/google_ads`, which is not
 * where the family's name suggests, and `endpoint-path-gate.test.ts` refuses a
 * client whose path is unpinned: a wrong URL passes every behavioural test and
 * fails only on a **billed** request. The gate is why this block exists.
 */
describe("fetchAdTrafficForecast path", () => {
  it("calls ad_traffic_by_keywords under google_ads", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status_code: 20000,
            status_message: "Ok.",
            tasks: [
              {
                status_code: 20000,
                status_message: "Ok.",
                path: [
                  "v3",
                  "keywords_data",
                  "google_ads",
                  "ad_traffic_by_keywords",
                  "live",
                ],
                cost: 0.06,
                result_count: 1,
                result: [],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchAdTrafficForecast({
      keywords: ["standing desk"],
      locationCode: 2840,
      languageCode: "en",
    });

    expect(requestUrl(fetchMock as never)).toContain(
      "/v3/keywords_data/google_ads/ad_traffic_by_keywords/live",
    );
    vi.unstubAllGlobals();
  });
});

describe("fetchAdTrafficForecast validation", () => {
  it("refuses an empty keyword set before a billed call", async () => {
    await expect(
      fetchAdTrafficForecast({
        keywords: [],
        locationCode: 2840,
        languageCode: "en",
      }),
    ).rejects.toThrow("between 1 and 1000");
  });

  it("refuses a missing location or language, both billed rejections", async () => {
    for (const input of [
      { keywords: ["a"], locationCode: 0, languageCode: "en" },
      { keywords: ["a"], locationCode: 2840, languageCode: "" },
    ]) {
      await expect(fetchAdTrafficForecast(input)).rejects.toThrow(
        "requires both a location code and a language code",
      );
    }
  });

  it("refuses a malformed date before a billed call", async () => {
    // Shape-only, matching every other client in this directory: an impossible
    // *calendar* date like 2026-13-01 has the shape the vendor accepts and is
    // its own rejection to make, so the convention here is the pattern and not
    // a calendar. A genuinely malformed value never leaves.
    await expect(
      fetchAdTrafficForecast({
        keywords: ["a"],
        locationCode: 2840,
        languageCode: "en",
        dateFrom: "2026/13/01",
      }),
    ).rejects.toThrow("yyyy-mm-dd");
    await expect(
      fetchAdTrafficForecast({
        keywords: ["a"],
        locationCode: 2840,
        languageCode: "en",
        dateTo: "not a date",
      }),
    ).rejects.toThrow("yyyy-mm-dd");
  });

  it("reports whether a field is deprecated, including for names it does not own", () => {
    expect(isDeprecatedAdTrafficField("impressions")).toBe(true);
    expect(isDeprecatedAdTrafficField("clicks")).toBe(false);
    // An unknown name is not this rule's business to refuse.
    expect(isDeprecatedAdTrafficField("position")).toBe(false);
  });
});
