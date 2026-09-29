import { z } from "zod";

/**
 * Zod schemas for DataForSEO AI Optimization endpoints.
 *
 * The DataForSEO SDK does not yet ship typed bindings for `/ai_optimization/*`,
 * so we POST raw JSON and validate the responses ourselves. All schemas use
 * `.passthrough()` to tolerate fields the API may add in future versions.
 */

// ---------------------------------------------------------------------------
// LLM Mentions — shared bits
// ---------------------------------------------------------------------------

const monthlyVolumeSchema = z
  .object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    search_volume: z.number().nullable().optional(),
  })
  .passthrough();

const mentionSourceSchema = z
  .object({
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * A page the model *retrieved* while answering.
 *
 * Structurally identical to a source, and deliberately kept as its own field
 * because the two mean different things and confusing them is the single worst
 * error this product can make:
 *
 * - `sources` are the pages the model **cited or relied on** in its final answer.
 * - `search_results` are **all** the web search outputs it retrieved while
 *   looking things up, **including duplicates and unused entries**.
 *
 * So `search_results` is a superset, and the difference between the two is
 * exactly the retrieved-but-uncited gap this product is built to measure.
 * Populating retrievals from `sources` would make that gap permanently empty.
 *
 * Documented as chat_gpt-only: DataForSEO returns `null` for google.
 */
const searchResultSchema = z
  .object({
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
  })
  .passthrough();

const brandEntitySchema = z
  .object({
    title: z.string().nullable().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// LLM Mentions Search — `/v3/ai_optimization/llm_mentions/search_mentions/live`
// Returns one row per LLM answer that matched the target.
// ---------------------------------------------------------------------------

export const llmMentionItemSchema = z
  .object({
    question: z.string().nullable().optional(),
    sources: z.array(mentionSourceSchema).nullable().optional(),
    search_results: z.array(searchResultSchema).nullable().optional(),
    ai_search_volume: z.number().nullable().optional(),
    monthly_searches: z.array(monthlyVolumeSchema).nullable().optional(),
    first_response_at: z.string().nullable().optional(),
    last_response_at: z.string().nullable().optional(),
    brand_entities: z.array(brandEntitySchema).nullable().optional(),
  })
  .passthrough();

export type LlmMentionItem = z.infer<typeof llmMentionItemSchema>;

// ---------------------------------------------------------------------------
// LLM Mentions Aggregated Metrics — `/v3/ai_optimization/llm_mentions/aggregated_metrics/live`
// Each metric category contains an array of group elements with mention counts.
// ---------------------------------------------------------------------------

const groupElementSchema = z
  .object({
    type: z.string().nullable().optional(),
    key: z.string().nullable().optional(),
    mentions: z.number().nullable().optional(),
    ai_search_volume: z.number().nullable().optional(),
    impressions: z.number().nullable().optional(),
  })
  .passthrough();

export const llmAggregatedTotalSchema = z
  .object({
    platform: z.array(groupElementSchema).nullable().optional(),
  })
  .passthrough();

export type LlmAggregatedTotal = z.infer<typeof llmAggregatedTotalSchema>;

// ---------------------------------------------------------------------------
// LLM Mentions Top Pages — `/v3/ai_optimization/llm_mentions/top_pages/live`
// Each item has `key` = page URL plus the same group-element arrays.
// ---------------------------------------------------------------------------

export const llmTopPagesItemSchema = z
  .object({
    key: z.string().nullable().optional(),
    platform: z.array(groupElementSchema).nullable().optional(),
  })
  .passthrough();

export type LlmTopPagesItem = z.infer<typeof llmTopPagesItemSchema>;

// ---------------------------------------------------------------------------
// LLM Mentions Cross-Aggregated Metrics — `/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live`
// One item per requested aggregation group (target + competitors).
// `.passthrough()` because the real item also carries location, language,
// sources_domain, and brand_entities arrays we intentionally ignore.
// ---------------------------------------------------------------------------

export const llmCrossAggregatedItemSchema = z
  .object({
    // The shared SDK type AiOptimizationLlmMentionssLiveItem documents `key` as
    // the URL of a found page, but for cross_aggregated `key` is the request
    // aggregation_key (the brand label).
    key: z.string().nullable().optional(),
    platform: z.array(groupElementSchema).nullable().optional(),
  })
  .passthrough();

export type LlmCrossAggregatedItem = z.infer<
  typeof llmCrossAggregatedItemSchema
>;

// ---------------------------------------------------------------------------
// LLM Mentions — aggregation and time-series shapes
//
// These four endpoints were documented AFTER the code that first read this
// family, and two of their documented defaults are self-contradictory. Each
// note below is a claim the docs make, verified 2026-09-28, and each one is
// enforced in `dataforseo/ai.ts` rather than left to the caller.
// ---------------------------------------------------------------------------

/**
 * One `aggregated_metrics` dimension bucket: `[{ key, mentions, ai_search_volume }]`.
 *
 * `key` is typed `number | string` on purpose. The reference tables document it
 * as an integer, but the example JSON in `top_mentioned_domains` and
 * `top_mentioned_pages` serialises the *same* field as the string `"2840"`,
 * while `target_metrics` emits the number `2840`. Typing it as either one is a
 * lie that becomes a runtime bug on whichever endpoint we did not test.
 */
const dimensionBucketSchema = z
  .object({
    key: z.union([z.string(), z.number()]),
    mentions: z.number().nullable().optional(),
    ai_search_volume: z.number().nullable().optional(),
  })
  .passthrough();

/**
 * The dimensional breakdown for one target.
 *
 * Every array is nullable because DataForSEO omits or nulls the ones that do
 * not apply. Three of them — `search_results_domain`, `brand_entities_title`,
 * `brand_entities_category` — are **chat_gpt only** and come back empty or
 * absent for google, so a consumer must not read them as "zero mentions".
 */
const aggregatedDimensionsSchema = z
  .object({
    location: z.array(dimensionBucketSchema).nullable().optional(),
    language: z.array(dimensionBucketSchema).nullable().optional(),
    platform: z.array(dimensionBucketSchema).nullable().optional(),
    sources_domain: z.array(dimensionBucketSchema).nullable().optional(),
    search_results_domain: z.array(dimensionBucketSchema).nullable().optional(),
    brand_entities_title: z.array(dimensionBucketSchema).nullable().optional(),
    brand_entities_category: z
      .array(dimensionBucketSchema)
      .nullable()
      .optional(),
    total: llmAggregatedTotalSchema.nullable().optional(),
  })
  .passthrough();

/**
 * `target_metrics` result element.
 *
 * `total_count`, `offset` and `items_count` are documented as always 0 and
 * `items` as always empty on this endpoint — all the data is in
 * `aggregated_metrics`. Modelled anyway so a future vendor change surfaces as
 * new data rather than as a parse failure.
 */
export const llmTargetMetricsSchema = z
  .object({
    total_count: z.number().nullable().optional(),
    offset: z.number().nullable().optional(),
    items_count: z.number().nullable().optional(),
    aggregated_metrics: aggregatedDimensionsSchema.nullable().optional(),
    items: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

export type LlmTargetMetrics = z.infer<typeof llmTargetMetricsSchema>;

/**
 * One month of the `historical` series.
 *
 * Monthly only — the endpoint has no `group_range`, so a daily reading is not
 * available from it. `year`/`month` rather than a date string, because the
 * vendor sends two integers and coercing them into a Date would invent a
 * timezone.
 */
export const llmHistoricalItemSchema = z
  .object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    metrics: z
      .object({
        mentions: z.number().nullable().optional(),
        ai_search_volume: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type LlmHistoricalItem = z.infer<typeof llmHistoricalItemSchema>;

/**
 * One bucket of `timeseries_new_lost`.
 *
 * The four counters are separate on purpose: new *mentions* and new *AI search
 * volume* move independently, and collapsing them into one "change" number
 * would hide which one actually moved.
 */
export const llmNewLostItemSchema = z
  .object({
    date: z.string(),
    new_mentions: z.number().nullable().optional(),
    lost_mentions: z.number().nullable().optional(),
    new_ai_search_volume: z.number().nullable().optional(),
    lost_ai_search_volume: z.number().nullable().optional(),
  })
  .passthrough();

export type LlmNewLostItem = z.infer<typeof llmNewLostItemSchema>;

/**
 * A `top_mentioned_domains` or `top_mentioned_pages` item.
 *
 * The two endpoints differ only in the key field's name (`domain` vs `page`),
 * so one schema covers both and the caller picks which field it asked for. The
 * page URLs arrive with tracking query strings attached
 * (`?utm_source=chatgpt.com`), which is why `page` is stored raw and normalised
 * at the point of display rather than on the way in.
 */
export const llmTopMentionedItemSchema = z
  .object({
    domain: z.string().nullable().optional(),
    page: z.string().nullable().optional(),
    location: z.array(dimensionBucketSchema).nullable().optional(),
    language: z.array(dimensionBucketSchema).nullable().optional(),
    platform: z.array(dimensionBucketSchema).nullable().optional(),
    sources_domain: z.array(dimensionBucketSchema).nullable().optional(),
    search_results_domain: z.array(dimensionBucketSchema).nullable().optional(),
    brand_entities_title: z.array(dimensionBucketSchema).nullable().optional(),
    brand_entities_category: z
      .array(dimensionBucketSchema)
      .nullable()
      .optional(),
    total: llmAggregatedTotalSchema.nullable().optional(),
  })
  .passthrough();

export type LlmTopMentionedItem = z.infer<typeof llmTopMentionedItemSchema>;

// ---------------------------------------------------------------------------
// LLM Responses — shared between ChatGPT/Claude/Gemini/Perplexity
// All four model endpoints return the same envelope shape.
// ---------------------------------------------------------------------------

const responseAnnotationSchema = z
  .object({
    type: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

const responseSectionSchema = z
  .object({
    type: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    annotations: z.array(responseAnnotationSchema).nullable().optional(),
  })
  .passthrough();

const responseItemSchema = z
  .object({
    type: z.string().nullable().optional(),
    sections: z.array(responseSectionSchema).nullable().optional(),
  })
  .passthrough();

export const llmResponseResultSchema = z
  .object({
    model_name: z.string().nullable().optional(),
    output_tokens: z.number().nullable().optional(),
    web_search: z.boolean().nullable().optional(),
    items: z.array(responseItemSchema).nullable().optional(),
    fan_out_queries: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export type LlmResponseResult = z.infer<typeof llmResponseResultSchema>;
