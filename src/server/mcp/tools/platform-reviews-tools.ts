import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import {
  rollupReviewSentiment,
  type ReviewRating,
  type SentimentRollup,
} from "@/server/features/reviews/sentimentRollup";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  estimateTripadvisorReviews,
  estimateTrustpilotReviews,
} from "@/server/lib/dataforseo/client-estimates";
import {
  fetchTripadvisorReviewsResult,
  fetchTrustpilotReviewsResult,
} from "@/server/lib/dataforseo/reviews";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  creditsFor,
  dryRunInputSchema,
  dryRunResponse,
  wantsToSpend,
} from "@/server/mcp/dry-run";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import { DFS_LOCAL } from "@/shared/dataforseo-pricing";
import { resolveLabsMarket } from "@/shared/keyword-locations";

/**
 * Multi-platform reviews (CL-504): Trustpilot + Tripadvisor.
 *
 * Two tools, because a reviews task is queued and takes minutes: posting
 * blocks nothing, and collecting polls nothing. `post_platform_reviews`
 * spends (dry_run previews the block price); `collect_platform_reviews`
 * reads free for 30 days and rolls the rows into an aggregate sentiment —
 * counts, averages, distribution. Reviewer names, profile URLs, titles and
 * texts never leave the vendor response: the product has no question that
 * needs them, and an aggregate that carries PII is not an aggregate.
 */

const postInputSchema = {
  projectId: projectIdSchema,
  platform: z
    .enum(["trustpilot", "tripadvisor"])
    .describe("Review platform to collect from."),
  domain: z
    .string()
    .min(1)
    .max(253)
    .optional()
    .describe(
      "Trustpilot business domain (www.example.com, from the Trustpilot business URL). Required for trustpilot.",
    ),
  urlPath: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "Tripadvisor business URL path (recommended accuracy). Required for tripadvisor unless keyword+location is given.",
    ),
  keyword: z
    .string()
    .min(1)
    .max(700)
    .optional()
    .describe("Tripadvisor business name; needs a location with it."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  depth: z
    .number()
    .int()
    .positive()
    .max(4490)
    .optional()
    .describe(
      "Reviews to collect (defaults to one block). Trustpilot caps at 200 and bills per 20; tripadvisor caps at 4490 and bills per 10. A trustpilot depth above 200 is refused before anything bills.",
    ),
  ...dryRunInputSchema,
} as const;

type PostArgs = z.infer<z.ZodObject<typeof postInputSchema>>;

function estimatePostUsd(
  platform: "trustpilot" | "tripadvisor",
  depth?: number,
): number {
  return platform === "trustpilot"
    ? estimateTrustpilotReviews({ depth })
    : estimateTripadvisorReviews({ depth });
}

export const postPlatformReviewsTool = {
  name: "post_platform_reviews",
  config: {
    title: "Post a platform reviews collection",
    description:
      "Starts a Trustpilot or Tripadvisor reviews collection for a business: returns a task id to collect later. Trustpilot needs the business domain; tripadvisor needs its URL path (or a keyword plus location). Charges credits in blocks (about $0.00075 per 20 Trustpilot or 10 Tripadvisor reviews). `dry_run` defaults to true, so the first call previews the credit estimate without spending; set `dry_run: false` to run.",
    inputSchema: postInputSchema,
    outputSchema: z.looseObject({
      taskId: z.string().optional(),
      platform: z.string().optional(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: PostArgs, context) => {
    const { locationCode, languageCode } = resolveLabsMarket(
      args,
      context.project,
    );
    assertLabsLocationCode(locationCode);
    assertLanguageForLocation(locationCode, languageCode);
    // Platform caps enforced before the quote: quoting a depth the service
    // refuses would price a call that can never run.
    if (args.platform === "trustpilot" && (args.depth ?? 20) > 200) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Trustpilot caps depth at 200 reviews; tripadvisor allows up to 4490",
      );
    }
    if (!wantsToSpend(args.dry_run)) {
      const usd = estimatePostUsd(args.platform, args.depth);
      const book =
        args.platform === "trustpilot"
          ? DFS_LOCAL.trustpilotReviews
          : DFS_LOCAL.tripadvisorReviews;
      return dryRunResponse({
        subject: `${args.platform} reviews collection`,
        estimatedCredits: creditsFor(usd),
        unitSentence: `USD ${book.standard} per ${book.unit}, DataForSEO business data`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structured: {},
      });
    }
    const client = createDataforseoClient(context.billing);
    const taskId =
      args.platform === "trustpilot"
        ? await client.business.trustpilotReviewsTaskPost({
            domain: args.domain ?? "",
            depth: args.depth,
          })
        : // No language: tripadvisor bills language_code as an extra
          // request, so it is never sent by default. The location disambiguates
          // the business; translate_reviews defaults true server-side.
          await client.business.tripadvisorReviewsTaskPost({
            urlPath: args.urlPath,
            keyword: args.keyword,
            locationCode,
            depth: args.depth,
          });
    return mcpResponse({
      text: [
        `${args.platform} reviews task posted: ${taskId}.`,
        "Collect it with collect_platform_reviews once the vendor finishes — collection is free for 30 days.",
      ].join("\n"),
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { taskId, platform: args.platform },
    });
  }),
};

const collectInputSchema = {
  projectId: projectIdSchema,
  platform: z.enum(["trustpilot", "tripadvisor"]),
  taskId: z.string().uuid().describe("Task id from post_platform_reviews."),
} as const;

type CollectArgs = z.infer<z.ZodObject<typeof collectInputSchema>>;

export const collectPlatformReviewsTool = {
  name: "collect_platform_reviews",
  config: {
    title: "Collect platform reviews with sentiment rollup",
    description:
      "Reads a posted Trustpilot/Tripadvisor task (pending until the vendor finishes) and rolls its rows into aggregate sentiment: per-platform counts, averages, and the 1-5 distribution. Free to call for 30 days after posting. Aggregate only — reviewer names, titles and texts never leave the vendor response.",
    inputSchema: collectInputSchema,
    outputSchema: z.looseObject({
      status: z.string(),
      rollup: looseObjectOutputSchema.optional(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CollectArgs, context) => {
    const outcome =
      args.platform === "trustpilot"
        ? await fetchTrustpilotReviewsResult(args.taskId)
        : await fetchTripadvisorReviewsResult(args.taskId);
    if (outcome.status === "pending" || outcome.result === null) {
      const text =
        outcome.status === "pending"
          ? "Task still queued at the vendor — collect again later. Polling changes nothing; the task finishes on its own."
          : "Task completed with no reviews. No rows is an answer about the business, not a failure of the read.";
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { status: outcome.status },
      });
    }
    const items = outcome.result.items ?? [];
    const ratings: ReviewRating[] = items.map((item) => ({
      platform: args.platform,
      value: item.rating?.value ?? null,
      max: item.rating?.rating_max ?? 5,
    }));
    const rollup: SentimentRollup = rollupReviewSentiment(ratings);
    const lines = [
      `${args.platform} sentiment over ${rollup.totalReviews} review(s):`,
      ...rollup.platforms.map(
        (entry) =>
          `  average ${entry.averageOn5 === null ? "unmeasured" : entry.averageOn5.toFixed(1)} of 5 across ${entry.reviews} review(s) [${entry.distribution.join("/")}]`,
      ),
      ...(rollup.unrated > 0
        ? [
            `  ${rollup.unrated} row(s) carried no usable rating and are counted, not averaged.`,
          ]
        : []),
    ];
    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { status: "completed", rollup },
    });
  }),
};
