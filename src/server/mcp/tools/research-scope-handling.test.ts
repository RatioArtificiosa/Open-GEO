/**
 * Scope handling for `get_ranked_keywords`, split out of the research-tools spec.
 *
 * The scope resolution is the part of that tool with its own incident history:
 * the legacy `includeSubdomains` selects between whole-host scopes for a bare
 * domain and means exact-page results for a page URL, and mapping it to
 * domain/subdomains for a URL target silently drops the path — a ranking check
 * that returns the wrong answer for the right question. It is also where the
 * `dry_run` default changed the shape of every call site, and a spec that mixes
 * three concerns makes the opt-out look like the point.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRankedKeywordsTool } from "./dataforseo-research-tools";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();
const usProjectRow = {
  id: "project_1",
  locationCode: 2840,
  languageCode: "en",
};

/** The vendor call the scope tests assert on. */
const rankedKeywords =
  vi.fn<
    (input: {
      filters?: unknown[];
    }) => Promise<{ items: unknown[]; totalCount: number }>
  >();

describe("get_ranked_keywords scope handling", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue(usProjectRow);
    rankedKeywords.mockResolvedValue({ items: [], totalCount: 0 });
    mocks.createDataforseoClient.mockReturnValue({
      domain: { rankedKeywords },
    });
  });

  it("passes only explicit brand exclusions to ranked keyword filters", async () => {
    await getRankedKeywordsTool.handler(
      {
        projectId: "project_1",
        target: "acmeexample.com",
        scope: "subdomains",
        dry_run: false,
        excludeBrandTerms: ["acme"],
      },
      toolContext,
    );

    expect(rankedKeywords).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [["keyword_data.keyword", "not_ilike", "%acme%"]],
      }),
    );
  });

  it("defaults a bare domain to subdomains scope with no scope filters", async () => {
    const result = await getRankedKeywordsTool.handler(
      { projectId: "project_1", target: "acmeexample.com", dry_run: false },
      toolContext,
    );

    expect(rankedKeywords).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "acmeexample.com",
        filters: undefined,
      }),
    );
    expect(result.structuredContent).toMatchObject({
      target: "acmeexample.com",
      scope: "subdomains",
    });
  });

  // The clause shape itself is pinned in researchScopeFilters.test.ts; here
  // only "the scope filter reaches the API call" is the invariant.
  it("sends scope filters for an explicit narrower scope", async () => {
    await getRankedKeywordsTool.handler(
      {
        projectId: "project_1",
        target: "acmeexample.com",
        scope: "domain",
        dry_run: false,
      },
      toolContext,
    );

    expect(Array.isArray(rankedKeywords.mock.calls[0]?.[0].filters)).toBe(true);
  });
});
