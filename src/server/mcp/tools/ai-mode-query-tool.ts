import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { metaOnlyOutputFields } from "@/server/mcp/tools/geo-shared";

const inputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .min(1)
    .max(700)
    .describe("The keyword to query in Google AI Mode."),
  locationCode: z
    .number()
    .int()
    .optional()
    .describe(
      "DataForSEO location code. Defaults to the project's market (2840 = US).",
    ),
  languageCode: z
    .string()
    .optional()
    .describe("DataForSEO language code. Defaults to the project's language."),
  device: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe("Device type. Defaults to desktop."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the credit cost without spending. Set dry_run: false to run the live query.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const aiModeQueryTool = {
  name: "ai_mode_query",
  config: {
    title: "Query Google AI Mode",
    description:
      "Returns the Google AI Mode SERP for a keyword: answer elements (prose, tables, shopping), references/citations, and a reproducible check URL. Charges ~4 credits per call (vendor list price, live/advanced variant). `dry_run` defaults to true, so the first call previews the cost without spending; set `dry_run: false` to run. Scope limit: this tool reports what Google AI Mode cited, not what it retrieved behind the answer — DataForSEO returns no retrieval list for this endpoint, so there is no retrieved-but-uncited gap here.",
    inputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        keyword: z.string(),
        locationCode: z.number(),
        languageCode: z.string(),
        datetime: z.string().nullable(),
        checkUrl: z.string().nullable(),
        elementTypes: z.array(z.string()),
        elements: z
          .array(
            z
              .object({
                type: z.string(),
                position: z.string().nullable(),
                title: z.string().nullable(),
                text: z.string().nullable(),
                markdown: z.string().nullable(),
                references: z
                  .array(
                    z
                      .object({
                        type: z.string().nullable(),
                        source: z.string().nullable(),
                        domain: z.string().nullable(),
                        url: z.string().nullable(),
                        title: z.string().nullable(),
                        text: z.string().nullable(),
                      })
                      .passthrough(),
                  )
                  .nullable(),
              })
              .passthrough(),
          )
          .nullable(),
        references: z.array(
          z
            .object({
              type: z.string().nullable(),
              source: z.string().nullable(),
              domain: z.string().nullable(),
              url: z.string().nullable(),
              title: z.string().nullable(),
              text: z.string().nullable(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const locationCode =
      args.locationCode ?? context.project.locationCode ?? 2840;
    const languageCode =
      args.languageCode ?? context.project.languageCode ?? "en";

    if (args.dry_run !== false) {
      return mcpResponse({
        text: [
          `Dry run: AI Mode query for "${args.keyword}" will cost approximately 4 credits (vendor list price, live/advanced variant). Charged amount is what DataForSEO reports at send time.`,
          `Re-run with dry_run: false to spend credits and fetch the answer.`,
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
          estimatedCredits: 4,
        },
      });
    }

    // Through the metered client, not the raw fetcher: this spends vendor
    // credits, so the balance check and the usage record have to run. The
    // client unwraps `.data`, so the answer is used directly.
    const client = createDataforseoClient(context.billing);
    const answer = await client.serp.aiMode({
      keyword: args.keyword,
      locationCode,
      languageCode,
      ...(args.device ? { device: args.device } : {}),
    });
    const lines = [
      `Google AI Mode answer for "${answer.keyword}" (location: ${answer.locationCode}, language: ${answer.languageCode}):`,
    ];

    if (answer.datetime) {
      lines.push(`- captured: ${answer.datetime}`);
    }
    if (answer.checkUrl) {
      lines.push(`- check URL: ${answer.checkUrl}`);
    }
    if (answer.elementTypes.length > 0) {
      lines.push(`- element types: ${answer.elementTypes.join(", ")}`);
    }

    for (const element of answer.elements) {
      const title = element.title ? ` — ${element.title}` : "";
      lines.push(`\n[${element.type}${title}]`);
      const body = element.markdown ?? element.text;
      if (body) {
        lines.push(body);
      }
      const refs = element.references ?? [];
      if (refs.length > 0) {
        lines.push(`  references:`);
        for (const ref of refs) {
          const label = ref.title ?? ref.domain ?? ref.url ?? "unknown";
          lines.push(`    - ${label}${ref.url ? ` (${ref.url})` : ""}`);
        }
      }
    }

    if (answer.references.length > 0) {
      lines.push(`\n- total citations: ${answer.references.length}`);
    }

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
      ),
      structuredContent: {
        keyword: answer.keyword,
        locationCode: answer.locationCode,
        languageCode: answer.languageCode,
        datetime: answer.datetime,
        checkUrl: answer.checkUrl,
        elementTypes: answer.elementTypes,
        elements: answer.elements,
        references: answer.references,
      },
    });
  }),
};
