import { z } from "zod";
import {
  llmHistoricalItemSchema,
  llmNewLostItemSchema,
  llmTargetMetricsSchema,
  llmTopMentionedItemSchema,
  type LlmHistoricalItem,
  type LlmNewLostItem,
  type LlmTargetMetrics,
  type LlmTopMentionedItem,
} from "@/server/lib/dataforseoLlmSchemas";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { AppError } from "@/server/lib/errors";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import type { LlmPlatform, LlmTarget } from "@/server/lib/dataforseo/shared";
import {
  assertOk,
  buildTaskBilling,
  isRecord,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";

/**
 * The aggregation and time-series half of the `llm_mentions` family.
 *
 * Split out of `ai.ts` because these four endpoints have one thing in common
 * that the rest of the module does not: **every one of them returns aggregates
 * rather than rows**, and every one of them has a documented default that is
 * either contradictory or different from its siblings. Those notes live with
 * the code that acts on them, not in a shared file nobody re-reads.
 *
 * All four are **Live-only** with no `task_get`, so there is nothing to poll and
 * a missing result means "empty", not "still running". See
 * `docs/DATAFORSEO_GOTCHAS.md` §6.2.
 *
 * Verified against the live docs on 2026-09-28.
 */

const classifyAiSearchError = createDataforseoBillingClassifier({
  pathPrefix: "/ai_optimization/",
  billingIssueCode: "AI_SEARCH_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

const assertOptions = (path: string) =>
  ({ classify: classifyAiSearchError, classifyPath: path }) as const;

function clampLimit(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function firstResult(task: DataforseoTaskLike): Record<string, unknown> | null {
  const first = task.result?.[0];
  return isRecord(first) ? first : null;
}

/** The earliest month DataForSEO holds mentions history for. */
export const LLM_MENTIONS_HISTORY_FLOOR = "2025-08-01" as const;

const llmMentionsBase = "/v3/ai_optimization/llm_mentions" as const;

/**
 * The caller's view of the shared request fields, before they are translated to
 * vendor field names. Named separately from the wire shape so the translation
 * happens in exactly one place.
 */
type LlmMentionsQuery = {
  target: LlmTarget;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
};

/**
 * Build the request body, always sending `platform` explicitly.
 *
 * `multi_target_metrics` and `timeseries_new_lost` both document `platform` as
 * `default value: google` *and* say "if the platform is not specified, the data
 * is returned for both platforms". Those cannot both be true, and the ambiguity
 * is exactly the kind that produces one number blended from two different demand
 * models. Making `platform` required means no caller can accidentally get one.
 */
function llmMentionsRequest(
  input: LlmMentionsQuery,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    target: [input.target],
    platform: input.platform,
    location_code: input.locationCode,
    language_code: input.languageCode,
    ...extra,
  };
}

/** Parse a `result[0].items` array, or fail loudly rather than return empty. */
function parseItems<T>(
  task: DataforseoTaskLike,
  schema: z.ZodType<T>,
  message: string,
): T[] {
  const items = z.array(schema).safeParse(firstResult(task)?.items ?? []);
  if (!items.success) {
    // An empty list and a parse failure look identical to every consumer, and
    // one of them means "this brand has no mentions" — the wrong conclusion to
    // draw silently.
    throw new AppError("INTERNAL_ERROR", message);
  }
  return items.data;
}

/**
 * `target_metrics` — the dimensional breakdown for one target.
 *
 * All the data is in `aggregated_metrics`; `items` is documented as always empty
 * and the three counters as always 0. There is no `limit`/`offset` here, so
 * there is nothing to page through.
 */
export async function fetchLlmTargetMetrics(
  input: LlmMentionsQuery & { internalListLimit?: number },
): Promise<DataforseoApiResponse<LlmTargetMetrics>> {
  const path = `${llmMentionsBase}/target_metrics/live`;
  const response = await dataforseoPost(
    path,
    [
      llmMentionsRequest(input, {
        // Documented default is 10 here, but 5 on the other three endpoints.
        // Sent explicitly so the number is ours rather than a default that
        // could differ per endpoint.
        internal_list_limit: clampLimit(input.internalListLimit ?? 10, 1, 10),
      }),
    ],
    { classify: classifyAiSearchError },
  );
  const task = assertOk(response, assertOptions(path));

  const result = llmTargetMetricsSchema.safeParse(firstResult(task) ?? {});
  if (!result.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO llm_mentions/target_metrics returned an invalid shape",
    );
  }
  return { data: result.data, billing: buildTaskBilling(task) };
}

/**
 * `historical` — monthly mentions and demand for one target.
 *
 * Monthly only, and this endpoint has no `group_range`, so a daily reading is
 * not available from it. History starts at `LLM_MENTIONS_HISTORY_FLOOR`
 * (2025-08-01) and the reference example returns one month *before* that with
 * zero metrics, so a caller must not treat the presence of a month as the
 * presence of data.
 */
export async function fetchLlmHistorical(
  input: LlmMentionsQuery & { dateFrom?: string; dateTo?: string },
): Promise<DataforseoApiResponse<LlmHistoricalItem[]>> {
  const path = `${llmMentionsBase}/historical/live`;
  const response = await dataforseoPost(
    path,
    [
      llmMentionsRequest(input, {
        // `date_from` / `date_to`, not `start_date` / `end_date`. Both of
        // those are plausible guesses, and a wrong one is a billable
        // 40501 "Invalid Field" rejection rather than a free mistake.
        ...(input.dateFrom ? { date_from: input.dateFrom } : {}),
        ...(input.dateTo ? { date_to: input.dateTo } : {}),
      }),
    ],
    { classify: classifyAiSearchError },
  );
  const task = assertOk(response, assertOptions(path));

  return {
    data: parseItems(
      task,
      llmHistoricalItemSchema,
      "DataForSEO llm_mentions/historical returned an invalid items shape",
    ),
    billing: buildTaskBilling(task),
  };
}

/**
 * `timeseries_new_lost` — what appeared and what disappeared, bucketed.
 *
 * Unlike `historical`, all three date/group parameters are **required** here, so
 * they are required in the signature: a caller asking "new and lost since
 * when?" with no answer would otherwise silently get the vendor's default
 * window, which is not a window anyone chose.
 */
export async function fetchLlmNewLost(
  input: LlmMentionsQuery & {
    dateFrom: string;
    dateTo: string;
    groupRange: "day" | "week" | "month" | "year";
  },
): Promise<DataforseoApiResponse<LlmNewLostItem[]>> {
  const path = `${llmMentionsBase}/timeseries_new_lost/live`;
  const response = await dataforseoPost(
    path,
    [
      llmMentionsRequest(input, {
        date_from: input.dateFrom,
        date_to: input.dateTo,
        group_range: input.groupRange,
      }),
    ],
    { classify: classifyAiSearchError },
  );
  const task = assertOk(response, assertOptions(path));

  return {
    data: parseItems(
      task,
      llmNewLostItemSchema,
      "DataForSEO llm_mentions/timeseries_new_lost returned an invalid items shape",
    ),
    billing: buildTaskBilling(task),
  };
}

const TOP_MENTIONED_ENDPOINTS = {
  domains: "top_mentioned_domains",
  pages: "top_mentioned_pages",
} as const;

/** Which citation ranking to fetch. */
type TopMentionedKind = keyof typeof TOP_MENTIONED_ENDPOINTS;

/**
 * `top_mentioned_domains` / `top_mentioned_pages` — what the models cite.
 *
 * `links_scope` defaults to `sources` (what was cited) and its alternative,
 * `search_results` (what was retrieved), is **chat_gpt only**. It is a parameter
 * rather than a hard constant so the "retrieved but not cited" ranking is
 * reachable later — the same distinction the answer-level gap is built on.
 */
export async function fetchLlmTopMentioned(
  input: LlmMentionsQuery & {
    kind: TopMentionedKind;
    limit?: number;
    offset?: number;
    linksScope?: "sources" | "search_results";
    orderBy?: string[];
  },
): Promise<DataforseoApiResponse<LlmTopMentionedItem[]>> {
  const endpoint = TOP_MENTIONED_ENDPOINTS[input.kind];
  const path = `${llmMentionsBase}/${endpoint}/live`;
  const response = await dataforseoPost(
    path,
    [
      llmMentionsRequest(input, {
        links_scope: input.linksScope ?? "sources",
        limit: clampLimit(input.limit ?? 100, 1, 1000),
        ...(input.offset
          ? { offset: clampLimit(input.offset, 0, 1_000_000) }
          : {}),
        ...(input.orderBy ? { order_by: input.orderBy } : {}),
        // Documented default is 5 on both top_mentioned endpoints.
        internal_list_limit: 5,
      }),
    ],
    { classify: classifyAiSearchError },
  );
  const task = assertOk(response, assertOptions(path));

  return {
    data: parseItems(
      task,
      llmTopMentionedItemSchema,
      `DataForSEO ${endpoint} returned an invalid items shape`,
    ),
    billing: buildTaskBilling(task),
  };
}
