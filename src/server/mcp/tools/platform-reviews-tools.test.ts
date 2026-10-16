import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { estimateTrustpilotReviews } from "@/server/lib/dataforseo/client-estimates";
import { creditsFor } from "@/server/mcp/dry-run";
import {
  collectPlatformReviewsTool,
  postPlatformReviewsTool,
} from "./platform-reviews-tools";
import { makeToolContext, textContent } from "./tool-test-support";

/**
 * Platform reviews (CL-504): post spends with a preview, collect reads free
 * and rolls up aggregates. The collect path is driven through the tool
 * handler against a mocked reader — the assertions below would fail on a
 * row smuggled through with its reviewer name, title, or text.
 */

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  createDataforseoClient: vi.fn(),
  trustpilotReviewsTaskPost: vi.fn(),
  tripadvisorReviewsTaskPost: vi.fn(),
  fetchTrustpilotReviewsResult: vi.fn(),
  fetchTripadvisorReviewsResult: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/lib/dataforseo/reviews", () => ({
  fetchTrustpilotReviewsResult: mocks.fetchTrustpilotReviewsResult,
  fetchTripadvisorReviewsResult: mocks.fetchTripadvisorReviewsResult,
}));

const toolContext = makeToolContext();

const dryRunShape = z
  .object({ dryRun: z.literal(true), estimatedCredits: z.number() })
  .passthrough();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.createDataforseoClient.mockReturnValue({
    business: {
      trustpilotReviewsTaskPost: mocks.trustpilotReviewsTaskPost,
      tripadvisorReviewsTaskPost: mocks.tripadvisorReviewsTaskPost,
    },
  });
});

describe("post_platform_reviews", () => {
  it("dry-runs by default, quoting review blocks from the book", async () => {
    const result = await postPlatformReviewsTool.handler(
      { projectId: "project_1", platform: "trustpilot", domain: "example.com" },
      toolContext,
    );
    expect(mocks.trustpilotReviewsTaskPost).not.toHaveBeenCalled();
    const structured = dryRunShape.parse(result.structuredContent);
    // Triple: trustpilot task_post, DFS_LOCAL.trustpilotReviews, this pin —
    // one block of 20 at the standard tier.
    expect(structured.estimatedCredits).toBeCloseTo(
      creditsFor(estimateTrustpilotReviews({})),
      10,
    );
    expect(textContent(result)).toContain("dry_run: false");
  });

  it("refuses a trustpilot depth above 200 before quoting", async () => {
    await expect(
      postPlatformReviewsTool.handler(
        {
          projectId: "project_1",
          platform: "trustpilot",
          domain: "example.com",
          depth: 201,
        },
        toolContext,
      ),
    ).rejects.toThrow(/caps depth at 200/);
    expect(mocks.trustpilotReviewsTaskPost).not.toHaveBeenCalled();
  });

  it("posts through the metered facade on dry_run false", async () => {
    mocks.trustpilotReviewsTaskPost.mockResolvedValue("task-9");
    const result = await postPlatformReviewsTool.handler(
      {
        projectId: "project_1",
        platform: "trustpilot",
        domain: "example.com",
        dry_run: false,
      },
      toolContext,
    );
    expect(mocks.trustpilotReviewsTaskPost).toHaveBeenCalledTimes(1);
    expect(textContent(result)).toContain("task-9");
  });
});

describe("collect_platform_reviews", () => {
  it("rolls collected rows into aggregates without reviewer text", async () => {
    mocks.fetchTrustpilotReviewsResult.mockResolvedValue({
      status: "completed",
      result: {
        domain: "example.com",
        reviews_count: 2,
        items: [
          {
            rating: { value: 2, rating_max: 5 },
            title: "Stay clear",
            review_text: "nickel and dime",
            user_profile: { name: "Mo" },
          },
          {
            rating: { value: 5, rating_max: 5 },
            title: "Great service",
            review_text: "highly recommend",
            user_profile: { name: "Xin Tong" },
          },
        ],
      },
    });
    const result = await collectPlatformReviewsTool.handler(
      {
        projectId: "project_1",
        platform: "trustpilot",
        taskId: "00000000-0000-4000-8000-000000000001",
      },
      toolContext,
    );
    const text = textContent(result);
    expect(text).toContain("3.5");
    expect(text).toContain("2 review(s)");
    // Aggregate means aggregate: no names, titles, or texts leave the rows.
    expect(text).not.toContain("Mo");
    expect(text).not.toContain("Stay clear");
    expect(text).not.toContain("nickel and dime");
    const structured = z
      .object({ status: z.literal("completed"), rollup: z.looseObject({}) })
      .passthrough()
      .parse(result.structuredContent);
    expect(JSON.stringify(structured.rollup)).not.toContain("Mo");
  });

  it("reports pending without inventing rows", async () => {
    mocks.fetchTrustpilotReviewsResult.mockResolvedValue({
      status: "pending",
      result: null,
    });
    const result = await collectPlatformReviewsTool.handler(
      {
        projectId: "project_1",
        platform: "trustpilot",
        taskId: "00000000-0000-4000-8000-000000000001",
      },
      toolContext,
    );
    expect(textContent(result)).toMatch(/queued/i);
  });
});
