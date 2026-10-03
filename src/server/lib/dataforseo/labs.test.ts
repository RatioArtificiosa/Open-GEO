/**
 * The two intersection endpoints, and the ETV provenance they carry.
 *
 * ## Why this file exists at all
 *
 * **`labs.ts` had no test file`,** which is why `endpoint-path-gate` never gated any of its
 * eight existing endpoints either — the gate pairs each client with its *same-named* test, and
 * a missing test is read as "nothing to check" rather than "never checked". Nine endpoints
 * in this client were ungated for that reason alone. This file starts the pairing, and it
 * starts with the two CL-403 is missing.
 *
 * ## The thing worth testing here
 *
 * Both endpoints return an **ETV**, which means their numbers are only comparable within one
 * formula version — and DataForSEO switches models on 2026-11-01. So the assertions are not
 * about the payload shape; they are about **the flag we sent being the flag we recorded.**
 * That is a silent-lie hazard rather than a crash: send `use_new_etv: false` and record
 * `formulaVersion: new`, and every number in the table is wrong while every test passes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
} from "@/server/lib/dataforseo/labs";
import {
  fetchDomainIntersection,
  fetchPageIntersection,
  type DomainIntersectionRequest,
  type IntersectionItem,
} from "@/server/lib/dataforseo/labsIntersection";
import { requestBody, requestUrl } from "./test-support";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const billed = {
  path: ["v3", "dataforseo_labs", "google", "domain_intersection", "live"],
  cost: 0.02,
  result_count: 0,
};

function okResponse(result: unknown[]) {
  return new Response(
    JSON.stringify({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [{ status_code: 20000, status_message: "Ok.", ...billed, result }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const BASE: DomainIntersectionRequest = {
  domains: ["example.com"],
  competitors: ["rival.com"],
  locationCode: 2840,
  languageCode: "en",
  limit: 100,
};

describe("labs paths the endpoint-path gate could not see", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("pins related_keywords, the first path in the file and the one the gate reads", async () => {
    // **`endpoint-path-gate` takes `detectPath(source)` — the FIRST `/v3/…` in the file**,
    // which in `labs.ts` is `related_keywords`, and this file is the first test that exists
    // for it at all. So this assertion is not a bonus: **it is the one the gate has been
    // asking for since `labs.ts` was written**, unasked because the pairing rule reads a
    // missing test as "nothing to check" rather than "never checked".
    //
    // **And it generalises the finding.** The gate reports one path per client, so
    // `labs.ts`'s *other* eight endpoints remain ungated by the same mechanism. This file
    // pins two of them (the intersection pair); the rest still need their own assertions.
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));

    // **Awaited, and the first version was not.** Without the `await` the call rejected *after*
    // the assertion had already run, so `requestUrl` saw zero recorded calls and reported
    // "fetch was not called with a string, URL, or Request" — a message about the mock when
    // the actual problem was a floating promise. `no-floating-promises` flagged it; the
    // failure arrived first, which is a good argument for running the cheap linter.
    await fetchRelatedKeywords({
      keyword: "open geo tooling",
      locationCode: 2840,
      languageCode: "en",
      limit: 10,
    });

    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/dataforseo_labs/google/related_keywords/live",
    );
  });
});

describe("the intersection endpoints", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("posts to the two different paths, not to each other's", async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));

    await fetchDomainIntersection(BASE);
    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/dataforseo_labs/google/domain_intersection/live",
    );

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));

    await fetchPageIntersection({ ...BASE, pages: ["/pricing"] });
    expect(requestUrl(vi.mocked(fetch))).toContain(
      "/v3/dataforseo_labs/google/page_intersection/live",
    );
    // **Both directions, again** — these two bodies differ only in the path and the extra
    // `pages` array, so a copy-paste between them is invisible to every other assertion here.
    expect(requestUrl(vi.mocked(fetch))).not.toContain("domain_intersection");
  });

  it("sends use_new_etv and records the version that flag resolved to", async () => {
    // **The load-bearing assertion.** The flag in the body and the provenance on the
    // response must come from the *same* resolution, or the archive records a formula
    // version the call did not use — and nothing downstream can detect that, because the
    // number looks perfectly valid.
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));

    const result = await fetchDomainIntersection({
      ...BASE,
      // **Before the cutover**, so the resolved mode is deterministic regardless of when
      // this test happens to run.
      now: new Date("2026-10-01T00:00:00.000Z"),
    });

    const body = requestBody(vi.mocked(fetch));
    expect(typeof body[0].use_new_etv).toBe("boolean");
    // The recorded flag IS the sent flag. Not "both are booleans" — the same boolean.
    expect(body[0].use_new_etv).toBe(result.etv.useNewEtv);
    expect(result.etv.requestedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(["legacy", "new"]).toContain(result.etv.formulaVersion);
  });

  it("sends use_new_etv: true after the cutover, which is the case a forced false would break", async () => {
    // **The pre-cutover case alone cannot see a `use_new_etv: false` mutation** — for
    // `now` before 2026-11-01 the honest body *is* false, so forcing false changes nothing
    // observable and the mutation sails through. A `now` past the cutover makes the body
    // must-be-true, which is exactly what the sent-flag assertion exists to pin.
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));

    const result = await fetchDomainIntersection({
      ...BASE,
      now: new Date("2026-11-01T00:00:01.000Z"),
    });

    const body = requestBody(vi.mocked(fetch));
    expect(body[0].use_new_etv).toBe(true);
    expect(result.etv.useNewEtv).toBe(true);
    expect(result.etv.formulaVersion).toBe("new");
  });

  it("resolves a different version after the cutover, or the deadline means nothing", async () => {
    // **CL-715's 2026-11-01 deadline is only real if the date changes the answer.** A
    // resolver that ignores `now` would keep returning the pre-cutover version forever and
    // every stored value would be labelled wrong.
    //
    // **`mockImplementation`, not `mockResolvedValue`, and this applies to every case in the
    // file.** The latter hands the *same* `Response` to every call and a body can only be
    // read once, so a two-call test throws "Body has already been read" and fails for a
    // reason that has nothing to do with the cutover it was written to prove. Where the
    // other cases make one call each it happens to be harmless — **which is exactly why the
    // bug survived being written eight times.**
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));

    const before = await fetchDomainIntersection({
      ...BASE,
      now: new Date("2026-10-31T23:59:59.000Z"),
    });
    const after = await fetchDomainIntersection({
      ...BASE,
      now: new Date("2026-11-01T00:00:01.000Z"),
    });

    expect(before.etv.formulaVersion).not.toBe(after.etv.formulaVersion);
    expect(after.etv.formulaVersion).toBe("new");
  });

  it("page_intersection sends its own pages array and domain_intersection does not", async () => {
    // **`pages` on the wrong endpoint is a 40501 and a billed round-trip.** The vendor
    // rejects an unknown field rather than ignoring it, so this is worth pinning.
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));
    await fetchPageIntersection({ ...BASE, pages: ["/pricing", "/docs"] });
    expect(requestBody(vi.mocked(fetch))[0].pages).toEqual([
      "/pricing",
      "/docs",
    ]);

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));
    await fetchDomainIntersection(BASE);
    expect(requestBody(vi.mocked(fetch))[0].pages).toBeUndefined();
  });

  it("passes the comparison parameters through unchanged", async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));
    await fetchDomainIntersection({
      ...BASE,
      includeSubdomains: true,
      offset: 20,
    });

    expect(requestBody(vi.mocked(fetch))[0]).toMatchObject({
      domains: ["example.com"],
      competitors: ["rival.com"],
      location_code: 2840,
      language_code: "en",
      include_subdomains: true,
      limit: 100,
      offset: 20,
    });
  });

  it("returns rows and billing, and an empty intersection is not an error", async () => {
    // **The shape the repo keeps getting wrong.** "No competitor outranks us" is the answer
    // a customer wants, not a failure to report.
    vi.mocked(fetch).mockResolvedValue(
      okResponse([
        {
          items: [
            {
              domain: "rival.com",
              etv: 1234.5,
              intersection_info: {
                intersecting_domains: 1,
                intersecting_keywords: 87,
              },
            },
          ],
        },
      ]),
    );

    const result = await fetchDomainIntersection(BASE);
    expect(result.data).toHaveLength(1);
    // **Typed as the row shape, so a rename of a field the caller reads fails here**
    // rather than silently typing `unknown` at every use downstream.
    const [row]: IntersectionItem[] = result.data;
    expect(row).toMatchObject({ domain: "rival.com", etv: 1234.5 });
    expect(row.intersection_info).toMatchObject({
      intersecting_domains: 1,
      intersecting_keywords: 87,
    });
    expect(result.billing).toMatchObject({ costUsd: 0.02 });

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async () => okResponse([]));
    await expect(fetchDomainIntersection(BASE)).resolves.toMatchObject({
      data: [],
    });
  });
});

/**
 * Every path in `labs.ts`, pinned.
 *
 * **Nine of these ten endpoints have shipped without their destination ever being asserted.**
 * The gate read one path per file — `related_keywords`, pinned in the case above — and
 * reported the whole client covered. A path that 404s is not a crash: DataForSEO charges per
 * request, so it is a customer-visible error after the money is spent.
 *
 * **No payload assertions and no ETV assertions here** — those are covered in the cases above
 * where the behaviour actually lives. This block is the destination and nothing else, which is
 * what the gate asks for and the cheapest thing that catches a transposition.
 */
describe("every labs path is the one the client sends", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const KW = { locationCode: 2840, languageCode: "en" };
  const DOMAIN = { target: "example.com", ...KW };

  const cases = [
    {
      name: "keyword suggestions",
      path: "/v3/dataforseo_labs/google/keyword_suggestions/live",
      call: () =>
        fetchKeywordSuggestions({ keyword: "geo tools", ...KW, limit: 10 }),
    },
    {
      name: "keyword ideas",
      path: "/v3/dataforseo_labs/google/keyword_ideas/live",
      call: () => fetchKeywordIdeas({ keyword: "geo tools", ...KW, limit: 10 }),
    },
    {
      name: "domain rank overview",
      path: "/v3/dataforseo_labs/google/domain_rank_overview/live",
      call: () => fetchDomainRankOverview(DOMAIN),
    },
    {
      name: "ranked keywords",
      path: "/v3/dataforseo_labs/google/ranked_keywords/live",
      call: () => fetchRankedKeywords({ ...DOMAIN, limit: 10 }),
    },
    {
      name: "relevant pages",
      path: "/v3/dataforseo_labs/google/relevant_pages/live",
      call: () => fetchRelevantPages({ ...DOMAIN, limit: 10 }),
    },
    {
      name: "keyword overview",
      path: "/v3/dataforseo_labs/google/keyword_overview/live",
      call: () => fetchKeywordOverview({ keywords: ["geo tools"], ...KW }),
    },
    {
      name: "serp competitors",
      path: "/v3/dataforseo_labs/google/serp_competitors/live",
      call: () =>
        fetchSerpCompetitors({ keywords: ["geo tools"], ...KW, limit: 10 }),
    },
  ] as const;

  for (const c of cases) {
    it(`sends ${c.name} to ${c.path}`, async () => {
      vi.mocked(fetch).mockImplementation(async () => okResponse([]));

      await c.call();

      const url = requestUrl(vi.mocked(fetch));
      expect(url).toContain(c.path);
      for (const other of cases) {
        if (other.path === c.path) continue;
        expect(url).not.toContain(other.path);
      }
    });
  }
});
