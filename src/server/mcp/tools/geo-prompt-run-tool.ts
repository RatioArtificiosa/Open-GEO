import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { resolveLlmModel } from "@/server/lib/dataforseo/llm-models";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { metaOnlyOutputFields } from "@/server/mcp/tools/geo-shared";

function getCitationTitle(cite: unknown): string {
  if (cite && typeof cite === "object" && "title" in cite) {
    const title = (cite as Record<string, unknown>).title;
    return typeof title === "string" ? title : "";
  }
  return "";
}

function getCitationUrl(cite: unknown): string {
  if (cite && typeof cite === "object" && "url" in cite) {
    const url = (cite as Record<string, unknown>).url;
    return typeof url === "string" ? url : "";
  }
  return "";
}

const PLATFORMS = ["chat_gpt", "claude", "gemini", "perplexity"] as const;

const inputSchema = {
  projectId: projectIdSchema,
  prompt: z
    .string()
    .min(1)
    .max(500)
    .describe("The prompt to send to the AI model."),
  platform: z.enum(PLATFORMS).describe("Which AI platform to query."),
  modelName: z.string().describe("Specific model name to use for this prompt."),
  webSearch: z
    .boolean()
    .optional()
    .describe(
      "Enable web search for the model. Defaults to true when the model supports it.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the credit cost without spending. Set dry_run: false to run the live query.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const geoPromptRunTool = {
  name: "geo_prompt_run",
  config: {
    title: "Run a Prompt Against an AI Model",
    description:
      "Sends a prompt to a specific AI model and returns the answer with citations. Charges a $0.0006 base fee per prompt response plus the model's own token cost (varies by model, tokens and web search). `dry_run` defaults to true, so the first call previews the cost without spending; set `dry_run: false` to run. Use this to test how an AI model answers a specific question about a brand before adding it to a prompt set.",
    inputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        platform: z.enum(PLATFORMS),
        model: z.string(),
        answer: z.string(),
        citations: z
          .array(
            z
              .object({
                url: z.string(),
                title: z.string().nullable(),
                text: z.string().nullable(),
              })
              .passthrough(),
          )
          .nullable(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    if (args.dry_run !== false) {
      return mcpResponse({
        text: [
          `Dry run: running "${args.prompt.slice(0, 80)}${args.prompt.length > 80 ? "..." : ""}" against ${args.platform} costs a $0.0006 base fee (0.6 credits) plus the model's own token cost, which varies by model, tokens and web search. Charged amount is what DataForSEO reports at send time.`,
          `Re-run with dry_run: false to spend credits and fetch the answer.`,
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
        structuredContent: {
          dryRun: true,
          platform: args.platform,
          prompt: args.prompt,
          estimatedCredits: 0.6,
        },
      });
    }

    const model = await resolveLlmModel(args.platform, args.modelName);
    // Through the metered client, not the raw fetcher: a prompt response
    // costs a base fee plus the model's own tokens, so the balance check
    // and the usage record have to run. The client unwraps `.data`.
    const client = createDataforseoClient(context.billing);
    const result = await client.aiSearch.llmResponse({
      userPrompt: args.prompt,
      modelSlug: args.platform,
      modelName: model.modelName,
      webSearch: args.webSearch,
    });

    const lines = [
      `Response from ${args.platform} (${model.modelName}):`,
      "",
      result.answer,
    ];

    const rawCitations = result.citations;
    const citations = Array.isArray(rawCitations) ? rawCitations : undefined;
    if (citations && citations.length > 0) {
      lines.push("", `Citations (${citations.length}):`);
      for (const cite of citations) {
        const title = getCitationTitle(cite);
        const url = getCitationUrl(cite);
        lines.push(`  - ${title || url}${title ? ` (${url})` : ""}`);
      }
    }

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
      ),
      structuredContent: {
        platform: args.platform,
        model: model.modelName,
        answer: result.answer,
        citations: result.citations ?? null,
      },
    });
  }),
};
