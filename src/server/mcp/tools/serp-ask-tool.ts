import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AI_SUMMARY_PROMPT_MAX } from "@/server/lib/dataforseo/ai-summary";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import { metaOnlyOutputFields } from "@/server/mcp/tools/geo-shared";

/**
 * `serp_ask` — one question against one SERP.
 *
 * ## This is two billed calls, and the dry run says so
 *
 * DataForSEO's `ai_summary` cannot be called on its own: it needs a `task_id`
 * from a prior SERP POST, and that id expires **30 days** after the post. So a
 * question costs a SERP crawl *plus* the summary:
 *
 * | step | cost |
 * |---|---|
 * | post a SERP task (depth 10, one page) | ~2 credits |
 * | ask the summary | 10 credits |
 *
 * The preview quotes both. A dry run that quoted only the summary would
 * understate the real price by a fifth, which is the kind of error this
 * product refuses elsewhere.
 *
 * ## What the answer is
 *
 * **One model's reading of one SERP.** DataForSEO does not say which model
 * produced it, so neither can this tool — and the summary is not a ranking, not
 * a fact about the web, and not an endorsement of anything it names. A summary
 * that agrees with what the caller hoped for is not evidence the model read the
 * page, so the links it cited are returned separately: what the model *used*
 * is a checkable claim, what it *concluded* is not.
 *
 * ## The `fetch_content` flag is a separate bill
 *
 * It makes DataForSEO crawl the pages behind the results, and that cost is not
 * in the 10-credit figure. It is off by default and named for what it costs.
 *
 * **Support-extra is on by default** (`answer_box`, `knowledge_graph`,
 * `featured_snippet`), which means the summary is not reasoning over organic
 * results alone — stated in the text rather than left for the reader to guess.
 */

type SerpAskRow = {
  title: string;
  url: string;
};

const inputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .min(1)
    .max(700)
    .describe(
      "The search term whose SERP will be asked. DataForSEO rejects a prompt that is irrelevant to this keyword, so pick the term first and the question second.",
    ),
  prompt: z
    .string()
    .min(1)
    .max(AI_SUMMARY_PROMPT_MAX)
    .describe(
      `The question to ask that SERP, up to ${AI_SUMMARY_PROMPT_MAX} characters. Must be relevant to the keyword — DataForSEO rejects an off-topic prompt.`,
    ),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  fetchContent: z
    .boolean()
    .optional()
    .describe(
      "Crawl the pages behind the results so the model can read them. Default false. This is a SEPARATE cost from the 10-credit summary and is not in the dry-run estimate.",
    ),
  supportExtra: z
    .boolean()
    .optional()
    .describe(
      "Let the model also reason over the answer box, knowledge graph and featured snippet. Default true, so the summary is not organic-only.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the cost without spending. Set dry_run: false to post the SERP and ask the question.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const CREDITS_PER_SUMMARY = 10;
const CREDITS_PER_SERP_PAGE = 2;

export const serpAskTool = {
  name: "serp_ask",
  config: {
    title: "Ask a SERP a question",
    description:
      "Posts a Google SERP for one keyword, then asks that SERP a question and returns the model's summary with the links it cited. Two billed steps: the SERP crawl (~2 credits) and the summary (10 credits), so ~12 credits per call — the dry run quotes both. Answers must be relevant to the keyword; an off-topic prompt is a billed rejection. What comes back is ONE model's reading of ONE SERP, not a fact about the web: DataForSEO does not say which model produced it, so treat the summary as an opinion to check and the cited links as the checkable part. Default true, the model also reasons over the answer box, knowledge graph and featured snippet rather than organic results alone. Set fetch_content to crawl the pages behind the results — that is a separate cost, not in the 10 credits. dry_run defaults to true; set dry_run: false to run.",
    inputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        keyword: z.string(),
        prompt: z.string(),
        summary: z.string(),
        links: z.array(
          z
            .object({
              title: z.string(),
              url: z.string(),
            })
            .passthrough(),
        ),
        supportExtra: z.boolean(),
        /** True when the model cited nothing — a real state, not a failure. */
        uncited: z.boolean(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const locationCode = args.locationCode ?? context.project.locationCode;
    const languageCode = args.languageCode ?? context.project.languageCode;
    const supportExtra = args.supportExtra ?? true;

    if (args.dry_run !== false) {
      // Both steps, because the SERP post is billed whether or not the summary
      // is ever requested.
      const estimate = CREDITS_PER_SERP_PAGE + CREDITS_PER_SUMMARY;
      return mcpResponse({
        text: [
          `Dry run: asking "${args.keyword}" a question costs approximately ${estimate} credits — ${CREDITS_PER_SERP_PAGE} for the SERP crawl and ${CREDITS_PER_SUMMARY} for the summary. Charged amount is what DataForSEO reports at send time.`,
          args.fetchContent === true
            ? `You also set fetch_content, which crawls the pages behind the results. That cost is separate and is not included in the ${CREDITS_PER_SUMMARY} credits above.`
            : `Page content is not fetched, so no page-crawl cost is added.`,
          `Re-run with dry_run: false to spend credits and get the answer.`,
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
        structuredContent: {
          dryRun: true,
          keyword: args.keyword,
          locationCode,
          languageCode,
          estimatedCredits: estimate,
        },
      });
    }

    const client = createDataforseoClient(context.billing);
    // Two metered calls, in order: the post exists only to obtain the id the
    // summary needs, and it is billed either way.
    const task = await client.serp.serpTaskForSummary({
      keyword: args.keyword,
      locationCode,
      languageCode,
    });
    const result = await client.serp.aiSummary({
      taskId: task.taskId,
      prompt: args.prompt,
      supportExtra,
      fetchContent: args.fetchContent ?? false,
    });

    const links: SerpAskRow[] = result.links;
    const lines = [
      `One model's answer about "${args.keyword}", asked: "${args.prompt}"`,
      "",
      result.summary,
    ];

    if (links.length > 0) {
      lines.push("", `Sources it cited (${links.length}):`);
      for (const link of links) {
        lines.push(`  - ${link.title} — ${link.url}`);
      }
    } else {
      lines.push(
        "",
        "It cited nothing. That is what the model returned, not a failure to fetch — treat the summary as unsupported.",
      );
    }

    lines.push(
      "",
      "This is one model's reading of one SERP. DataForSEO does not say which model produced it, so the summary is an opinion rather than a finding, and it is not a ranking. The cited links are the checkable part.",
      supportExtra
        ? "The model was also allowed to reason over the answer box, knowledge graph and featured snippet, not organic results alone."
        : "The model saw organic results only.",
    );

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
      ),
      structuredContent: {
        keyword: args.keyword,
        prompt: args.prompt,
        summary: result.summary,
        links,
        supportExtra,
        uncited: links.length === 0,
      },
    });
  }),
};
