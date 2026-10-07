import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  getPageWaterfallTool,
  startPageSpeedAuditTool,
} from "./page-speed-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();

const structured = (result: { structuredContent?: unknown }) =>
  z
    .object({
      taskId: z.string().optional(),
      crawlProgress: z.string().nullable().optional(),
      slowestResources: z.array(z.record(z.string(), z.unknown())).optional(),
      page: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .parse(result.structuredContent);

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2840,
    languageCode: "en",
  });
});

describe("start_page_speed_audit", () => {
  it("posts a resource-loading crawl and hands back its id", async () => {
    const waterfallTask = vi.fn().mockResolvedValue({
      taskId: "task-1",
      url: "https://example.com/pricing",
    });
    mocks.createDataforseoClient.mockReturnValue({
      onPage: { waterfallTask },
    });

    const result = await startPageSpeedAuditTool.handler(
      { projectId: "project_1", url: "https://example.com/pricing" },
      toolContext,
    );

    // One page by default: a waterfall is about one URL, and the crawl is what costs.
    expect(waterfallTask).toHaveBeenCalledWith({
      url: "https://example.com/pricing",
      maxCrawlPages: 1,
    });
    expect(structured(result).taskId).toBe("task-1");
    // The price is stated up front, and so is the fact that the read is free.
    expect(textContent(result)).toMatch(/refunds pages it does not crawl/);
    expect(textContent(result)).toMatch(/costs nothing/);
  });
});

describe("get_page_waterfall", () => {
  it("orders resources slowest first and counts the render-blocking ones", async () => {
    mocks.createDataforseoClient.mockReturnValue({
      onPage: {
        waterfall: vi.fn().mockResolvedValue({
          data: {
            crawlProgress: "finished",
            pages: [
              {
                pageUrl: "https://example.com/",
                timeToInteractiveMs: 644,
                waitingTimeMs: 42,
                downloadTimeMs: 5,
                durationTimeMs: 36,
                resources: [
                  {
                    url: "https://example.com/fast.css",
                    durationMs: 12,
                    isRenderBlocking: false,
                  },
                  {
                    url: "https://example.com/hero.jpg",
                    durationMs: 900,
                    isRenderBlocking: true,
                  },
                ],
              },
            ],
          },
        }),
      },
    });

    const result = await getPageWaterfallTool.handler(
      { projectId: "project_1", taskId: "task-1", url: "https://example.com/" },
      toolContext,
    );

    const { slowestResources, page } = structured(result);
    expect(slowestResources?.[0]?.url).toBe("https://example.com/hero.jpg");
    expect(page?.renderBlockingCount).toBe(1);
    // The headline names the worst offender, because that is the answer to "why is this slow".
    expect(textContent(result)).toMatch(
      /Slowest request: https:\/\/example\.com\/hero\.jpg/,
    );
  });

  it("blames the crawler's welcome before it blames the site", async () => {
    // An empty vendor crawl overwhelmingly means a WAF turned RSiteAuditor away, and a tool that
    // let an agent conclude "nothing to report" would send them to fix the wrong thing.
    mocks.createDataforseoClient.mockReturnValue({
      onPage: {
        waterfall: vi.fn().mockResolvedValue({
          data: { crawlProgress: "in_progress", pages: [] },
        }),
      },
    });

    const result = await getPageWaterfallTool.handler(
      { projectId: "project_1", taskId: "task-1", url: "https://example.com/" },
      toolContext,
    );

    expect(textContent(result)).toMatch(/turned away/);
    expect(structured(result).crawlProgress).toBe("in_progress");
  });
});
