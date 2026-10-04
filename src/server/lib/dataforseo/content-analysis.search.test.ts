import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  citableRows,
  domainsByCitationCount,
  fetchContentSearch,
} from "@/server/lib/dataforseo/content-analysis-search";
import { requestBody, requestUrl } from "./test-support";

/**
 * `content_analysis/search`.
 *
 * The central assertion is the **unit trap**: this endpoint's
 * `connotation_types` is a per-page probability, while the two sibling
 * endpoints report counts under the same field name. Everything else is shape
 * and paging discipline.
 */

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One row as the documented sample carries it. */
function citationRow(overrides?: {
  url?: string | null;
  domain?: string | null;
  score?: number | null;
  positive?: number | null;
  anger?: number | null;
}) {
  return {
    type: "content_analysis_search",
    // **`"url" in overrides`, not `??`** — `null ?? default` is the default, so
    // a fixture written with `??` can never express the row-with-no-URL case it
    // exists to build. Same trap as the evidence drawer's
    // `overrides.x ?? default`, and the same fix.
    url:
      overrides && "url" in overrides
        ? overrides.url
        : "https://reviewfinder.ca/logitech-g560/",
    domain:
      overrides && "domain" in overrides ? overrides.domain : "reviewfinder.ca",
    main_domain: "reviewfinder.ca",
    url_rank: 126,
    domain_rank: 493,
    spam_score: 0,
    fetch_time: "2022-08-12 18:40:33 +00:00",
    country: "CA",
    language: "en",
    score: overrides?.score ?? 5900.941,
    page_types: ["ecommerce"],
    ratings: null,
    content_info: {
      content_type: "page_content",
      title: "Verdict",
      main_title: "Comparing Edifier R1280DB and Logitech G560",
      snippet: "Logitech G560 outranks Edifier R1280DB by 13 positions.",
      snippet_length: 415,
      sentiment_connotations: {
        anger: overrides?.anger ?? null,
        happiness: 0.0707,
        love: 0.0959,
        sadness: 0.03,
        share: null,
        fun: 0.1529,
      },
      // **Probabilities.** `positive: 0.1233` is "this page is 12% positive",
      // not "12% of pages were positive".
      connotation_types: {
        positive: overrides?.positive ?? 0.1233,
        negative: 0.4121,
        neutral: 0.4645,
      },
      content_quality_score: 90,
      // Documented as a semantic element string; returned as a number.
      semantic_location: "90",
      group_date: "2021-09-08 20:23:59 +00:00",
    },
  };
}

function searchEnvelope(
  rows: unknown[] = [citationRow()],
  extra?: Record<string, unknown>,
) {
  return {
    status_code: 20000,
    tasks: [
      {
        id: "t-1",
        status_code: 20000,
        path: ["v3", "content_analysis", "search", "live"],
        cost: 0.0203,
        result_count: 1,
        result: [
          {
            offset_token: "eyJWZXJzaW9uIjoxLCJUb2tlblJlbE9mZnNldCI6MH0=",
            total_count: 296,
            items_count: rows.length,
            items: rows,
            ...extra,
          },
        ],
      },
    ],
  };
}

describe("fetchContentSearch", () => {
  it("posts to content_analysis/search/live, with the path pinned", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(searchEnvelope())));

    await fetchContentSearch({ keyword: "logitech" });

    expect(requestUrl(fetchMock)).toContain("/v3/content_analysis/search/live");
    expect(requestBody(fetchMock)[0]).toMatchObject({ keyword: "logitech" });
  });

  it("returns per-page sentiment probabilities, not counts", async () => {
    // **The unit trap, and the reason this module exists.** On `summary` and
    // `sentiment_analysis` the same field name carries *counts* — 261992.
    // Here it carries a probability per page. A UI reading 0.41 next to
    // 261992 as though they were the same kind of number would be wrong by six
    // orders of magnitude, and both would render as plausible.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(searchEnvelope())));
    const { data } = await fetchContentSearch({ keyword: "logitech" });

    // **Named `polarityScores` rather than `polarity`** so a reader cannot pick
    // this up expecting the sibling endpoints' counts.
    expect(data.rows[0]?.polarityScores.positive).toBe(0.1233);
    expect(data.rows[0]?.polarityScores.negative).toBe(0.4121);
    expect(data.basis).toMatch(/probabilities/i);
    expect(data.basis).toMatch(/must not be read the same way/i);
  });

  it("keeps polarity and emotion apart, because a shared name is not a shared shape", async () => {
    // `sentiment_connotations` is six emotions; `connotation_types` is three
    // polarities. A first version reused **one** schema for both and read six
    // emotion keys off an object carrying three polarity keys, so every
    // polarity score came back `undefined`.
    //
    // **What this does not catch:** swapping the schema back does not fail it,
    // because `.passthrough()` preserves the object either way and the mapper
    // reads by property name. These schemas are documentation and narrowing,
    // not enforcement — which is the `never[]` shape this repo has already
    // recorded as a stand-in that constrains nothing, and worth naming here
    // rather than implying the schema is doing work it is not.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(searchEnvelope())));

    const { data } = await fetchContentSearch({ keyword: "logitech" });

    expect(data.rows[0]?.polarityScores).toMatchObject({
      positive: 0.1233,
      negative: 0.4121,
      neutral: 0.4645,
    });
    expect(data.rows[0]?.connotationScores).toMatchObject({
      happiness: 0.0707,
      fun: 0.1529,
    });
    // Neither map carries the other's keys.
    expect(data.rows[0]?.polarityScores).not.toHaveProperty("anger");
    expect(data.rows[0]?.connotationScores).not.toHaveProperty("positive");
  });

  it("uses the vendor's anger-first default only as a fallback, and reports the sort sent", async () => {
    // `order_by` defaults to most-angry-first: a complaint-triage order, not a
    // brand-representation one. Kept as the fallback so the answer is
    // reproducible, and recorded so a caller knows which order produced it.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(searchEnvelope())));

    const { data } = await fetchContentSearch({ keyword: "logitech" });

    expect(requestBody(fetchMock)[0]).toMatchObject({
      order_by: ["content_info.sentiment_connotations.anger,desc"],
    });
    expect(data.orderBy).toEqual([
      "content_info.sentiment_connotations.anger,desc",
    ]);
  });

  it("honours a caller-supplied sort", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(searchEnvelope())));

    const { data } = await fetchContentSearch({
      keyword: "logitech",
      orderBy: ["score,desc"],
    });

    expect(requestBody(fetchMock)[0]).toMatchObject({
      order_by: ["score,desc"],
    });
    expect(data.orderBy).toEqual(["score,desc"]);
  });

  it("sends only limit alongside an offset_token, because the vendor ignores the rest", async () => {
    // Documented behaviour: with `offset_token`, every parameter except `limit`
    // is ignored. Sending `keyword` alongside is therefore not "belt and braces"
    // — it is a silently dropped keyword, which would return another topic's
    // citations under this one.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(searchEnvelope())));

    await fetchContentSearch({
      keyword: "logitech",
      offsetToken: "token-abc",
      limit: 50,
    });

    const body = requestBody(fetchMock)[0] ?? {};
    expect(body).toMatchObject({ offset_token: "token-abc", limit: 50 });
    expect(body).not.toHaveProperty("keyword");
    expect(body).not.toHaveProperty("order_by");
    expect(body).not.toHaveProperty("internal_list_limit");
  });

  it("reports a null next token rather than an empty string, so paging can stop", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(searchEnvelope([citationRow()], { offset_token: null })),
      ),
    );

    const { data } = await fetchContentSearch({ keyword: "logitech" });

    // "No more rows" and "the vendor did not send a token" are the same state
    // for a pager, and both must stop rather than loop.
    expect(data.nextOffsetToken).toBeNull();
  });

  it("clamps limit to the documented maximum rather than sending a rejection", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(searchEnvelope())));

    await fetchContentSearch({ keyword: "logitech", limit: 5000 });

    expect(requestBody(fetchMock)[0]).toMatchObject({ limit: 1000 });
  });

  it("keeps semantic_location opaque, because the vendor sends a number where a label is documented", async () => {
    // Documented as `"article"`; the sample carries `90`, identical to
    // `content_quality_score`. Guessing which reading is right would be a claim
    // about data we cannot verify, so it is carried through and not interpreted.
    fetchMock.mockResolvedValue(new Response(JSON.stringify(searchEnvelope())));

    const { data } = await fetchContentSearch({ keyword: "logitech" });

    expect(data.rows[0]?.semanticLocation).toBe("90");
    expect(data.rows[0]?.contentQualityScore).toBe(90);
  });

  it("refuses a blank keyword rather than sending a guaranteed rejection", async () => {
    await expect(fetchContentSearch({ keyword: "   " })).rejects.toThrow(
      /keyword is required/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the helpers a citation list needs", () => {
  it("counts domains across rows, for a 'who talks about us' list", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          searchEnvelope([
            citationRow({ domain: "reddit.com" }),
            citationRow({ domain: "reddit.com" }),
            citationRow({ domain: "g2.com" }),
          ]),
        ),
      ),
    );

    const { data } = await fetchContentSearch({ keyword: "logitech" });

    expect(domainsByCitationCount(data)).toEqual([
      { domain: "reddit.com", count: 2 },
      { domain: "g2.com", count: 1 },
    ]);
  });

  it("skips rows with no URL rather than rendering an unlinkable row", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          searchEnvelope([citationRow(), citationRow({ url: null })]),
        ),
      ),
    );

    const { data } = await fetchContentSearch({ keyword: "logitech" });

    expect(data.rows).toHaveLength(2);
    expect(citableRows(data)).toHaveLength(1);
  });
});
