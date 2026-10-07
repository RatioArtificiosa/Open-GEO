import { z } from "zod";

import { AppError } from "@/server/lib/errors";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  isRecord,
  isTaskInProgress,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import type { LlmModelSlug } from "@/server/lib/dataforseo/llm-models";

/**
 * LLM Scraper — authentic ChatGPT Search and Gemini answers, scraped rather than generated.
 *
 * The 400-line budget in this directory is a shape signal, not a brevity request: it is why this
 * file exists separately from `ai.ts` (LLM Mentions + Responses) rather than joining it.
 *
 * The asynchronous queues (`standard`, `priority`) require a billed `task_post` followed by a
 * `task_get`, because processing is measured in minutes. The price book also carries an
 * `llmScraper.live` row, but **there is no `live` route** - the sandbox answers 404 for it, and a
 * price row is not a route - so nothing here sends to one. The price gap between the queues is
 * real and deliberate, so the queue is an argument the caller must state rather than a default this
 * module picks for them.
 */

const classifyLlmScraperError = createDataforseoBillingClassifier({
  pathPrefix: "/ai_optimization/",
  billingIssueCode: "AI_SEARCH_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

const scraperBase = (se: LlmModelSlug) =>
  `/v3/ai_optimization/${se}/llm_scraper`;

const assertOptions = (path: string) =>
  ({ classify: classifyLlmScraperError, classifyPath: path }) as const;

function firstResult(task: DataforseoTaskLike): Record<string, unknown> | null {
  const first = task.result?.[0];
  return isRecord(first) ? first : null;
}

/** One query for the scraper to run. `keyword` and `location_code` are the caller's contract. */
export const llmScraperTaskSchema = z.object({
  keyword: z.string().min(1),
  location_code: z.number().optional(),
  language_code: z.string().optional(),
  /** The prompt sent to the search surface. Capped by the vendor - never send more than 500. */
  user_prompt: z.string().max(500).optional(),
  device: z.enum(["desktop", "mobile"]).optional(),
});

type LlmScraperTaskInput = z.infer<typeof llmScraperTaskSchema>;

const postedTaskSchema = z.object({
  id: z.string(),
  status_code: z.number().optional(),
  cost: z.number().optional(),
  tag: z.string().nullish(),
});

/**
 * Submit scraper tasks. The POST is billed, so `NO_RETRY_BILLED_POST` is mandatory here - without
 * it a 5xx would be retried and the account charged twice for one answer. `billed-tasks-gate`
 * fails the build if any `/task_post` call site omits it.
 */
export async function postLlmScraperTasks(input: {
  se: LlmModelSlug;
  tasks: LlmScraperTaskInput[];
}): Promise<
  DataforseoApiResponse<{ taskId: string; tag: string | null; costUsd: number }>
> {
  if (input.tasks.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "postLlmScraperTasks needs at least one task; an empty batch would still be billed",
    );
  }

  const path = `${scraperBase(input.se)}/task_post`;
  const response = await dataforseoPost(path, input.tasks, {
    ...NO_RETRY_BILLED_POST,
    classify: classifyLlmScraperError,
  });
  const task = assertOk(response, assertOptions(path));

  const posted = postedTaskSchema.safeParse(firstResult(task) ?? {});
  if (!posted.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO llm_scraper/task_post returned an invalid shape",
    );
  }

  return {
    data: {
      taskId: posted.data.id,
      tag: posted.data.tag ?? null,
      costUsd: posted.data.cost ?? 0,
    },
    billing: buildTaskBilling(task),
  };
}

/**
 * Collect one finished task. A pending task legitimately carries no cost, so this reports `null`
 * rather than zero for it: zero means "free", and a pending task is not that.
 */
export async function getLlmScraperTask(
  se: LlmModelSlug,
  taskId: string,
): Promise<
  | { status: "pending" }
  | { status: "completed"; result: unknown; costUsd: number; path: string[] }
> {
  const path = `${scraperBase(se)}/task_get/${encodeURIComponent(taskId)}`;
  const response = await dataforseoGet(path, assertOptions(path));

  // A pending task is not an error, so the in-progress check must come before `assertOk` — which
  // would otherwise throw on a status code that legitimately is not 20000.
  const rawTask = response?.tasks?.[0];
  if (rawTask && isTaskInProgress(rawTask)) {
    return { status: "pending" };
  }

  const task = assertOk(response, assertOptions(path));
  const billing = buildTaskBilling(task);
  return {
    status: "completed",
    result: firstResult(task),
    costUsd: billing.costUsd,
    path: billing.path,
  };
}
