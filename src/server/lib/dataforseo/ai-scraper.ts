import { z } from "zod";

import { AppError } from "@/server/lib/errors";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
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

/**
 * One query for the scraper to run. `user_prompt` is capped by the vendor at 500 characters, and
 * this schema is **enforced on the way out** rather than merely documented: an over-long prompt is
 * refused, never silently truncated into a different question than the caller asked.
 */
export const llmScraperTaskSchema = z.object({
  keyword: z.string().min(1),
  location_code: z.number().optional(),
  language_code: z.string().optional(),
  user_prompt: z.string().max(500).optional(),
  device: z.enum(["desktop", "mobile"]).optional(),
  // Declared so zod does not strip them. Without this a caller's tag is dropped before submission,
  // and the tag is how `tasks_ready` and the collection side correlate a batch with the request that
  // bought it - so losing it strands answers that were paid for. `priority` selects the queue and is
  // deliberately typed without invented bounds: the vendor's constraint is not something this file
  // has verified, and guessing one would refuse valid work.
  tag: z.string().optional(),
  priority: z.number().int().optional(),
});

type LlmScraperTaskInput = z.infer<typeof llmScraperTaskSchema>;

/**
 * Submit scraper tasks. The POST is billed, so `NO_RETRY_BILLED_POST` is mandatory here - without
 * it a 5xx would be retried and the account charged twice for one answer. `billed-tasks-gate`
 * fails the build if any `/task_post` call site omits it.
 *
 * **The task id is `task.id` and the tag is `task.data.tag`** — not fields of `result[0]`, which is
 * how this was first written, and why it would have thrown on every real response. The sibling
 * `llm-responses-queue.ts` reads both the same way; that file is the reference for this shape.
 *
 * Every task is validated **before** the request: validating after a billed POST is a charge for a
 * call that was never going to be accepted. The vendor prices per task, so the cost reported here
 * is the **sum** across the batch, and every id is returned — losing an id would strand an answer
 * already paid for.
 */
export async function postLlmScraperTasks(input: {
  se: LlmModelSlug;
  tasks: LlmScraperTaskInput[];
}): Promise<
  DataforseoApiResponse<{ taskIds: string[]; tags: string[]; costUsd: number }>
> {
  if (input.tasks.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "postLlmScraperTasks needs at least one task; an empty batch would still be billed",
    );
  }

  const tasks = input.tasks.map((task) => {
    const parsed = llmScraperTaskSchema.safeParse(task);
    if (!parsed.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "postLlmScraperTasks refused a task before sending it, so nothing was billed",
      );
    }
    return parsed.data;
  });

  const path = `${scraperBase(input.se)}/task_post`;
  const response = await dataforseoPost(path, tasks, {
    ...NO_RETRY_BILLED_POST,
    classify: classifyLlmScraperError,
  });
  assertOk(response, assertOptions(path));

  const taskIds: string[] = [];
  const tags: string[] = [];
  let costUsd = 0;
  const responseTasks = response?.tasks ?? [];
  for (const task of responseTasks) {
    costUsd += task.cost ?? 0;
    if (typeof task.id !== "string") {
      continue;
    }
    taskIds.push(task.id);
    tags.push(
      isRecord(task.data) && typeof task.data.tag === "string"
        ? task.data.tag
        : "",
    );
  }

  // Every task must yield an id. Checking only for *zero* ids would let a partial answer through:
  // a batch of five returning three ids would collect three answers and strand two the account had
  // already paid for, with nothing to say so. A shortfall is as much a failure as an empty one.
  if (taskIds.length !== responseTasks.length) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO llm_scraper/task_post returned " +
        responseTasks.length +
        " tasks but only " +
        taskIds.length +
        " ids, so an answer already paid for could not be collected",
    );
  }

  return {
    data: { taskIds, tags, costUsd },
    billing: { path: [path], costUsd },
  };
}

/** The outcome of collecting one task. `pending` carries no cost, because nothing is final yet. */
type LlmScraperTaskOutcome =
  | { status: "pending" }
  | { status: "completed"; result: unknown; costUsd: number; path: string[] };

/**
 * Collect one finished task. A pending task is not an error, so the in-progress check must come
 * **before** `assertOk` — which would otherwise throw on a status code that legitimately is not
 * 20000. Reporting `pending` without a cost is deliberate: zero means "free", and a task still
 * being processed is not free, it is unfinished.
 */
export async function getLlmScraperTask(
  se: LlmModelSlug,
  taskId: string,
): Promise<LlmScraperTaskOutcome> {
  const path = `${scraperBase(se)}/task_get/advanced/${encodeURIComponent(taskId)}`;
  const response = await dataforseoGet(path, assertOptions(path));

  const rawTask = response?.tasks?.[0];
  if (rawTask && isTaskInProgress(rawTask)) {
    return { status: "pending" };
  }

  const task = assertOk(response, assertOptions(path));
  const costUsd = typeof task.cost === "number" ? task.cost : 0;
  const resultPath = Array.isArray(task.path) ? task.path.map(String) : [path];
  return {
    status: "completed",
    result: firstResult(task),
    costUsd,
    path: resultPath,
  };
}
