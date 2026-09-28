import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { objectSchema } from "@/server/mcp/output-schemas";
import * as researchTools from "./dataforseo-research-tools";
import * as localSeoTools from "./local-seo-tools";
import { getBacklinksProfileTool } from "./get-backlinks-profile";
import { getRankTrackerTool } from "./get-rank-tracker";
import {
  getProjectContextTool,
  updateProjectContextTool,
} from "./project-context";
import { getSearchConsolePerformanceTool } from "./search-console-tools";
import { runSiteAuditTool } from "./site-audit-tools";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  profileBacklinksPage: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    readonly ctx = null;
  },
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/features/backlinks/services/BacklinksService", () => ({
  BacklinksService: {
    profileBacklinksPage: mocks.profileBacklinksPage,
  },
}));

// A class instance reproduces what the DataForSEO SDK hands the tools: an
// object whose prototype is not Object.prototype (e.g.
// DataforseoLabsSerpCompetitorsLiveItem). Zod 4's z.record() rejects those
// ("expected record, received <ClassName>"), so a record-based output schema
// makes the MCP server fail these passthrough tools with a -32602 output
// validation error even though the API call succeeded.
class ProviderRow {
  constructor(
    public domain: string,
    public rank_absolute: number,
  ) {}
}

const toolContext = makeToolContext({
  userEmail: "team@example.com",
  baseUrl: "https://app.example.com",
});

const backlinkPage = {
  rows: [
    {
      domainFrom: "source.example",
      urlFrom: "https://source.example/post",
      urlTo: "https://example.com/",
      anchor: "Example",
      itemType: "content",
      isDofollow: true,
      relAttributes: ["noopener"],
      rank: 77,
      domainFromRank: 65,
      pageFromRank: 54,
      spamScore: 3,
      firstSeen: "2026-01-01",
      lastSeen: "2026-03-01",
      isLost: false,
      isBroken: false,
      linksCount: 1,
    },
  ],
  totalCount: 450,
  hasMore: true,
  page: 2,
  pageSize: 50,
  fetchedAt: "2026-06-25T00:00:00.000Z",
};

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_123",
    locationCode: 2840,
    languageCode: "en",
  });
});

describe("DataForSEO research tool output schemas", () => {
  // Every tool that streams provider rows straight to structuredContent.
  it.each([
    ["find_serp_competitors", "competitors"],
    ["get_local_serp_results", "results"],
    ["search_local_businesses", "businesses"],
    ["get_google_business_questions", "questions"],
    ["get_ranked_keywords", "keywords"],
    ["get_business_reviews", "reviews"],
    ["get_business_updates", "updates"],
  ])(
    "%s accepts typed (non-plain-object) provider rows",
    async (toolName, field) => {
      const tools = { ...researchTools, ...localSeoTools };
      const tool = Object.values(tools).find((t) => t.name === toolName);
      if (!tool) throw new Error(`tool ${toolName} not found`);

      const schema = objectSchema(tool.config.outputSchema);

      // Mirror the MCP server: validate structuredContent against the tool's
      // own output schema. Extra keys (e.g. get_ranked_keywords' totalCount)
      // are allowed by the passthrough schemas, so one payload covers all.
      const result = await schema.safeParseAsync({
        [field]: [new ProviderRow("example.com", 1)],
        totalCount: 1,
        // Required by the queued business-data tools; ignored by the rest.
        status: "completed",
        taskId: "google:task-1",
      });

      expect(result.success).toBe(true);
    },
  );

  it("get_business_profile accepts a typed provider profile object", async () => {
    const schema = objectSchema(
      localSeoTools.getBusinessProfileTool.config.outputSchema,
    );

    const result = await schema.safeParseAsync({
      profile: new ProviderRow("example.com", 1),
    });

    expect(result.success).toBe(true);
  });

  it("get_backlinks_profile accepts a paginated backlinks profile payload", async () => {
    const schema = objectSchema(getBacklinksProfileTool.config.outputSchema);

    const result = await schema.safeParseAsync({
      target: "example.com",
      scope: "domain",
      backlinks: backlinkPage,
      meta: {
        organizationId: "org_123",
        projectId: "project_123",
        url: "https://app.example.com/p/project_123/backlinks",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("MCP output schemas with expected missing fields", () => {
  // Google omits position for the discover and googleNews search types.
  it("accepts Search Console rows without a position", async () => {
    const schema = objectSchema(
      getSearchConsolePerformanceTool.config.outputSchema,
    );

    const result = await schema.safeParseAsync({
      ok: true,
      rows: [{ clicks: 0, impressions: 1, ctr: 0 }],
    });

    expect(result.success).toBe(true);
  });

  // Refusals (for example, audit capacity) never start an audit, so they
  // have no id to report.
  it("accepts a site-audit refusal without an audit id", async () => {
    const schema = objectSchema(runSiteAuditTool.config.outputSchema);

    const result = await schema.safeParseAsync({
      meta: {
        organizationId: "org_123",
        projectId: "project_123",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("MCP output compatibility across deployments", () => {
  // Clients cache the JSON Schema from tools/list. Zod's safeParse alone
  // misses this regression: it strips unknown fields, while its exported
  // output schema rejects them unless the object allows additional fields.
  const validator = new Ajv({ strict: false });

  it.each([getProjectContextTool, updateProjectContextTool])(
    "$name accepts new context fields while validating known fields",
    (tool) => {
      const validate = validator.compile(
        z.toJSONSchema(objectSchema(tool.config.outputSchema), {
          target: "draft-7",
        }),
      );
      const context = {
        sections: [],
        missingSections: [],
        customSections: [],
        competitors: [],
        keyPages: [],
        researchLog: [],
        reportTemplates: [],
        futureContextField: [],
      };

      expect(validate(context)).toBe(true);
      expect(validate({ ...context, sections: "invalid" })).toBe(false);
      const { sections: _sections, ...missingSections } = context;
      expect(validate(missingSections)).toBe(false);
    },
  );

  it("get_rank_tracker accepts new run fields while validating known fields", () => {
    const validate = validator.compile(
      z.toJSONSchema(getRankTrackerTool.config.outputSchema, {
        target: "draft-7",
      }),
    );
    const run = {
      id: "run_1",
      lastCheckedAt: null,
      completedAt: "2026-09-17T00:00:00.000Z",
      status: "completed",
      errorMessage: null,
      futureRunField: 1,
    };
    const detail = { config: {}, results: { rows: [], run } };

    expect(validate(detail)).toBe(true);
    expect(validate({ configs: [] })).toBe(true);
    expect(validate({ results: { rows: [], run: null } })).toBe(true);
    expect(
      validate({ results: { rows: [], run: { ...run, status: "invalid" } } }),
    ).toBe(false);
    const { completedAt: _completedAt, ...incompleteRun } = run;
    expect(validate({ results: { rows: [], run: incompleteRun } })).toBe(false);
  });
});

describe("get_backlinks_profile MCP tool", () => {
  it("returns paginated backlink rows and honors filters, sorting, and mode", async () => {
    mocks.profileBacklinksPage.mockResolvedValue(backlinkPage);

    const result = await getBacklinksProfileTool.handler(
      {
        projectId: "project_123",
        target: "example.com",
        scope: "domain",
        page: 2,
        pageSize: 50,
        sortField: "spamScore",
        sortOrder: "asc",
        filters: {
          include: "blog",
          linkType: "nofollow",
          hideLost: true,
        },
        mode: "as_is",
        hideSpam: false,
      },
      toolContext,
    );

    expect(mocks.profileBacklinksPage).toHaveBeenCalledWith(
      {
        target: "example.com",
        scope: "domain",
        page: 2,
        pageSize: 50,
        sortField: "spamScore",
        sortOrder: "asc",
        filters: {
          include: "blog",
          linkType: "nofollow",
          hideLost: true,
        },
        mode: "as_is",
      },
      {
        userId: "user_123",
        userEmail: "team@example.com",
        organizationId: "org_123",
        projectId: "project_123",
      },
      { hideSpam: false },
    );
    expect(result.structuredContent?.backlinks).toEqual(backlinkPage);
    const first = result.content[0];
    expect(first.type === "text" && first.text).toContain("- has more: yes");
  });

  it("passes through final-page pagination state", async () => {
    const finalPage = {
      ...backlinkPage,
      totalCount: 51,
      hasMore: false,
      page: 2,
    };
    mocks.profileBacklinksPage.mockResolvedValue(finalPage);

    const result = await getBacklinksProfileTool.handler(
      {
        projectId: "project_123",
        target: "example.com",
        scope: "domain",
        page: 2,
        pageSize: 50,
        sortField: "rank",
        sortOrder: "desc",
        filters: {},
        mode: "one_per_domain",
        hideSpam: true,
      },
      toolContext,
    );

    expect(result.structuredContent?.backlinks).toMatchObject({
      totalCount: 51,
      hasMore: false,
      page: 2,
      pageSize: 50,
    });
  });

  it("preserves Backlinks API access and credit errors", async () => {
    const error = new AppError(
      "BACKLINKS_BILLING_ISSUE",
      "The connected DataForSEO account has a billing or balance issue",
    );
    mocks.profileBacklinksPage.mockRejectedValue(error);

    await expect(
      getBacklinksProfileTool.handler(
        {
          projectId: "project_123",
          target: "example.com",
          scope: "domain",
          page: 1,
          pageSize: 100,
          sortField: "rank",
          sortOrder: "desc",
          filters: {},
          mode: "one_per_domain",
          hideSpam: true,
        },
        toolContext,
      ),
    ).rejects.toMatchObject({
      code: "BACKLINKS_BILLING_ISSUE",
      message:
        "The connected DataForSEO account has a billing or balance issue",
    });
  });
});
