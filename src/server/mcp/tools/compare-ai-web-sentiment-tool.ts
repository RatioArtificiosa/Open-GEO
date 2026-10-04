import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { compareSentiment } from "@/server/features/ai-search/services/sentimentComparison";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";

/**
 * `compare_ai_web_sentiment` — "AI says you X; the web says you Y".
 *
 * ## The AI side has no share, and that is the finding
 *
 * The web side has a measured figure: `content_analysis/summary` returns how
 * the vendor classified pages citing the keyword, and a positive share over a
 * known denominator.
 *
 * **The AI side has no equivalent number**, and the first version of this tool
 * papered over that by handing `ai_summary` a fabricated `task_id` and
 * reporting a share that did not exist. That was wrong twice: `ai_summary`
 * needs a real id from a prior SERP POST, and it returns **prose**, not a
 * sentiment classification — there is no denominator to divide by.
 *
 * So the AI side is reported as **prose plus an unavailable share**, and the
 * comparison's direction is `null` because a comparison needs two
 * measurements and only one exists. The tool is honest about being
 * incomplete rather than fabricating the half it does not have.
 *
 * ## What still works, and is the useful part
 *
 * The *gap* is readable in words: the web index classifies the topic N%
 * positive, and this is what AI engines actually say about it. A reader who
 * wanted "is the web more positive than the AI?" gets a real answer about
 * the web, a real quotation of the AI, and is told the two are not
 * measured in the same units. That is more than a blended percentage would
 * have been, and it is true.
 *
 * ## Never one number
 *
 * Not an average, not a delta, not a ratio. `sentimentComparison.ts` refuses
 * to produce one and carries the gate that proves it; the only risk this
 * handler adds is reaching past it, so it does not.
 */

const inputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .min(1)
    .max(300)
    .describe("The topic or brand to compare, e.g. 'crm software'."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  /** Refuse the second call when the caller only wants the web side. */
  webOnly: z
    .boolean()
    .optional()
    .describe(
      "Skip the AI read and report only the web side. Cheaper and faster, but there is then no comparison at all.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the cost without spending. Set dry_run: false to run both reads.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

/** `content_analysis/summary` is ~$0.02; the SERP post + summary pair is ~$0.012. */
const CREDITS_WEB_SIDE = 2;
const CREDITS_AI_SIDE = 12;

/** Asked of the AI side. The answer is quoted, never scored. */
const AI_QUESTION = (keyword: string) =>
  `What do AI assistants say about ${keyword}? Answer in a few sentences.`;

export const compareSentimentTool = {
  name: "compare_ai_web_sentiment",
  config: {
    title: "Compare AI and web sentiment",
    description:
      "Reports how the open web classifies a topic and what AI engines say about it, side by side and never combined. IMPORTANT: the AI side has no numeric sentiment figure — DataForSEO's ai_summary returns prose, not a classification — so the tool reports the web's measured share and quotes the AI, and says the two are not measured in the same units. No blended score, average or ratio is offered, because that would be arithmetic on incompatible numbers. Both reads are billed; dry_run defaults to true.",
    inputSchema,
    outputSchema: z
      .object({
        keyword: z.string(),
        direction: z.enum(["warmer", "colder", "similar"]).nullable(),
        web: z
          .object({
            basis: z.string(),
            share: z.number().nullable(),
            unavailable: z.boolean(),
          })
          .passthrough(),
        ai: z
          .object({
            basis: z.string(),
            share: z.number().nullable(),
            unavailable: z.boolean(),
            /** What the engines actually said. Quoted, never scored. */
            answer: z.string().nullable(),
          })
          .passthrough(),
        summary: z.string(),
        comparable: z.literal(false),
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

    if (args.dry_run !== false) {
      const estimate =
        args.webOnly === true
          ? CREDITS_WEB_SIDE
          : CREDITS_WEB_SIDE + CREDITS_AI_SIDE;
      return mcpResponse({
        text: [
          `Dry run: comparing sentiment for "${args.keyword}" costs approximately ${estimate} credits${
            args.webOnly === true
              ? ` (web side only, ~${CREDITS_WEB_SIDE})`
              : ` — ~${CREDITS_WEB_SIDE} for the open web and ~${CREDITS_AI_SIDE} for the SERP post plus the AI read`
          }. Charged amount is what DataForSEO reports at send time.`,
          `The AI side returns prose, not a number, so this reports the web's measured share and quotes the AI — never one combined figure.`,
          `Re-run with dry_run: false to spend credits.`,
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
        structuredContent: {
          dryRun: true,
          keyword: args.keyword,
          estimatedCredits: estimate,
        },
      });
    }

    const client = createDataforseoClient(context.billing);

    // **Independently, so one failure is a missing side rather than a dead
    // call.** A partial comparison says which half we could not read; a
    // rejected handler says only that something went wrong.
    const web = await client.serp
      .contentSummary({ keyword: args.keyword, internalListLimit: 10 })
      .then((summary) => ({
        basis: summary.countBasis,
        share: summary.positiveShare,
      }))
      .catch((error: unknown) => ({
        basis: `unavailable — ${error instanceof Error ? error.message : String(error)}`,
        share: null,
      }));

    // **The two-step flow, in order.** `ai_summary` needs a task id from a
    // prior SERP POST, so the post is not optional and cannot be skipped in
    // favour of the summary — an invented id is exactly the bug this comment
    // replaced.
    const ai =
      args.webOnly === true
        ? {
            basis:
              "skipped — webOnly was set, so there is nothing to compare against.",
            share: null as number | null,
            answer: null as string | null,
          }
        : await (async () => {
            try {
              const task = await client.serp.serpTaskForSummary({
                keyword: args.keyword,
                locationCode,
                languageCode,
              });
              const answer = await client.serp.aiSummary({
                taskId: task.taskId,
                prompt: AI_QUESTION(args.keyword),
              });
              return {
                basis:
                  "What AI engines said when asked about the keyword. DataForSEO returns prose here, not a sentiment classification, so there is no figure to compare.",
                share: null as number | null,
                answer: answer.summary,
              };
            } catch (error) {
              return {
                basis: `unavailable — ${error instanceof Error ? error.message : String(error)}`,
                share: null as number | null,
                answer: null as string | null,
              };
            }
          })();

    const comparison = compareSentiment({
      keyword: args.keyword,
      webPositiveShare: web.share,
      webCounts: {},
      webBasis: web.basis,
      // **Null, and that is the honest reading.** Not zero: "no engines said
      // anything positive" is a finding, "we have no classification" is an
      // absence, and only the first would be a number here.
      aiPositiveShare: ai.share,
      aiCounts: {},
      aiBasis: ai.basis,
    });

    const lines = [comparison.summary];
    if (ai.answer !== null && ai.answer !== "") {
      lines.push("", `What AI engines said: ${ai.answer}`);
    }

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
      ),
      structuredContent: {
        keyword: comparison.keyword,
        direction: comparison.direction,
        web: comparison.web,
        ai: { ...comparison.ai, answer: ai.answer },
        summary: comparison.summary,
        comparable: false,
      },
    });
  }),
};
