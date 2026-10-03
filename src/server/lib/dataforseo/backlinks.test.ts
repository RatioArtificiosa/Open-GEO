import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

const { classifyBacklinksError } = vi.hoisted(() => ({
  classifyBacklinksError: vi.fn(),
}));

// The classifier is built inside backlinks.ts via createDataforseoBillingClassifier;
// returning our hoisted mock lets the test drive classification.
vi.mock("@/server/lib/dataforseoBillingClassification", () => ({
  createDataforseoBillingClassifier: () => classifyBacklinksError,
}));

import {
  fetchAnchors,
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
} from "@/server/lib/dataforseo/backlinks";
import { normalizeBacklinksTarget } from "@/server/lib/dataforseoBacklinksTarget";
import { requestBody, requestUrl } from "./test-support";

// A successful DataForSEO task always carries billing metadata (path + cost).
const billed = {
  path: ["v3", "backlinks", "summary", "live"],
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

describe("normalizeBacklinksTarget", () => {
  it("defaults inputs with a path to a subfolder lookup", () => {
    expect(
      normalizeBacklinksTarget("https://github.com/RatioArtificiosa/Open-GEO/"),
    ).toEqual({
      apiTarget: "github.com",
      displayTarget: "github.com/RatioArtificiosa/Open-GEO",
      scope: "subfolder",
      includeSubdomains: false,
      path: "/RatioArtificiosa/Open-GEO",
    });
  });

  it("strips query strings and fragments for subfolder lookups", () => {
    expect(
      normalizeBacklinksTarget("example.com/blog?utm_source=x#hero", {
        scope: "subfolder",
      }).path,
    ).toBe("/blog");
  });

  it("rejects subfolder scope without a path", () => {
    expectValidationError(() =>
      normalizeBacklinksTarget("example.com", { scope: "subfolder" }),
    );
  });

  it("defaults bare hostnames to subdomains scope", () => {
    expect(normalizeBacklinksTarget("Example.com")).toEqual({
      apiTarget: "example.com",
      displayTarget: "example.com",
      scope: "subdomains",
      includeSubdomains: true,
      path: "",
    });
  });

  it("includes subdomains only for subdomains scope", () => {
    expect(
      normalizeBacklinksTarget("https://Example.com/pricing", {
        scope: "subdomains",
      }),
    ).toEqual({
      apiTarget: "example.com",
      displayTarget: "example.com",
      scope: "subdomains",
      includeSubdomains: true,
      path: "",
    });
  });

  it("lets callers force a page lookup for bare hostnames", () => {
    expect(
      normalizeBacklinksTarget("Example.com", { scope: "exact_url" }),
    ).toEqual({
      apiTarget: "https://example.com/",
      displayTarget: "https://example.com/",
      scope: "exact_url",
      includeSubdomains: true,
      path: "",
    });
  });

  it("maps the legacy page scope onto exact_url", () => {
    expect(normalizeBacklinksTarget("Example.com", { scope: "page" })).toEqual({
      apiTarget: "https://example.com/",
      displayTarget: "https://example.com/",
      scope: "exact_url",
      includeSubdomains: true,
      path: "",
    });
  });

  it("rejects exact-url targets with query strings or fragments", () => {
    expectValidationError(() =>
      normalizeBacklinksTarget(
        "https://example.com/pricing?token=secret#hero",
        { scope: "exact_url" },
      ),
    );
  });

  it("rejects page targets with embedded credentials", () => {
    expectValidationError(() =>
      normalizeBacklinksTarget("https://user:pass@example.com/private"),
    );
  });

  it("rejects hostnames with unrecognized public suffixes before provider calls", () => {
    expectValidationError(() => normalizeBacklinksTarget("example.invalidtld"));
  });
});

describe("fetchBacklinksSummary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("classifies top-level DataForSEO body errors using status_code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 40200,
          status_message: "Account balance is too low",
          tasks: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    classifyBacklinksError.mockImplementation((status: number | undefined) => {
      if (status === 40200) {
        return new AppError(
          "BACKLINKS_BILLING_ISSUE",
          "The connected DataForSEO account has a billing or balance issue",
        );
      }
      return null;
    });

    await expect(
      fetchBacklinksSummary({ target: "example.com" }),
    ).rejects.toMatchObject({ code: "BACKLINKS_BILLING_ISSUE" });

    expect(classifyBacklinksError).toHaveBeenCalledWith(
      40200,
      expect.stringContaining("Account balance is too low"),
      "/v3/backlinks/summary/live",
    );
  });

  it("treats null summary results as a valid zero-data response", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse([null]));
    classifyBacklinksError.mockReturnValue(null);

    await expect(
      fetchBacklinksSummary({ target: "not-a-real-input.example" }),
    ).resolves.toMatchObject({ data: {} });
  });

  it("treats empty summary results as a valid zero-data response", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse([]));
    classifyBacklinksError.mockReturnValue(null);

    await expect(
      fetchBacklinksSummary({ target: "example.com" }),
    ).resolves.toMatchObject({ data: {} });
  });

  it("asks DataForSEO to exclude subdomains for a domain-scoped target", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse([]));
    classifyBacklinksError.mockReturnValue(null);

    await fetchBacklinksSummary({
      target: "example.com",
      includeSubdomains: false,
    });

    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected DataForSEO request body to be a string");
    }
    expect(JSON.parse(body)).toMatchObject([
      { target: "example.com", include_subdomains: false },
    ]);
  });

  it("treats empty backlinks rows and history results as valid empty arrays", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(okResponse([]))
      .mockResolvedValueOnce(okResponse([]));
    classifyBacklinksError.mockReturnValue(null);

    await expect(
      fetchBacklinksRows({ target: "example.com" }),
    ).resolves.toMatchObject({ data: { items: [], totalCount: null } });
    await expect(
      fetchBacklinksHistory({
        target: "example.com",
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
      }),
    ).resolves.toMatchObject({ data: [] });
  });
});

describe("fetchAnchors", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /**
   * **The path is asserted here because `endpoint-path-gate` cannot see it.**
   *
   * That gate takes `detectPath(source)` — the *first* `/v3/…` string in a client file —
   * and `backlinks.ts` opens with `summary`, so it has been checking `/v3/backlinks/summary/live`
   * and reporting the file covered ever since. **Four of this file's five endpoints have
   * never been gated**, including the two this row adds. So the assertion the gate owes is
   * written next to the call instead, which is the only place it can be relied on.
   */
  it("posts to the anchors endpoint, not the referring-domains one", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse([]));
    classifyBacklinksError.mockReturnValue(null);

    await fetchAnchors({ target: "example.com" });

    const url = requestUrl(vi.mocked(fetch));
    // **Both directions asserted**, because the plausible mistake is not a typo but a copy
    // of the sibling function: anchors and referring domains have identical bodies and
    // differ only in the path, so a copy-paste passes every other test in this file.
    expect(url).toContain("/v3/backlinks/anchors/live");
    expect(url).not.toContain("referring_domains");
  });

  it("orders by backlinks then referring domains, not by rank", async () => {
    // **A default is a product decision and it is the wrong way round by default for this
    // table.** Sorted by rank, an anchor list shows the best-*positioned* phrase rather
    // than the most-*linked* one — which answers "where are we strongest" when the reader
    // asked "which phrases describe us". Both questions are legitimate, so a caller can
    // pass `orderBy`; the default is the one the table is read as.
    vi.mocked(fetch).mockResolvedValue(okResponse([]));
    classifyBacklinksError.mockReturnValue(null);

    await fetchAnchors({ target: "example.com" });

    const body = requestBody(vi.mocked(fetch));

    expect(body[0].order_by).toEqual([
      "backlinks,desc",
      "referring_domains,desc",
    ]);
  });

  it("carries the spam filter when asked, so a spam anchor table is opt-in", async () => {
    // **The filter is applied on the server, not trusted from the UI** — the same path
    // `fetchReferringDomains` takes, and the reason an anchor table and a domain table
    // agree about what counts as spam.
    vi.mocked(fetch).mockResolvedValue(okResponse([]));
    classifyBacklinksError.mockReturnValue(null);

    await fetchAnchors({
      target: "example.com",
      hideSpam: true,
      spamThreshold: 5,
    });

    const body = requestBody(vi.mocked(fetch));

    expect(body[0].filters).toEqual([["backlinks_spam_score", "<=", 5]]);
  });

  it("parses an anchor row and keeps unknown fields, so a vendor addition is not a crash", async () => {
    // **`.passthrough()`, and it is the reason `refused an unknown model_name before
    // dispatching a paid LLM task` is a rule in this repository**: a schema that rejects
    // the response would fail a *billed* call. Evidence is stored raw so a vendor change
    // never loses it.
    // **A row, not a bare array** — `parseTaskItems` reads `task.result[0].items`, so
    // passing `[row]` yields zero items rather than an error, and the first version of this
    // test reported `expected [] to have a length of 1` with no clue why. **A parser that
    // finds nothing where something was sent is worse than one that throws.**
    vi.mocked(fetch).mockResolvedValue(
      okResponse([
        {
          items: [
            {
              anchor: "open geo tooling",
              backlinks: 42,
              referring_domains: 17,
              rank: 3,
              first_seen: "2025-01-01",
              last_seen: "2026-09-01",
              something_new: { nested: true },
            },
          ],
        },
      ]),
    );
    classifyBacklinksError.mockReturnValue(null);

    const result = await fetchAnchors({ target: "example.com" });

    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({
      anchor: "open geo tooling",
      backlinks: 42,
      referring_domains: 17,
      something_new: { nested: true },
    });
    // Billing is captured from the task envelope, so a paid call is never unaccounted.
    // **`costUsd`, not `cost`** — the envelope's field is `cost` and the *product's* field is
    // `costUsd`, and the first version asserted `cost`, which fails because a `toMatchObject`
    // on a missing key is a red test rather than a silent pass. Worth pinning both, because a
    // billing record with the wrong endpoint is how a per-endpoint price book stops matching
    // its own line items.
    expect(result.billing).toMatchObject({
      costUsd: 0.02,
      path: ["v3", "backlinks", "summary", "live"],
    });
  });

  it("treats an empty anchor result as a valid empty table, not an error", async () => {
    // **The shape the repo keeps getting wrong.** A target with no anchor text is a
    // legitimate answer, and a client that renders it as a failure tells the customer
    // their backlinks are broken when they simply have no anchor text.
    vi.mocked(fetch).mockResolvedValue(okResponse([]));
    classifyBacklinksError.mockReturnValue(null);

    await expect(
      fetchAnchors({ target: "example.com" }),
    ).resolves.toMatchObject({ data: { items: [], totalCount: null } });
  });
});

function expectValidationError(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
    return;
  }

  throw new Error("Expected normalizeBacklinksTarget to throw");
}
