/**
 * `get_domain_categories`, and the two things it must not do.
 *
 * It must not **drop** a category the taxonomy cannot name, and it must not invent a label for
 * one. Both would produce a tidier answer, and both would hide that this build's taxonomy
 * predates the vendor's data. The assertions here are therefore about the *gap staying visible*
 * rather than about the happy path, which the service tests already cover.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDomainCategoriesTool } from "./market-tools";
import { getCategoryDomainMetricsTool } from "./category-domain-metrics";
import { getCategoryKeywordsTool } from "./market-tools";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  findCategoryNames: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/features/market-analysis/category-taxonomy", () => ({
  findCategoryNames: mocks.findCategoryNames,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();

function setCategories(items: unknown[]) {
  // The metered client returns the payload rather than the envelope, so the double does too.
  const categoriesForDomain = vi.fn().mockResolvedValue(items);
  mocks.createDataforseoClient.mockReturnValue({
    domain: { categoriesForDomain },
  });
  return categoriesForDomain;
}

/**
 * The first text block. `content` is a union of text, image and resource blocks, and typing the
 * parameter as the loosest of them is what lets this read `text` without an unsafe cast.
 */
function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.find((block) => block.type === "text")?.text ?? "";
}

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    name: "Test",
    domain: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.findCategoryNames.mockResolvedValue(new Map());
});

describe("get_domain_categories", () => {
  it("keeps a category it cannot name, with a null name and a visible count", async () => {
    setCategories([
      {
        categories: [10007, 99999],
        metrics: { organic: { count: 120, etv: 540.5 } },
      },
    ]);
    mocks.findCategoryNames.mockResolvedValue(
      new Map([[10007, "/Computers/Software"]]),
    );

    const result = await getDomainCategoriesTool.handler(
      { dry_run: false, projectId: "project_1", target: "acmeexample.com" },
      toolContext,
    );

    // Two names, one of them null. A `filter(Boolean)` would leave one, and the profile would
    // look complete while missing a category the vendor actually returned.
    expect(result.structuredContent).toMatchObject({
      categories: [{ names: ["/Computers/Software", null] }],
      unresolvedCount: 1,
    });
    expect(textOf(result.content)).toContain("unnamed");
  });

  it("never opts into the doubled-price clickstream data on its own", async () => {
    const categoriesForDomain = setCategories([{ categories: [10007] }]);

    await getDomainCategoriesTool.handler(
      { dry_run: false, projectId: "project_1", target: "acmeexample.com" },
      toolContext,
    );

    expect(categoriesForDomain).toHaveBeenCalledWith(
      expect.objectContaining({ includeClickstreamData: false }),
    );
  });

  it("passes the opt-in through when the caller asks for it", async () => {
    const categoriesForDomain = setCategories([{ categories: [10007] }]);

    await getDomainCategoriesTool.handler(
      {
        dry_run: false,
        projectId: "project_1",
        target: "acmeexample.com",
        includeClickstreamData: true,
      },
      toolContext,
    );

    expect(categoriesForDomain).toHaveBeenCalledWith(
      expect.objectContaining({ includeClickstreamData: true }),
    );
  });

  it("resolves the project's market when none is given", async () => {
    const categoriesForDomain = setCategories([{ categories: [10007] }]);

    await getDomainCategoriesTool.handler(
      { dry_run: false, projectId: "project_1", target: "acmeexample.com" },
      toolContext,
    );

    expect(categoriesForDomain).toHaveBeenCalledWith(
      expect.objectContaining({ locationCode: 2840, languageCode: "en" }),
    );
  });
});

function setCategoryKeywords(items: unknown[]) {
  const keywordsForCategories = vi.fn().mockResolvedValue(items);
  mocks.createDataforseoClient.mockReturnValue({
    domain: { keywordsForCategories },
  });
  return keywordsForCategories;
}

describe("get_category_keywords", () => {
  it("defaults to ANY-category, not the vendor's all-category default", async () => {
    // The vendor defaults `category_intersection` to true, which returns only keywords present in
    // **every** named category. Reading "keywords for these categories" as an intersection is
    // almost never what a caller means, and its failure mode is an empty list that looks like a
    // broken request — so the tool's default is its own, and this pins it.
    const keywordsForCategories = setCategoryKeywords([
      { keyword: "desktop dell optiplex" },
    ]);

    await getCategoryKeywordsTool.handler(
      { dry_run: false, projectId: "project_1", categoryCodes: [12191, 12193] },
      toolContext,
    );

    expect(keywordsForCategories).toHaveBeenCalledWith(
      expect.objectContaining({ categoryIntersection: false }),
    );
  });

  it("passes the intersection through when the caller asks for it", async () => {
    const keywordsForCategories = setCategoryKeywords([]);

    const result = await getCategoryKeywordsTool.handler(
      {
        dry_run: false,
        projectId: "project_1",
        categoryCodes: [12191, 12193],
        categoryIntersection: true,
      },
      toolContext,
    );

    expect(keywordsForCategories).toHaveBeenCalledWith(
      expect.objectContaining({ categoryIntersection: true }),
    );
    // An empty intersection looks like a failure unless the answer says why it is empty.
    expect(textOf(result.content)).toContain("categoryIntersection false");
  });
});

function setDomainMetrics(items: unknown[]) {
  const domainMetricsByCategories = vi.fn().mockResolvedValue(items);
  mocks.createDataforseoClient.mockReturnValue({
    domain: { domainMetricsByCategories },
  });
  return domainMetricsByCategories;
}

describe("get_category_domain_metrics", () => {
  it("does not call a straddling window a missing month", async () => {
    // **The C6 follow-up, found by CodeRabbit's review.**
    //
    // A domain whose two months straddle 2026-11-01 has `growing: null` — two formulas
    // apart there is no direction to report — while still having a reading for *both*
    // months. The first version counted "no direction" as "no reading", so the tool
    // described it as lacking a month and then, one clause later, said it had a window
    // that straddled a formula change. Two clauses contradicting each other about the
    // same row.
    setDomainMetrics([
      {
        domain: "acmeexample.com",
        metrics_history: {
          "202610": { organic: { etv: 100 } },
          "202611": { organic: { etv: 260 } },
        },
      },
    ]);

    const result = await getCategoryDomainMetricsTool.handler(
      {
        dry_run: false,
        projectId: "project_1",
        categoryCodes: [11494],
        firstDate: "2026-10-01",
        secondDate: "2026-11-15",
      },
      toolContext,
    );

    const text = textOf(result.content);
    expect(text).toContain("2026-11-01");
    expect(text).not.toContain("lack a reading");
  });

  it("says so when the window straddles the ETV cutover, instead of calling it growth", async () => {
    // **The C6 gap, at the tool's surface rather than the function's.**
    //
    // `firstDate`/`secondDate` are caller-supplied, so a straddling window is a question a
    // caller can ask. `metric-movement` returns `spansCutover` and no direction — but the
    // *text* is where a reader would find out, and a tool that answered "1 of the 1 grew
    // between them" for a window spanning the vendor's formula switch would be reporting a
    // model change as traffic growth.
    setDomainMetrics([
      {
        domain: "acmeexample.com",
        metrics_history: {
          "202610": { organic: { etv: 100 } },
          "202611": { organic: { etv: 260 } },
        },
      },
    ]);

    const result = await getCategoryDomainMetricsTool.handler(
      {
        dry_run: false,
        projectId: "project_1",
        categoryCodes: [11494],
        firstDate: "2026-10-01",
        secondDate: "2026-11-15",
      },
      toolContext,
    );

    const text = textOf(result.content);
    expect(text).toContain("2026-11-01");
    // **The change is still shown**, so the reader has the number; what is refused is
    // the claim about what it means.
    expect(text).not.toMatch(/1 of the 1 with both months on record grew/);
  });

  it("states the price, because this is the expensive endpoint", async () => {
    setDomainMetrics([{ domain: "acmeexample.com" }]);

    const result = await getCategoryDomainMetricsTool.handler(
      {
        dry_run: false,
        projectId: "project_1",
        categoryCodes: [11494, 13418],
        firstDate: "2021-06-01",
        secondDate: "2021-10-01",
      },
      toolContext,
    );

    // A price quoted from the price book, not from a hardcoded string: the text
    // must contain the figure the constants produce, and the structured copy
    // must carry the request cost as a number that is actually above a cent.
    const parsed = z
      .object({ requestCostUsd: z.number() })
      .parse(result.structuredContent);
    expect(parsed.requestCostUsd).toBeGreaterThan(0.1);
    expect(textOf(result.content)).toContain("$0.12");
  });

  it("derives growth from the two months, not from the vendor's difference block", async () => {
    // The item carries a `metrics_difference` whose sign contradicts the history — which is what
    // the vendor's own sample does. The direction must come from the two months, because an
    // unexplained sign is not evidence.
    setDomainMetrics([
      {
        domain: "enricospastryshop.com",
        metrics_history: {
          "202106": { organic: { etv: 147.22 } },
          "202110": { organic: { etv: 308.87 } },
        },
        metrics_difference: { organic: { etv: -161.65 } },
      },
    ]);

    const result = await getCategoryDomainMetricsTool.handler(
      {
        dry_run: false,
        projectId: "project_1",
        categoryCodes: [11494],
        firstDate: "2021-06-01",
        secondDate: "2021-10-01",
      },
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({
      domains: [{ etvChange: 161.65, growing: true }],
    });
  });

  it("reports no direction when one of the months has no reading", async () => {
    setDomainMetrics([
      {
        domain: "quiet.example",
        metrics_history: {
          "202106": { organic: { etv: 100 } },
          "202110": { organic: null },
        },
      },
    ]);

    const result = await getCategoryDomainMetricsTool.handler(
      {
        dry_run: false,
        projectId: "project_1",
        categoryCodes: [11494],
        firstDate: "2021-06-01",
        secondDate: "2021-10-01",
      },
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({
      domains: [{ growing: null }],
    });
    expect(textOf(result.content)).toContain("without a direction");
  });
});
