import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { buildLlmTarget } from "@/server/lib/dataforseo";
import { detectTarget } from "@/shared/targetDetection";
import { buildBrandFraming } from "@/server/features/ai-search/services/brandFraming";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { metaOnlyOutputFields } from "@/server/mcp/tools/geo-shared";

/**
 * Map the provider's snake_case bucket rows to the panel's camelCase
 * shape, defaulting absent counts to null rather than 0 — a missing
 * count is a data gap, not a zero-mention bucket.
 */
function mapEntityBuckets(
  buckets:
    | Array<{
        key: string | number;
        mentions?: number | null;
        ai_search_volume?: number | null;
      }>
    | null
    | undefined,
): Array<{
  key: string | number;
  mentions: number | null;
  aiSearchVolume: number | null;
}> {
  if (!buckets) return [];
  return buckets.map((b) => ({
    key: b.key,
    mentions: b.mentions ?? null,
    aiSearchVolume: b.ai_search_volume ?? null,
  }));
}

/**
 * One labelled bucket, as the panel returns it. `.passthrough()`
 * because cached MCP clients must accept fields the schema does
 * not name — the provider's bucket rows carry more than these
 * three, and a strict object would reject a future field.
 */
const brandEntityBucketSchema = z
  .object({
    key: z.union([z.string(), z.number()]),
    mentions: z.number().nullable(),
    aiSearchVolume: z.number().nullable(),
  })
  .passthrough();

const inputSchema = {
  projectId: projectIdSchema,
  domain: z
    .string()
    .min(1)
    .max(2048)
    .describe("The brand's domain, e.g. 'acme.com'."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the credit cost without spending. Set dry_run: false to run the live query.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const geoBrandFramingTool = {
  name: "geo_brand_framing",
  config: {
    title: "How AI Frames Your Brand",
    description:
      "Returns the brand entity buckets ChatGPT assigns to a domain — the labels it files the brand under — and a positioning diagnosis. ChatGPT-only: DataForSEO returns brand entities for ChatGPT and not for Google. Charges ~100 credits per call (LLM Mentions target_metrics). `dry_run` defaults to true, so the first call previews the cost without spending; set `dry_run: false` to run.",
    inputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        platform: z.literal("chat_gpt"),
        ownBucket: brandEntityBucketSchema.nullable(),
        dominantBucket: brandEntityBucketSchema.nullable(),
        titleBuckets: z.array(brandEntityBucketSchema),
        categoryBuckets: z.array(brandEntityBucketSchema),
        totalMentions: z.number().nullable(),
        diagnosis: z.string().nullable(),
        caveat: z.string(),
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
          `Dry run: brand framing for "${args.domain}" will cost approximately 100 credits (LLM Mentions target_metrics, ChatGPT only). Charged amount is what DataForSEO reports at send time.`,
          `Re-run with dry_run: false to spend credits and fetch the brand entities.`,
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
        structuredContent: {
          dryRun: true,
          domain: args.domain,
          estimatedCredits: 100,
        },
      });
    }

    const client = createDataforseoClient(context.billing);
    const detected = detectTarget(args.domain);
    const target = buildLlmTarget({
      type: detected.type,
      value: detected.value,
      includeSubdomains: true,
    });

    // Brand-entity buckets are a `target_metrics` dimension, not a
    // field of `aggregated_metrics`'s total: the schema guarantees
    // them at `aggregated_metrics.brand_entities_title` /
    // `.brand_entities_category`. Reading them off the total — or off
    // an array index, since `target_metrics` returns one object, not
    // a list — would report an honest-looking empty, which is exactly
    // the silent failure this tool must not have.
    const response = await client.aiSearch.targetMetrics({
      target,
      platform: "chat_gpt",
      // The project's market, not a hardcoded US/en: brand entities are
      // market-specific, so a French project's framing read at 2840 would
      // be a different question than the one asked.
      locationCode: context.project.locationCode ?? 2840,
      languageCode: context.project.languageCode ?? "en",
      internalListLimit: 10,
    });

    const dimensions = response.aggregated_metrics;
    const titleBuckets = mapEntityBuckets(dimensions?.brand_entities_title);
    const categoryBuckets = mapEntityBuckets(
      dimensions?.brand_entities_category,
    );

    const framing = buildBrandFraming({
      domain: args.domain,
      title: titleBuckets,
      category: categoryBuckets,
    });

    const lines = [
      `How ChatGPT frames "${args.domain}":`,
      "",
      framing.diagnosis ?? "No brand entities found for this domain.",
      "",
    ];

    if (framing.ownBucket) {
      lines.push(
        `Your bucket: ${String(framing.ownBucket.key)} (${framing.ownBucket.mentions ?? 0} mentions)`,
      );
    }
    if (framing.dominantBucket) {
      lines.push(
        `Dominant label: ${String(framing.dominantBucket.key)} (${framing.dominantBucket.mentions ?? 0} mentions)`,
      );
    }
    if (framing.totalMentions !== null) {
      lines.push(`Total mentions across buckets: ${framing.totalMentions}`);
    }

    lines.push("", framing.caveat);

    if (framing.titleBuckets.length > 0) {
      lines.push("", "Title buckets:");
      for (const b of framing.titleBuckets) {
        lines.push(
          `  - ${String(b.key)}: ${b.mentions ?? 0} mentions${b.aiSearchVolume !== null ? `, AI volume: ${b.aiSearchVolume}` : ""}`,
        );
      }
    }
    if (framing.categoryBuckets.length > 0) {
      lines.push("", "Category buckets:");
      for (const b of framing.categoryBuckets) {
        lines.push(
          `  - ${String(b.key)}: ${b.mentions ?? 0} mentions${b.aiSearchVolume !== null ? `, AI volume: ${b.aiSearchVolume}` : ""}`,
        );
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
        platform: "chat_gpt",
        ownBucket: framing.ownBucket,
        dominantBucket: framing.dominantBucket,
        titleBuckets: framing.titleBuckets,
        categoryBuckets: framing.categoryBuckets,
        totalMentions: framing.totalMentions,
        diagnosis: framing.diagnosis,
        caveat: framing.caveat,
      },
    });
  }),
};
