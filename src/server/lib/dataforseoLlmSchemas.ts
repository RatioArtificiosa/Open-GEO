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
