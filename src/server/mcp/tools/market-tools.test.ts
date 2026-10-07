/**
 * `get_domain_categories`, and the two things it must not do.
 *
 * It must not **drop** a category the taxonomy cannot name, and it must not invent a label for
 * one. Both would produce a tidier answer, and both would hide that this build's taxonomy
 * predates the vendor's data. The assertions here are therefore about the *gap staying visible*
 * rather than about the happy path, which the service tests already cover.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDomainCategoriesTool } from "./market-tools";
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
      { projectId: "project_1", target: "acmeexample.com" },
      toolContext,
    );

    const structured = result.structuredContent as {
      categories: Array<{ names: Array<string | null> }>;
      unresolvedCount: number;
    };
    // Two names, one of them null. A `filter(Boolean)` would leave one, and the profile would
    // look complete while missing a category the vendor actually returned.
    expect(structured.categories[0]?.names).toEqual([
      "/Computers/Software",
      null,
    ]);
    expect(structured.unresolvedCount).toBe(1);
    expect(textOf(result.content)).toContain("unnamed");
  });

  it("never opts into the doubled-price clickstream data on its own", async () => {
    const categoriesForDomain = setCategories([{ categories: [10007] }]);

    await getDomainCategoriesTool.handler(
      { projectId: "project_1", target: "acmeexample.com" },
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
      { projectId: "project_1", target: "acmeexample.com" },
      toolContext,
    );

    expect(categoriesForDomain).toHaveBeenCalledWith(
      expect.objectContaining({ locationCode: 2840, languageCode: "en" }),
    );
  });
});
